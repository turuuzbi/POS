import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { setMessagingProviderForTests } from "@/server/adapters/messaging";
import type { OutgoingMessage } from "@/server/adapters/messaging/types";
import { sendSaleReceipt } from "@/server/services/post-sale";
import { db, resetDatabase } from "../support/db";
import { createReceiptSale } from "../support/receipt-fixtures";

const BASE = "https://pos.example.mn";
const manager = { role: "MANAGER" as const, locationIds: "ALL" as const };

describe("sendSaleReceipt", () => {
  const sent: OutgoingMessage[] = [];
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    setMessagingProviderForTests({
      name: "capture",
      async send(message) {
        sent.push(message);
        return { providerRef: `cap_${sent.length}` };
      },
    });
  });
  afterEach(() => setMessagingProviderForTests(null));
  afterAll(() => db.$disconnect());

  it("sends the public share link built from the sale token and the app origin", async () => {
    const { id, token } = await createReceiptSale();
    const result = await sendSaleReceipt(
      { saleId: id, channel: "EMAIL", destination: " buyer@example.com " },
      manager,
      `${BASE}/`,
    );
    expect(result.status).toBe("SENT");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "EMAIL", destination: "buyer@example.com" });
    expect(sent[0]!.body).toContain(`${BASE}/r/${token}`);
    expect(sent[0]!.body).not.toContain("//r/");
    const row = await db.receiptDelivery.findUniqueOrThrow({ where: { id: result.id } });
    expect(row).toMatchObject({ saleId: id, status: "SENT", destination: "buyer@example.com" });
  });

  it("records a provider failure as a FAILED delivery instead of throwing", async () => {
    const { id } = await createReceiptSale();
    setMessagingProviderForTests({
      name: "down",
      async send() {
        throw new Error("gateway down");
      },
    });
    const result = await sendSaleReceipt(
      { saleId: id, channel: "SMS", destination: "99112233" },
      manager,
      BASE,
    );
    expect(result.status).toBe("FAILED");
    expect(
      (await db.receiptDelivery.findUniqueOrThrow({ where: { id: result.id } })).error,
    ).toMatch(/gateway down/);
  });

  it("rejects malformed destinations without recording anything", async () => {
    const { id } = await createReceiptSale();
    await expect(
      sendSaleReceipt({ saleId: id, channel: "EMAIL", destination: "nope" }, manager, BASE),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      sendSaleReceipt({ saleId: id, channel: "SMS", destination: "a@b.mn" }, manager, BASE),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.receiptDelivery.count()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("treats a sale at another location, or an unknown sale, as not found", async () => {
    const { id, context } = await createReceiptSale();
    const elsewhere = {
      role: "CASHIER" as const,
      locationIds: ["00000000-0000-7000-8000-000000000001"],
    };
    await expect(
      sendSaleReceipt({ saleId: id, channel: "SMS", destination: "99112233" }, elsewhere, BASE),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      sendSaleReceipt(
        { saleId: "00000000-0000-7000-8000-0000000000ff", channel: "SMS", destination: "99112233" },
        manager,
        BASE,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const here = { role: "CASHIER" as const, locationIds: [context.locationId] };
    await expect(
      sendSaleReceipt({ saleId: id, channel: "SMS", destination: "99112233" }, here, BASE),
    ).resolves.toMatchObject({ status: "SENT" });
    expect(sent).toHaveLength(1);
  });

  it("allows a few re-sends per sale, then answers RATE_LIMITED", async () => {
    const { id } = await createReceiptSale();
    for (let i = 0; i < 5; i++) {
      await sendSaleReceipt(
        { saleId: id, channel: "SMS", destination: `9911223${i}` },
        manager,
        BASE,
      );
    }
    await expect(
      sendSaleReceipt({ saleId: id, channel: "SMS", destination: "99112239" }, manager, BASE),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(sent).toHaveLength(5);
  });
});
