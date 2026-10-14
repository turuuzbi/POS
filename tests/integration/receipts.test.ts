import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildReceiptRows, makeReceiptLabels } from "@/domain/receipt-layout";
import { renderReceiptPdf } from "@/server/services/receipt-pdf";
import {
  getReceiptByToken,
  getReceiptForStaff,
  isPlausibleReceiptToken,
  newReceiptToken,
} from "@/server/services/receipts";
import mn from "../../messages/mn/receipt.json";
import { db, resetDatabase } from "../support/db";
import {
  createBusinessSettings,
  createReceiptContext,
  createReceiptSale,
} from "../support/receipt-fixtures";

const t = (key: string, values: Record<string, string | number> = {}) => {
  let node: unknown = mn;
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  return String(node).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

describe("receipt share page data", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("loads a split-tender sale by its share token", async () => {
    await createBusinessSettings({
      businessName: "Номин Маркет",
      taxId: "1234567",
      receiptFooter: "Дахин ирээрэй",
    });
    const { token, context } = await createReceiptSale({ number: "UB1-000123" });

    const result = await getReceiptByToken(token);
    expect(result).not.toBeNull();
    const { model } = result!;
    expect(model.number).toBe("UB1-000123");
    expect(model.header.businessName).toBe("Номин Маркет");
    expect(model.header.taxId).toBe("1234567");
    expect(model.footer).toEqual(["Дахин ирээрэй"]);
    expect(model.cashier).toBe(context.cashierName);
    expect(model.date).toBe("2026-10-15"); // 17:30Z is already tomorrow in Ulaanbaatar
    expect(model.time).toBe("01:30");
    expect(model.lines.map((l) => l.name)).toEqual(["Сүү 1л", "Алим", "Ном"]);
    expect(model.totals.total).toBe(1_850_200n);
    expect(model.totals.rounding).toBe(50n);
    expect(model.tenders.map((x) => x.method)).toEqual(["CARD", "CASH"]);
    expect(model.changeTotal).toBe(149_800n);
    expect(model.voided).toBe(false);
    expect(model.taxRows.reduce((s, r) => s + r.vat, 0n)).toBe(model.totals.vat);

    const rows = buildReceiptRows(model, makeReceiptLabels(t), { locale: "mn" });
    expect(rows.some((r) => r.kind === "pair" && r.left === "Хариулт")).toBe(true);
  });

  it("exposes nothing internal: no ids, costs, PINs or token", async () => {
    const { token, id, context } = await createReceiptSale();
    const { model } = (await getReceiptByToken(token))!;
    const json = JSON.stringify(model, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(json).not.toContain(id);
    expect(json).not.toContain(token);
    expect(json).not.toContain(context.cashierId);
    expect(json).not.toContain(context.variantId);
    expect(json).not.toContain("123456"); // the cost snapshot of a line
    expect(json).not.toMatch(/unitCost|pinLookup|passwordHash/);
  });

  it("flags a voided sale", async () => {
    const { token } = await createReceiptSale({ voided: true });
    expect((await getReceiptByToken(token))!.model.voided).toBe(true);
  });

  it("shows line discounts", async () => {
    const { token } = await createReceiptSale({
      lines: [
        {
          name: "Цай",
          qtyMilli: 1000,
          unitPrice: 1_000_000n,
          total: 900_000n,
          vat: 81_818n,
          discount: 100_000n,
        },
      ],
      payments: [{ method: "CASH", amount: 900_000n }],
      roundingAmount: 0n,
    });
    const { model } = (await getReceiptByToken(token))!;
    expect(model.lines[0]?.discount).toBe(100_000n);
    expect(model.totals.discount).toBe(100_000n);
  });

  it("returns null for unknown, short, wrong and malformed tokens", async () => {
    const { token } = await createReceiptSale();
    expect(await getReceiptByToken(newReceiptToken())).toBeNull(); // well-formed, unknown
    expect(await getReceiptByToken("short")).toBeNull();
    expect(await getReceiptByToken("")).toBeNull();
    expect(await getReceiptByToken(token.slice(0, -1))).toBeNull(); // truncated
    expect(await getReceiptByToken(`${token}x`)).toBeNull(); // extended
    const swapped = (token.startsWith("a") ? "b" : "a") + token.slice(1);
    expect(await getReceiptByToken(swapped)).toBeNull(); // one character wrong
    expect(
      await getReceiptByToken(
        token.toUpperCase() === token ? token.toLowerCase() : token.toUpperCase(),
      ),
    ).toBeNull();
    expect(await getReceiptByToken(`${token}'; DROP TABLE "Sale"; --`)).toBeNull();
    expect(await getReceiptByToken(token)).not.toBeNull(); // the real one still works
  });

  it("shape-checks tokens before any query", () => {
    expect(isPlausibleReceiptToken(newReceiptToken())).toBe(true);
    expect(isPlausibleReceiptToken("tok-1")).toBe(false);
    expect(isPlausibleReceiptToken("a".repeat(15))).toBe(false);
    expect(isPlausibleReceiptToken("a".repeat(129))).toBe(false);
    expect(isPlausibleReceiptToken(`${"a".repeat(20)}/../`)).toBe(false);
    expect(newReceiptToken()).not.toBe(newReceiptToken());
  });

  it("renders the stored sale to a PDF", async () => {
    const { token } = await createReceiptSale();
    const { model } = (await getReceiptByToken(token))!;
    const pdf = await renderReceiptPdf(
      buildReceiptRows(model, makeReceiptLabels(t), { locale: "mn" }),
    );
    expect(Buffer.from(pdf.slice(0, 5)).toString("latin1")).toBe("%PDF-");
  });
});

describe("receipt for staff", () => {
  beforeEach(resetDatabase);

  it("returns the receipt and share token for an accessible sale", async () => {
    const { id, token, context } = await createReceiptSale();
    const result = await getReceiptForStaff(id, (loc) => loc === context.locationId);
    expect(result?.shareToken).toBe(token);
    expect(result?.model.totals.total).toBe(1_850_200n);
  });

  it("hides sales outside the user's locations and bad ids", async () => {
    const { id } = await createReceiptSale();
    const other = await createReceiptContext();
    expect(await getReceiptForStaff(id, (loc) => loc === other.locationId)).toBeNull();
    expect(await getReceiptForStaff("not-a-uuid", () => true)).toBeNull();
    expect(await getReceiptForStaff("0193b7c4-0000-7000-8000-00000000ffff", () => true)).toBeNull();
  });
});
