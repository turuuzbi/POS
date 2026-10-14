import { describe, expect, it } from "vitest";
import en from "../../messages/en/receipt.json";
import mn from "../../messages/mn/receipt.json";
import { buildReceiptRows, makeReceiptLabels, type ReceiptRow } from "./receipt-layout";
import { buildReceiptModel, localDateTime, type ReceiptSource } from "./receipt";

function translator(catalog: Record<string, unknown>) {
  return (key: string, values: Record<string, string | number> = {}) => {
    let node: unknown = catalog;
    for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
    if (typeof node !== "string") throw new Error(`missing message ${key}`);
    return node.replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
  };
}

/** A realistic mixed sale: VAT item, weighed VAT item, VAT-exempt item, split tender with change. */
function source(overrides: Partial<ReceiptSource> = {}): ReceiptSource {
  return {
    business: {
      name: "Номин Маркет",
      legalName: "Номин ХХК",
      taxId: "1234567",
      phone: "70001111",
      address: "Улаанбаатар, СБД",
      header: "Тавтай морил",
      footer: "Дахин ирээрэй\nwww.example.mn",
    },
    location: { name: "Төв салбар", phone: "70002222", timezone: "Asia/Ulaanbaatar" },
    sale: {
      number: "UB1-000123",
      // 2026-10-14T17:30:00Z = 2026-10-15 01:30 in Ulaanbaatar (UTC+8): the date rolls over.
      occurredAt: new Date("2026-10-14T17:30:00Z"),
      cashierName: "Болор",
      netAmount: 1_704_696n,
      vatAmount: 145_454n,
      cityTaxAmount: 0n,
      discountAmount: 50_000n,
      itemsAmount: 1_850_150n,
      tipAmount: 0n,
      roundingAmount: 50n,
      totalAmount: 1_850_200n,
    },
    lines: [
      {
        lineNo: 1,
        name: "Сүү 1л",
        sku: "SKU-1",
        unit: "PIECE",
        qtyMilli: 2000,
        unitPrice: 500_000n,
        taxTreatment: "STANDARD",
        vatRateBps: 1000,
        cityTaxRateBps: 0,
        netAmount: 909_091n,
        vatAmount: 90_909n,
        cityTaxAmount: 0n,
        totalAmount: 1_000_000n,
      },
      {
        lineNo: 2,
        name: "Алим",
        unit: "KG",
        qtyMilli: 1500,
        unitPrice: 400_000n,
        taxTreatment: "STANDARD",
        vatRateBps: 1000,
        cityTaxRateBps: 0,
        netAmount: 545_455n,
        vatAmount: 54_545n,
        cityTaxAmount: 0n,
        totalAmount: 600_000n,
        modifiers: [{ name: "Савлагаа", priceDelta: 0n }],
      },
      {
        lineNo: 3,
        name: "Ном",
        unit: "PIECE",
        qtyMilli: 1000,
        unitPrice: 300_150n,
        taxTreatment: "EXEMPT",
        vatRateBps: 1000,
        cityTaxRateBps: 0,
        netAmount: 250_150n,
        vatAmount: 0n,
        cityTaxAmount: 0n,
        totalAmount: 250_150n,
      },
    ],
    discounts: [
      { saleLineNo: 3, amount: 50_000n },
      { saleLineNo: null, amount: 0n },
    ],
    payments: [
      { method: "CARD", amount: 1_000_000n, change: 0n, cardBrand: "VISA", cardLast4: "4242" },
      { method: "CASH", amount: 850_200n, tendered: 1_000_000n, change: 149_800n },
    ],
    fiscal: null,
    ...overrides,
  };
}

const text = (rows: ReceiptRow[]) =>
  rows.map((row) => {
    switch (row.kind) {
      case "pair":
        return `${row.left} | ${row.right}`;
      case "text":
      case "banner":
        return row.text;
      default:
        return `--${row.kind}`;
    }
  });

