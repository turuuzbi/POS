import { describe, expect, it } from "vitest";
import en from "../../messages/en/receipt.json";
import mn from "../../messages/mn/receipt.json";
import {
  buildRefundReceiptModel,
  buildVoidReceiptModel,
  type RefundReceiptSource,
  type VoidReceiptSource,
} from "./receipt-credit";
import {
  buildRefundReceiptRows,
  buildVoidReceiptRows,
  makeCreditLabels,
} from "./receipt-credit-layout";
import { buildReceiptModel, type ReceiptSource } from "./receipt";
import { buildReceiptRows, makeReceiptLabels, type ReceiptRow } from "./receipt-layout";

function translator(catalog: unknown) {
  return (key: string, values: Record<string, string | number> = {}) => {
    let node: unknown = catalog;
    for (const part of key.split(".")) node = (node as Record<string, unknown>)?.[part];
    if (typeof node !== "string") throw new Error(`missing message ${key}`);
    return node.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
  };
}
const tMn = translator(mn);
const tEn = translator(en);

const business = { name: "Номин Маркет", taxId: "1234567", footer: "Дахин ирээрэй" };
const location = { name: "Төв салбар", timezone: "Asia/Ulaanbaatar" };

const line = (n: number, over: Partial<RefundReceiptSource["lines"][number]> = {}) => ({
  lineNo: n,
  name: `Бараа ${n}`,
  unit: "PIECE" as const,
  qtyMilli: 1000,
  unitPrice: 500_000n,
  taxTreatment: "STANDARD" as const,
  vatRateBps: 1000,
  cityTaxRateBps: 0,
  netAmount: 454_545n,
  vatAmount: 45_455n,
  cityTaxAmount: 0n,
  totalAmount: 500_000n,
  restock: true,
  ...over,
});

const refundSource = (over: Partial<RefundReceiptSource> = {}): RefundReceiptSource => ({
  business,
  location,
  refund: {
    number: "UB1-R-000045",
    occurredAt: new Date("2026-10-14T17:30:00Z"), // 01:30 on the 15th locally
    processedByName: "Болор",
    approvedByName: "Менежер",
    reason: "DEFECTIVE",
    netAmount: 909_090n,
    vatAmount: 90_910n,
    cityTaxAmount: 0n,
    tipAmount: 0n,
    roundingAmount: 0n,
    totalAmount: 1_000_000n,
  },
  originalSale: { number: "UB1-000123" },
  lines: [line(1), line(2)],
  payments: [
    { method: "CARD", amount: 400_000n, cardBrand: "VISA", cardLast4: "4242" },
    { method: "CASH", amount: 600_000n },
  ],
  fiscal: null,
  ...over,
});

const texts = (rows: ReceiptRow[]) =>
  rows.map((r) => ("text" in r ? r.text : r.kind === "pair" ? `${r.left}|${r.right}` : ""));

