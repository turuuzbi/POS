import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildRefundReceiptRows, makeCreditLabels } from "@/domain/receipt-credit-layout";
import {
  getRefundReceiptByToken,
  getRefundReceiptForStaff,
  getVoidReceiptByToken,
  getVoidReceiptForStaff,
} from "@/server/services/credit-notes";
import { creditNoteToken } from "@/server/services/credit-note-token";
import { getReceiptByToken } from "@/server/services/receipts";
import mn from "../../messages/mn/receipt.json";
import { db, resetDatabase } from "../support/db";
import { createUser } from "../support/fixtures";
import { createReceiptRefund } from "../support/refund-fixtures";
import {
  createBusinessSettings,
  createReceiptContext,
  createReceiptSale,
  SPLIT_TENDER_LINES,
} from "../support/receipt-fixtures";

const t = (key: string, values: Record<string, string | number> = {}) => {
  let node: unknown = mn;
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  return String(node).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

const anywhere = () => true;
const nowhere = () => false;
const json = (value: unknown) =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

describe("refund receipt (credit note)", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  async function splitRefund() {
    await createBusinessSettings({ businessName: "Номин Маркет", taxId: "1234567" });
    const context = await createReceiptContext();
    const manager = await createUser({ role: "MANAGER", locationIds: [context.locationId] });
    const sale = await createReceiptSale({
      context,
      number: "UB1-000123",
      lines: [
        {
          name: "Сүү 1л",
          qtyMilli: 2000,
          unitPrice: 500_000n,
          total: 1_000_000n,
          vat: 90_909n,
          unitCost: 987_654n,
        },
        ...SPLIT_TENDER_LINES.slice(1),
      ],
    });
    // Refund the first line (2 × milk, 10 000 ₮) half to the card, half in cash.
    const refund = await createReceiptRefund(
      { ...sale, context },
      {
        number: "UB1-R-000045",
        lines: [{ lineNo: 1, qtyMilli: 2000, total: 1_000_000n, vat: 90_909n }],
        payments: [
          { method: "CARD", amount: 500_000n },
          { method: "CASH", amount: 500_000n },
        ],
        approvedById: manager.id,
        reason: "DAMAGED",
        note: "INTERNAL: customer shouted",
      },
    );
    return { context, manager, sale, refund };
  }

  it("loads the credit note by its signed share token", async () => {
    const { refund, manager, context } = await splitRefund();
    const token = creditNoteToken("refund", refund.id)!;
    const result = await getRefundReceiptByToken(token);
    expect(result).not.toBeNull();
    const { model } = result!;
    expect(model.number).toBe("UB1-R-000045");
    expect(model.originalNumber).toBe("UB1-000123");
    expect(model.header.businessName).toBe("Номин Маркет");
    expect(model.processedBy).toBe(context.cashierName);
    expect(model.approvedBy).toBe(manager.name);
    expect(model.reason).toBe("DAMAGED");
    expect(model.date).toBe("2026-10-15"); // 18:30Z is the next morning in Ulaanbaatar
    expect(model.time).toBe("02:30");
    expect(model.lines).toMatchObject([
      { no: 1, name: "Сүү 1л", qtyMilli: 2000, total: 1_000_000n },
    ]);
    expect(model.totals.total).toBe(1_000_000n);
    expect(model.payouts.map((p) => [p.method, p.amount])).toEqual([
      ["CARD", 500_000n],
      ["CASH", 500_000n],
    ]);
    expect(model.cashReturned).toBe(500_000n);
    const rows = buildRefundReceiptRows(model, makeCreditLabels(t), { locale: "mn" });
    expect(rows.some((r) => r.kind === "banner" && r.text === "ХЭРЭГЛЭГЧИЙН БУЦААЛТ")).toBe(true);
  });

  it("exposes nothing internal: no ids, costs, internal note or PINs", async () => {
    const { refund, sale, context, manager } = await splitRefund();
    const { model } = (await getRefundReceiptByToken(creditNoteToken("refund", refund.id)!))!;
    const text = json(model);
    for (const secret of [
      refund.id,
      sale.id,
      sale.token,
      context.cashierId,
      manager.id,
      context.variantId,
      "INTERNAL",
      "987654", // cost snapshot of the refunded line
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toMatch(/unitCost|pinLookup|passwordHash/);
  });

  it("rejects wrong, tampered, truncated and other-kind tokens alike", async () => {
    const { refund, sale } = await splitRefund();
    const good = creditNoteToken("refund", refund.id)!;
    expect(await getRefundReceiptByToken(good)).not.toBeNull();

    const [idPart, sig] = good.split(".") as [string, string];
    const tampered = `${idPart}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    expect(await getRefundReceiptByToken(tampered)).toBeNull();
    expect(await getRefundReceiptByToken(good.slice(0, -2))).toBeNull();
    expect(await getRefundReceiptByToken("")).toBeNull();
    // Signed for a refund id that does not exist.
    expect(
      await getRefundReceiptByToken(
        creditNoteToken("refund", "00000000-0000-4000-8000-000000000000")!,
      ),
    ).toBeNull();
    // A void token never opens a refund, even with the refund's id.
    expect(await getRefundReceiptByToken(creditNoteToken("void", refund.id)!)).toBeNull();
    // A sale's stored share token is not a credit-note token.
    expect(await getRefundReceiptByToken(sale.token)).toBeNull();
    // And a credit-note token is not a sale share token.
    expect(await getReceiptByToken(good)).toBeNull();
  });

  it("serves staff only inside their locations", async () => {
    const { refund, context } = await splitRefund();
    expect(await getRefundReceiptForStaff(refund.id, anywhere)).not.toBeNull();
    expect(
      await getRefundReceiptForStaff(refund.id, (id) => id === context.locationId),
    ).not.toBeNull();
    expect(await getRefundReceiptForStaff(refund.id, nowhere)).toBeNull();
    expect(await getRefundReceiptForStaff("not-a-uuid", anywhere)).toBeNull();
    const { shareToken } = (await getRefundReceiptForStaff(refund.id, anywhere))!;
    expect(shareToken).toBe(creditNoteToken("refund", refund.id));
    expect(await getRefundReceiptByToken(shareToken)).not.toBeNull();
  });

  it("shows an exchange credit line and the replacement receipt", async () => {
    const context = await createReceiptContext();
    const sale = await createReceiptSale({ context, number: "UB1-000200" });
    const replacement = await createReceiptSale({ context, number: "UB1-000201" });
    const refund = await createReceiptRefund(
      { ...sale, context },
      {
        lines: [{ lineNo: 1, qtyMilli: 2000, total: 1_000_000n, vat: 90_909n }],
        payments: [
          { method: "EXCHANGE_CREDIT", amount: 700_000n },
          { method: "CASH", amount: 300_000n },
        ],
        exchangeSaleId: replacement.id,
      },
    );
    const { model } = (await getRefundReceiptByToken(creditNoteToken("refund", refund.id)!))!;
    expect(model.exchangeNumber).toBe("UB1-000201");
    expect(model.exchangeCredit).toBe(700_000n);
    expect(model.payouts.map((p) => p.method)).toEqual(["CASH"]);
    expect(model.cashReturned).toBe(300_000n);
  });

  it("the original receipt gains refunded banner data once refunds exist", async () => {
    const context = await createReceiptContext();
    const sale = await createReceiptSale({
      context,
      number: "UB1-000300",
      lines: [
        { name: "Цай", qtyMilli: 1000, unitPrice: 100_000n, total: 100_000n, vat: 9_091n },
        { name: "Талх", qtyMilli: 1000, unitPrice: 40_000n, total: 40_000n, vat: 3_636n },
      ],
      payments: [{ method: "CASH", amount: 140_000n }],
      roundingAmount: 0n,
    });
    expect((await getReceiptByToken(sale.token))!.model.refundState).toBe("NONE");
    await createReceiptRefund(
      { ...sale, context },
      { lines: [{ lineNo: 1, qtyMilli: 1000, total: 100_000n, vat: 9_091n }], number: "R-1" },
    );
    const partial = (await getReceiptByToken(sale.token))!.model;
    expect(partial.refundState).toBe("PARTIAL");
    expect(partial.refunds).toMatchObject([{ number: "R-1", total: 100_000n }]);
    await createReceiptRefund(
      { ...sale, context },
      { lines: [{ lineNo: 2, qtyMilli: 1000, total: 40_000n, vat: 3_636n }], number: "R-2" },
    );
    const full = (await getReceiptByToken(sale.token))!.model;
    expect(full.refundState).toBe("FULL");
    expect(full.refundedTotal).toBe(140_000n);
    expect(full.refunds.map((r) => r.number)).toEqual(["R-1", "R-2"]);
  });
});

describe("void slip", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("loads a voided sale by its signed token and by staff id", async () => {
    const context = await createReceiptContext();
    const manager = await createUser({ role: "MANAGER", locationIds: [context.locationId] });
    const sale = await createReceiptSale({
      context,
      number: "UB1-000400",
      voided: true,
      voidApprovedById: manager.id,
    });
    const token = creditNoteToken("void", sale.id)!;
    const { model } = (await getVoidReceiptByToken(token))!;
    expect(model.number).toBe("UB1-000400");
    expect(model.voidedBy).toBe(context.cashierName);
    expect(model.approvedBy).toBe(manager.name);
    expect(model.reason).toBe("ENTRY_ERROR");
    expect(model.reversals.map((r) => r.method)).toEqual(["CARD", "CASH"]);
    expect(model.cashReturned).toBe(850_200n);
    expect(json(model)).not.toContain(sale.id);

    expect(await getVoidReceiptForStaff(sale.id, anywhere)).not.toBeNull();
    expect(await getVoidReceiptForStaff(sale.id, nowhere)).toBeNull();
  });

  it("is not available for a sale that was not voided, nor with another kind's token", async () => {
    const context = await createReceiptContext();
    const sale = await createReceiptSale({ context });
    expect(await getVoidReceiptByToken(creditNoteToken("void", sale.id)!)).toBeNull();
    expect(await getVoidReceiptForStaff(sale.id, anywhere)).toBeNull();

    const voided = await createReceiptSale({ context, voided: true });
    expect(await getVoidReceiptByToken(creditNoteToken("refund", voided.id)!)).toBeNull();
    expect(await getVoidReceiptByToken(voided.token)).toBeNull();
  });
});