describe("localDateTime", () => {
  it("renders in Asia/Ulaanbaatar and rolls the date over", () => {
    expect(localDateTime(new Date("2026-10-14T17:30:00Z"), "Asia/Ulaanbaatar")).toEqual({
      date: "2026-10-15",
      time: "01:30",
      timeZone: "Asia/Ulaanbaatar",
    });
  });

  it("uses midnight as 00:xx, never 24:xx", () => {
    expect(localDateTime(new Date("2026-10-14T16:05:00Z"), "Asia/Ulaanbaatar").time).toBe("00:05");
  });

  it("falls back to Ulaanbaatar for an invalid zone", () => {
    expect(localDateTime(new Date("2026-10-14T17:30:00Z"), "Not/AZone").timeZone).toBe(
      "Asia/Ulaanbaatar",
    );
  });
});

describe("buildReceiptModel", () => {
  const model = buildReceiptModel(source());

  it("builds the header, number, local date and cashier", () => {
    expect(model.header).toMatchObject({
      businessName: "Номин Маркет",
      locationName: "Төв салбар",
      address: "Улаанбаатар, СБД",
      taxId: "1234567",
      phones: ["70002222", "70001111"],
      text: ["Тавтай морил"],
    });
    expect(model.number).toBe("UB1-000123");
    expect(model.date).toBe("2026-10-15");
    expect(model.time).toBe("01:30");
    expect(model.cashier).toBe("Болор");
    expect(model.footer).toEqual(["Дахин ирээрэй", "www.example.mn"]);
  });

  it("lets the location header override the business header", () => {
    const m = buildReceiptModel(
      source({ location: { name: "Салбар", header: "Салбарын мэдэгдэл" } }),
    );
    expect(m.header.text).toEqual(["Салбарын мэдэгдэл"]);
  });

  it("orders lines, carries line discounts and ignores cart-scope rows", () => {
    const reordered = source();
    const m = buildReceiptModel({ ...reordered, lines: [...reordered.lines].reverse() });
    expect(m.lines.map((l) => l.no)).toEqual([1, 2, 3]);
    expect(m.lines[2]?.discount).toBe(50_000n);
    expect(m.lines[0]?.discount).toBe(0n);
    expect(m.lines[1]?.modifiers).toEqual([{ name: "Савлагаа", priceDelta: 0n }]);
  });

  it("groups the tax breakdown by treatment and rate, and it adds up to the sale totals", () => {
    expect(model.taxRows).toHaveLength(2);
    const exempt = model.taxRows.find((r) => r.treatment === "EXEMPT");
    const standard = model.taxRows.find((r) => r.treatment === "STANDARD");
    expect(exempt).toMatchObject({ vatRateBps: 0, base: 250_150n, vat: 0n });
    expect(standard).toMatchObject({ vatRateBps: 1000, base: 1_454_546n, vat: 145_454n });
    const net = model.taxRows.reduce((s, r) => s + r.base, 0n);
    const vat = model.taxRows.reduce((s, r) => s + r.vat, 0n);
    expect(net).toBe(model.totals.net);
    expect(vat).toBe(model.totals.vat);
  });

  it("keeps city tax in its own row", () => {
    const base = source();
    const m = buildReceiptModel({
      ...base,
      lines: [
        {
          ...base.lines[0]!,
          cityTaxRateBps: 100,
          netAmount: 900_901n,
          vatAmount: 90_090n,
          cityTaxAmount: 9_009n,
        },
      ],
    });
    expect(m.taxRows).toEqual([
      {
        treatment: "STANDARD",
        vatRateBps: 1000,
        cityTaxRateBps: 100,
        base: 900_901n,
        vat: 90_090n,
        cityTax: 9_009n,
      },
    ]);
  });

  it("keeps the signed rounding and the total", () => {
    expect(model.totals.rounding).toBe(50n);
    expect(model.totals.total).toBe(model.totals.items + model.totals.rounding);
  });

  it("describes a split tender with change", () => {
    expect(model.tenders).toEqual([
      { method: "CARD", amount: 1_000_000n, tendered: null, change: 0n, detail: "VISA ****4242" },
      {
        method: "CASH",
        amount: 850_200n,
        tendered: 1_000_000n,
        change: 149_800n,
        detail: null,
      },
    ]);
    expect(model.changeTotal).toBe(149_800n);
    // Applied tenders cover the total exactly; change is extra cash handed back.
    expect(model.tenders.reduce((s, t) => s + t.amount, 0n)).toBe(model.totals.total);
  });

  it("marks a voided sale and keeps fiscal info as a placeholder", () => {
    expect(model.voided).toBe(false);
    expect(model.fiscal).toEqual({ status: "NONE", lotteryCode: null, qrData: null });
    const issued = buildReceiptModel(
      source({
        fiscal: { status: "ISSUED", lotteryCode: "AB 12345678", qrData: "qr" },
        sale: { ...source().sale, voided: true },
      }),
    );
    expect(issued.voided).toBe(true);
    expect(issued.fiscal).toEqual({ status: "ISSUED", lotteryCode: "AB 12345678", qrData: "qr" });
  });

  it("never exposes ids, costs or PIN-like data", () => {
    const serialised = JSON.stringify(model, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(serialised).not.toMatch(/unitCost|pin|cost|cashierId|variantId/i);
  });
});

describe("buildReceiptRows", () => {
  const model = buildReceiptModel(source());
  const rows = buildReceiptRows(model, makeReceiptLabels(translator(mn)), { locale: "mn" });
  const lines = text(rows);

  it("prints header, meta, lines, totals, tax and tenders in order", () => {
    const find = (needle: string) => lines.findIndex((l) => l.includes(needle));
    const order = [
      "Номин Маркет",
      "ТТД: 1234567",
      "Баримт № | UB1-000123",
      "Огноо | 2026-10-15 01:30",
      "1. Сүү 1л",
      "2. Алим",
      "3. Ном",
      "Нийт дүн",
      "Тоймлол",
      "Төлөх дүн",
      "НӨАТ 10%",
      "Татваргүй дүн",
      "Карт (VISA ****4242)",
      "Бэлэн мөнгө",
      "Хариулт",
      "Дахин ирээрэй",
    ].map(find);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("formats quantities with units, whole-₮ amounts and signed rounding", () => {
    expect(lines).toContain("2 ш × 5,000 | 10,000");
    expect(lines).toContain("1.5 кг × 4,000 | 6,000");
    expect(lines).toContain("Тоймлол | +0.50₮");
    expect(lines).toContain("Төлөх дүн | 18,502₮");
    expect(lines).toContain("Хариулт | 1,498₮");
    expect(lines).toContain("Өгсөн мөнгө | 10,000₮");
    expect(lines).toContain("Хөнгөлөлт | -500");
  });

  it("shows the exempt base and the fiscal placeholder", () => {
    expect(lines).toContain("НӨАТ-аас чөлөөлөгдөх | 2,501.50₮");
    expect(lines).toContain("И-баримт бүртгэгдэж байна");
  });

  it("prints the lottery code once issued and a banner when voided", () => {
    const m = buildReceiptModel(
      source({
        fiscal: { status: "ISSUED", lotteryCode: "AB 12345678" },
        sale: { ...source().sale, voided: true },
      }),
    );
    const out = text(buildReceiptRows(m, makeReceiptLabels(translator(mn)), { locale: "mn" }));
    expect(out).toContain("Сугалааны дугаар: AB 12345678");
    expect(out).toContain("ХҮЧИНГҮЙ БОЛГОСОН");
    expect(out).not.toContain("И-баримт бүртгэгдэж байна");
  });

  it("falls back to the default footer and renders English labels", () => {
    const base = source();
    const m = buildReceiptModel({ ...base, business: { name: "Shop" } });
    const out = text(buildReceiptRows(m, makeReceiptLabels(translator(en)), { locale: "en" }));
    expect(out).toContain("Thank you for your purchase!");
    expect(out).toContain("Receipt no. | UB1-000123");
    expect(out).toContain("1.5 kg × 4,000 | 6,000");
  });

  it("omits zero rounding, tip and discount rows", () => {
    const base = source();
    const m = buildReceiptModel({
      ...base,
      sale: { ...base.sale, roundingAmount: 0n, discountAmount: 0n, tipAmount: 0n },
    });
    const out = text(buildReceiptRows(m, makeReceiptLabels(translator(mn)), { locale: "mn" }));
    expect(out.some((l) => l.startsWith("Тоймлол"))).toBe(false);
    expect(out.some((l) => l.startsWith("Шагнал"))).toBe(false);
    expect(out.some((l) => l.startsWith("Хөнгөлөлт (дүнд"))).toBe(false);
  });
});
