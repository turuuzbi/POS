import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createMockQpayProvider } from "@/server/adapters/payments/mock-qpay";
import { markMockInvoicePaid, setPaymentProviderForTests } from "@/server/adapters/payments";
import { setFiscalProviderForTests } from "@/server/adapters/fiscal";
import { setMessagingProviderForTests } from "@/server/adapters/messaging";
import { checkoutSale } from "@/server/services/checkout";
import {
  checkQpay,
  createQpayInvoice,
  handleQpayWebhook,
  syncPaymentIntent,
} from "@/server/services/payments";
import {
  deliverReceipt,
  reconcileFiscalReceipts,
  retryFiscalReceipt,
  runPostSale,
} from "@/server/services/post-sale";
import { openShift } from "@/server/services/shifts";
import type { ActionError } from "@/server/errors";
import { db, resetDatabase } from "../support/db";
import { buildInput, createStockedProduct, createTill, lineOf } from "../support/checkout-fixtures";

const meta = { ip: null, userAgent: null };

describe("shifts", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("opens a shift with a float, audits it, and allows only one OPEN shift per register", async () => {
    const till = await createTill({ withShift: false });
    const { user, device } = till.ctx();
    const { shiftId } = await openShift({ openingFloat: 5_000_000n }, user, device, meta);
    const shift = await db.shift.findUniqueOrThrow({ where: { id: shiftId } });
    expect(shift).toMatchObject({
      status: "OPEN",
      openingFloat: 5_000_000n,
      registerId: till.register.id,
      locationId: till.location.id,
      openedById: till.cashier.id,
    });
    expect(await db.auditLog.count({ where: { action: "shift.open", entityId: shiftId } })).toBe(1);
    await expect(openShift({ openingFloat: 0n }, user, device, meta)).rejects.toMatchObject({
      code: "INVALID_STATE",
    });
  });

  it("lets exactly one of several concurrent openers win", async () => {
    const till = await createTill({ withShift: false });
    const { user, device } = till.ctx();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => openShift({ openingFloat: 100n }, user, device, meta)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as ActionError).code).toBe("INVALID_STATE");
    }
    expect(await db.shift.count({ where: { status: "OPEN" } })).toBe(1);
  });

  it("refuses users without access to the register's location", async () => {
    const till = await createTill({ withShift: false });
    const elsewhere = await createTill({ withShift: false });
    await expect(
      openShift({ openingFloat: 0n }, elsewhere.ctx().user, till.ctx().device, meta),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("QPay payment intents", () => {
  beforeEach(async () => {
    await resetDatabase();
    setPaymentProviderForTests(null);
  });
  afterAll(() => db.$disconnect());

  it("creates an invoice, stays PENDING until the provider says paid, then PAID", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    const saleId = uuidv7();
    const invoice = await createQpayInvoice({ saleId, amount: 250_000n }, user, device, meta);
    expect(invoice.qrText).toContain("MOCKQPAY");
    expect(invoice.deeplinks.length).toBeGreaterThan(0);
    expect(invoice.expiresAt).not.toBeNull();

    expect(await checkQpay(invoice.intentId, user)).toEqual({ status: "PENDING" });
    const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: invoice.intentId } });
    expect(intent).toMatchObject({ saleId, amount: 250_000n, status: "PENDING", provider: "mock" });

    markMockInvoicePaid(intent.providerRef!);
    expect(await checkQpay(invoice.intentId, user)).toEqual({ status: "PAID" });
    const paid = await db.paymentIntent.findUniqueOrThrow({ where: { id: invoice.intentId } });
    expect(paid.paidAt).not.toBeNull();
  });

  it("the webhook only triggers a check: a bogus callback pays nothing", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    const invoice = await createQpayInvoice(
      { saleId: uuidv7(), amount: 1000n },
      user,
      device,
      meta,
    );
    const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: invoice.intentId } });
    await handleQpayWebhook(intent.providerRef!); // provider has not been paid
    await handleQpayWebhook("nonsense");
    expect((await db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe(
      "PENDING",
    );
    markMockInvoicePaid(intent.providerRef!);
    await handleQpayWebhook(intent.providerRef!);
    expect((await db.paymentIntent.findUniqueOrThrow({ where: { id: intent.id } })).status).toBe(
      "PAID",
    );
  });

  it("auto-pays after MOCK_QPAY_AUTOPAY_SECONDS", async () => {
    let clock = new Date("2026-10-14T00:00:00Z");
    setPaymentProviderForTests(createMockQpayProvider(() => clock));
    process.env.MOCK_QPAY_AUTOPAY_SECONDS = "3";
    try {
      const till = await createTill();
      const { user, device } = till.ctx();
      const invoice = await createQpayInvoice(
        { saleId: uuidv7(), amount: 5000n },
        user,
        device,
        meta,
      );
      expect((await syncPaymentIntent(invoice.intentId, clock))?.status).toBe("PENDING");
      clock = new Date(clock.getTime() + 4000);
      expect((await syncPaymentIntent(invoice.intentId, clock))?.status).toBe("PAID");
    } finally {
      delete process.env.MOCK_QPAY_AUTOPAY_SECONDS;
      setPaymentProviderForTests(null);
    }
  });

  it("expires an unpaid intent after its lifetime", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    const invoice = await createQpayInvoice(
      { saleId: uuidv7(), amount: 5000n },
      user,
      device,
      meta,
    );
    const later = new Date(Date.now() + 60 * 60 * 1000);
    expect((await syncPaymentIntent(invoice.intentId, later))?.status).toBe("EXPIRED");
  });

  it("hides other cashiers' intents and committed sales' ids", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    const invoice = await createQpayInvoice(
      { saleId: uuidv7(), amount: 5000n },
      user,
      device,
      meta,
    );
    const other = await db.user.findUniqueOrThrow({ where: { id: till.manager.id } });
    // A manager may look (reports.view); a stranger cashier may not.
    expect(
      (await checkQpay(invoice.intentId, { id: other.id, role: "MANAGER", locationIds: "ALL" }))
        .status,
    ).toBe("PENDING");
    await expect(
      checkQpay(invoice.intentId, { id: uuidv7(), role: "CASHIER", locationIds: "ALL" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id)],
      expectedPayable: "100000",
      tenders: [{ method: "CASH", amount: "100000" }],
    });
    await checkoutSale(input, till.ctx());
    await expect(
      createQpayInvoice({ saleId: input.saleId, amount: 1000n }, user, device, meta),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("post-commit fiscal receipt and receipt delivery", () => {
  beforeEach(async () => {
    await resetDatabase();
    setFiscalProviderForTests(null);
    setMessagingProviderForTests(null);
  });
  afterAll(() => db.$disconnect());

  async function makeSale() {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const input = buildInput({
      lines: [lineOf(variant.id, 2000)],
      expectedPayable: "200000",
      tenders: [{ method: "CASH", amount: "200000" }],
    });
    const result = await checkoutSale(input, till.ctx());
    return { till, result };
  }

  it("a committed sale has no fiscal receipt until the post-commit step runs", async () => {
    const { result } = await makeSale();
    expect(await db.fiscalReceipt.count()).toBe(0);
    await runPostSale(result.saleId);
    const receipt = await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: result.saleId } });
    expect(receipt).toMatchObject({ provider: "mock", status: "ISSUED", attempts: 1 });
    expect(receipt.externalId).toMatch(/^MOCK-/);
    expect(receipt.lotteryCode).toBeTruthy();
    // Idempotent: running again does not issue twice.
    await runPostSale(result.saleId);
    expect(await db.fiscalReceipt.count()).toBe(1);
    expect(
      (await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: result.saleId } })).attempts,
    ).toBe(1);
  });

  it("a failing provider leaves a FAILED, retryable record and never affects the sale", async () => {
    const { result } = await makeSale();
    process.env.MOCK_EBARIMT_FAIL = "1";
    try {
      await runPostSale(result.saleId);
    } finally {
      delete process.env.MOCK_EBARIMT_FAIL;
    }
    const failed = await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: result.saleId } });
    expect(failed).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(failed.error).toContain("unavailable");

    expect(await reconcileFiscalReceipts()).toBeGreaterThan(0);
    const ok = await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: result.saleId } });
    expect(ok).toMatchObject({ status: "ISSUED", attempts: 2 });
    expect(await retryFiscalReceipt(ok.id)).toBe("ISSUED");
    expect(await db.sale.count()).toBe(1);
  });

  it("reconcile creates missing fiscal receipts for committed sales", async () => {
    await makeSale();
    await makeSale();
    await reconcileFiscalReceipts();
    expect(await db.fiscalReceipt.count({ where: { status: "ISSUED" } })).toBe(2);
  });

  it("delivers receipts by SMS/e-mail, recording failures instead of throwing", async () => {
    const { result } = await makeSale();
    const sms = await deliverReceipt({
      saleId: result.saleId,
      channel: "SMS",
      destination: "99112233",
      shareUrl: `https://pos.example/r/${result.shareToken}`,
    });
    expect(sms.status).toBe("SENT");
    process.env.MOCK_MESSAGING_FAIL = "1";
    try {
      const mail = await deliverReceipt({
        saleId: result.saleId,
        channel: "EMAIL",
        destination: "a@b.mn",
        shareUrl: "https://pos.example/r/x",
      });
      expect(mail.status).toBe("FAILED");
    } finally {
      delete process.env.MOCK_MESSAGING_FAIL;
    }
    const rows = await db.receiptDelivery.findMany({ orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.channel, r.status])).toEqual([
      ["SMS", "SENT"],
      ["EMAIL", "FAILED"],
    ]);
    await expect(
      deliverReceipt({ saleId: result.saleId, channel: "SMS", destination: "no", shareUrl: "x" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
