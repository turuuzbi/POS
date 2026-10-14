import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { setFiscalProviderForTests } from "@/server/adapters/fiscal";
import type { FiscalProvider, FiscalSaleRequest } from "@/server/adapters/fiscal/types";
import { createMockEbarimtProvider } from "@/server/adapters/fiscal/mock-ebarimt";
import { checkoutSale } from "@/server/services/checkout";
import {
  FISCAL_CLAIM_TIMEOUT_MS,
  reconcileFiscalReceipts,
  retryFiscalReceipt,
  runPostSale,
} from "@/server/services/post-sale";
import { db, resetDatabase } from "../support/db";
import { buildInput, createStockedProduct, createTill, lineOf } from "../support/checkout-fixtures";

/** A provider that records every issue() call (with the idempotency key) and is slow. */
function countingProvider(delayMs = 60) {
  const inner = createMockEbarimtProvider();
  const calls: FiscalSaleRequest[] = [];
  const provider: FiscalProvider = {
    ...inner,
    async issue(request) {
      calls.push(request);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return inner.issue(request);
    },
  };
  return { provider, calls };
}

async function makeSale() {
  const till = await createTill();
  const { variant } = await createStockedProduct(till);
  const input = buildInput({
    lines: [lineOf(variant.id, 1000)],
    expectedPayable: "100000",
    tenders: [{ method: "CASH", amount: "100000" }],
  });
  return checkoutSale(input, till.ctx());
}

describe("fiscal receipt claim", () => {
  beforeEach(async () => {
    await resetDatabase();
    setFiscalProviderForTests(null);
  });
  afterAll(() => {
    setFiscalProviderForTests(null);
    return db.$disconnect();
  });

  it("issues exactly once when runPostSale runs in parallel (double submit)", async () => {
    const sale = await makeSale();
    const { provider, calls } = countingProvider();
    setFiscalProviderForTests(provider);
    await Promise.all(Array.from({ length: 8 }, () => runPostSale(sale.saleId)));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.saleId).toBe(sale.saleId); // the provider idempotency key
    const receipt = await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: sale.saleId } });
    expect(receipt).toMatchObject({ status: "ISSUED", attempts: 1, claimedAt: null });
    expect(await db.auditLog.count({ where: { action: "fiscal.issued" } })).toBe(1);
  });

  it("concurrent reconcile sweeps and post-sale runs issue each sale once", async () => {
    const a = await makeSale();
    const b = await makeSale();
    const { provider, calls } = countingProvider();
    setFiscalProviderForTests(provider);
    await Promise.all([
      reconcileFiscalReceipts(),
      reconcileFiscalReceipts(),
      runPostSale(a.saleId),
      runPostSale(b.saleId),
    ]);
    expect(calls.map((c) => c.saleId).sort()).toEqual([a.saleId, b.saleId].sort());
    expect(await db.fiscalReceipt.count({ where: { status: "ISSUED" } })).toBe(2);
  });

  it("a fresh ISSUING claim is left alone; a stale one is retried with the same sale id", async () => {
    const sale = await makeSale();
    const { provider, calls } = countingProvider(0);
    setFiscalProviderForTests(provider);
    const receipt = await db.fiscalReceipt.create({
      data: { provider: "mock", saleId: sale.saleId, status: "ISSUING", claimedAt: new Date() },
    });
    expect(await retryFiscalReceipt(receipt.id)).toBe("ISSUING");
    await reconcileFiscalReceipts();
    expect(calls).toHaveLength(0);

    // The runner crashed long ago: the claim expires and the sweep re-issues once.
    await db.fiscalReceipt.update({
      where: { id: receipt.id },
      data: { claimedAt: new Date(Date.now() - FISCAL_CLAIM_TIMEOUT_MS - 1000) },
    });
    await Promise.all([reconcileFiscalReceipts(), reconcileFiscalReceipts()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.saleId).toBe(sale.saleId);
    expect(await db.fiscalReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
      status: "ISSUED",
      claimedAt: null,
    });
  });

  it("a runner whose claim was taken over cannot overwrite the new owner's result", async () => {
    const sale = await makeSale();
    const inner = createMockEbarimtProvider();
    let receiptId = "";
    setFiscalProviderForTests({
      ...inner,
      async issue(_request) {
        // While we are "calling the provider", the claim goes stale and someone else takes it.
        await db.fiscalReceipt.update({
          where: { id: receiptId },
          data: { claimedAt: new Date(Date.now() - FISCAL_CLAIM_TIMEOUT_MS - 1000) },
        });
        setFiscalProviderForTests(inner);
        await retryFiscalReceipt(receiptId);
        setFiscalProviderForTests({
          ...inner,
          issue: async () => ({ externalId: "SLOW", raw: {} }),
        });
        return { externalId: "SLOW", raw: {} };
      },
    });
    receiptId = (
      await db.fiscalReceipt.create({
        data: { provider: "mock", saleId: sale.saleId, status: "PENDING" },
      })
    ).id;
    expect(await retryFiscalReceipt(receiptId)).toBe("ISSUING");
    const final = await db.fiscalReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(final.status).toBe("ISSUED");
    expect(final.externalId).toMatch(/^MOCK-/);
  });
});