describe("refund receipt model", () => {
  it("shows a split-tender refund with cash returned and card detail", () => {
    const model = buildRefundReceiptModel(refundSource());
    expect(model.kind).toBe("REFUND");
    expect(model.number).toBe("UB1-R-000045");
    expect(model.originalNumber).toBe("UB1-000123");
    expect(model.date).toBe("2026-10-15");
    expect(model.time).toBe("01:30");
    expect(model.approvedBy).toBe("Менежер");
    expect(model.payouts.map((p) => [p.method, p.amount, p.detail])).toEqual([
      ["CARD", 400_000n, "VISA ****4242"],
      ["CASH", 600_000n, null],
    ]);
    expect(model.cashReturned).toBe(600_000n);
    expect(model.exchangeCredit).toBe(0n);
    expect(model.totals.items).toBe(1_000_000n);
    expect(model.footer).toEqual(["Дахин ирээрэй"]);
    expect(model.fiscal.status).toBe("NONE");
  });

  it("reverses tax per rate group and sums to the refund's tax", () => {
    const model = buildRefundReceiptModel(
      refundSource({
        lines: [
          line(1),
          line(2, {
            taxTreatment: "EXEMPT",
            vatRateBps: 0,
            vatAmount: 0n,
            netAmount: 500_000n,
          }),
        ],
      }),
    );
    expect(model.taxRows.map((r) => [r.treatment, r.vat, r.base])).toEqual([
      ["EXEMPT", 0n, 500_000n],
      ["STANDARD", 45_455n, 454_545n],
    ]);
  });

  it("handles a partial refund of a weighed item and a rounding adjustment", () => {
    const model = buildRefundReceiptModel(
      refundSource({
        refund: {
          ...refundSource().refund,
          totalAmount: 300_000n,
          netAmount: 272_727n,
          vatAmount: 27_273n,
          roundingAmount: -50n,
        },
        lines: [
          line(2, {
            unit: "KG",
            qtyMilli: 750,
            unitPrice: 400_000n,
            totalAmount: 300_050n,
            netAmount: 272_773n,
            vatAmount: 27_277n,
          }),
        ],
        payments: [{ method: "CASH", amount: 300_000n }],
      }),
    );
    expect(model.lines).toHaveLength(1);
    expect(model.lines[0]).toMatchObject({ no: 2, qtyMilli: 750, unit: "KG", total: 300_050n });
    expect(model.totals.rounding).toBe(-50n);
    const rows = buildRefundReceiptRows(model, makeCreditLabels(tMn), { locale: "mn" });
    const flat = texts(rows).join("\n");
    expect(flat).toContain("0.75 кг");
    expect(flat).toContain("-3,000.50"); // refunded line, with its sign
  });

  it("splits exchange credit from real payouts and links the new sale", () => {
    const model = buildRefundReceiptModel(
      refundSource({
        exchangeSale: { number: "UB1-000124" },
        payments: [
          { method: "EXCHANGE_CREDIT", amount: 700_000n },
          { method: "CASH", amount: 300_000n },
        ],
      }),
    );
    expect(model.exchangeNumber).toBe("UB1-000124");
    expect(model.exchangeCredit).toBe(700_000n);
    expect(model.payouts.map((p) => p.method)).toEqual(["CASH"]);
    expect(model.cashReturned).toBe(300_000n);
    const flat = texts(buildRefundReceiptRows(model, makeCreditLabels(tMn), { locale: "mn" })).join(
      "\n",
    );
    expect(flat).toContain("Солилтын баримт №|UB1-000124");
    expect(flat).toContain("Солилтод шилжүүлсэн|7,000₮");
  });

  it("never carries the refund's internal note, ids or costs", () => {
    const source = refundSource() as RefundReceiptSource & { refund: { note?: string } };
    (source.refund as { note?: string }).note = "customer was rude";
    const json = JSON.stringify(buildRefundReceiptModel(source), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(json).not.toContain("rude");
    expect(json).not.toMatch(
      /unitCost|"(id|saleId|refundId|saleLineId|processedById|approvedById)"|"note"/,
    );
  });
});

describe("refund receipt layout", () => {
  it("starts with the credit-note title and lists the facts, in both languages", () => {
    const model = buildRefundReceiptModel(refundSource());
    const mnRows = texts(buildRefundReceiptRows(model, makeCreditLabels(tMn), { locale: "mn" }));
    expect(mnRows).toContain("ХЭРЭГЛЭГЧИЙН БУЦААЛТ");
    expect(mnRows).toContain("Анхны баримт №|UB1-000123");
    expect(mnRows).toContain("Зөвшөөрсөн|Менежер");
    expect(mnRows).toContain("Шалтгаан|Гэмтэлтэй бүтээгдэхүүн");
    expect(mnRows).toContain("Бэлнээр буцаасан|6,000₮");
    expect(mnRows).toContain("Буцаасан нийт дүн|-10,000₮");
    const enRows = texts(buildRefundReceiptRows(model, makeCreditLabels(tEn), { locale: "en" }));
    expect(enRows).toContain("CUSTOMER REFUND");
    expect(enRows).toContain("Original receipt no.|UB1-000123");
  });

  it("prints a fiscal return placeholder per status (TODO(ebarimt))", () => {
    const labels = makeCreditLabels(tMn);
    const placeholder = (status: "PENDING" | "FAILED" | "ISSUED" | null) =>
      texts(
        buildRefundReceiptRows(
          buildRefundReceiptModel(refundSource({ fiscal: status ? { status } : null })),
          labels,
          { locale: "mn" },
        ),
      ).filter((x) => x.includes("И-баримтын буцаалт"));
    expect(placeholder(null)).toEqual([labels.fiscalReturnPending]);
    expect(placeholder("FAILED")).toEqual([labels.fiscalReturnFailed]);
    expect(placeholder("ISSUED")).toEqual([labels.fiscalReturnIssued]);
  });

  it("omits the approver row when nobody approved", () => {
    const model = buildRefundReceiptModel(
      refundSource({ refund: { ...refundSource().refund, approvedByName: null } }),
    );
    const rows = texts(buildRefundReceiptRows(model, makeCreditLabels(tMn), { locale: "mn" }));
    expect(rows.some((r) => r.startsWith("Зөвшөөрсөн|"))).toBe(false);
  });
});

const voidSource = (): VoidReceiptSource => ({
  business,
  location,
  sale: {
    number: "UB1-000123",
    occurredAt: new Date("2026-10-14T17:00:00Z"),
    cashierName: "Болор",
    totalAmount: 1_000_000n,
    netAmount: 909_090n,
    vatAmount: 90_910n,
    cityTaxAmount: 0n,
  },
  void: {
    occurredAt: new Date("2026-10-14T17:10:00Z"),
    reason: "ENTRY_ERROR",
    voidedByName: "Болор",
    approvedByName: "Менежер",
  },
  lines: [line(1), line(2)],
  payments: [
    { method: "CARD", amount: 400_000n, cardBrand: "VISA", cardLast4: "4242" },
    { method: "CASH", amount: 600_000n },
  ],
  fiscal: { status: "ISSUED" },
});

describe("void receipt", () => {
  it("reverses every tender and reports cash handed back", () => {
    const model = buildVoidReceiptModel(voidSource());
    expect(model.kind).toBe("VOID");
    expect(model.number).toBe("UB1-000123");
    expect(model.saleTime).toBe("01:00");
    expect(model.voidTime).toBe("01:10");
    expect(model.reversals).toHaveLength(2);
    expect(model.cashReturned).toBe(600_000n);
    const rows = texts(buildVoidReceiptRows(model, makeCreditLabels(tMn), { locale: "mn" }));
    expect(rows).toContain("ХҮЧИНГҮЙ БОЛГОСОН БАРИМТ");
    expect(rows).toContain("Шалтгаан|Оруулалтын алдаа");
    expect(rows).toContain("Хүчингүй болгосон дүн|10,000₮");
    // The tax lines of a void repeat the sale as it was: no minus signs.
    expect(rows.some((r) => r.startsWith("НӨАТ 10%|") && !r.includes("-"))).toBe(true);
  });
});

describe("refunded banner on the original receipt", () => {
  const saleSource = (refunds: ReceiptSource["refunds"]): ReceiptSource => ({
    business,
    location,
    sale: {
      number: "UB1-000123",
      occurredAt: new Date("2026-10-14T17:00:00Z"),
      cashierName: "Болор",
      netAmount: 909_090n,
      vatAmount: 90_910n,
      cityTaxAmount: 0n,
      discountAmount: 0n,
      itemsAmount: 1_000_000n,
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: 1_000_000n,
    },
    lines: [],
    discounts: [],
    payments: [],
    refunds,
  });
  const rowsOf = (refunds: ReceiptSource["refunds"]) =>
    buildReceiptRows(buildReceiptModel(saleSource(refunds)), makeReceiptLabels(tMn), {
      locale: "mn",
    });

  it("has no banner without refunds", () => {
    expect(rowsOf([]).some((r) => r.kind === "banner")).toBe(false);
  });
  it("shows a partial banner and one line per refund", () => {
    const rows = rowsOf([
      { number: "UB1-R-1", occurredAt: new Date("2026-10-14T18:00:00Z"), totalAmount: 250_000n },
    ]);
    expect(rows.find((r) => r.kind === "banner")).toMatchObject({ text: "ХЭСГИЙН БУЦААЛТТАЙ" });
    expect(texts(rows)).toContain("Буцаалт UB1-R-1 2026-10-15|-2,500₮");
  });
  it("shows a full banner once refunds add up to the total", () => {
    const rows = rowsOf([
      { number: "UB1-R-1", occurredAt: new Date("2026-10-14T18:00:00Z"), totalAmount: 250_000n },
      { number: "UB1-R-2", occurredAt: new Date("2026-10-14T19:00:00Z"), totalAmount: 750_000n },
    ]);
    expect(rows.find((r) => r.kind === "banner")).toMatchObject({ text: "БУЦААСАН" });
  });
  it("lets the void banner win", () => {
    const source = saleSource([
      { number: "UB1-R-1", occurredAt: new Date("2026-10-14T18:00:00Z"), totalAmount: 1n },
    ]);
    source.sale.voided = true;
    const rows = buildReceiptRows(buildReceiptModel(source), makeReceiptLabels(tMn), {
      locale: "mn",
    });
    expect(rows.filter((r) => r.kind === "banner")).toEqual([
      { kind: "banner", text: "ХҮЧИНГҮЙ БОЛГОСОН" },
    ]);
  });
});
