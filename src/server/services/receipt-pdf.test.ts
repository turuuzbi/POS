import { decodePDFRawStream, PDFDocument, PDFName, PDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import mn from "../../../messages/mn/receipt.json";
import { buildReceiptModel } from "@/domain/receipt";
import { buildReceiptRows, makeReceiptLabels, type ReceiptRow } from "@/domain/receipt-layout";
import { renderReceiptPdf, wrapText } from "./receipt-pdf";

const t = (key: string, values: Record<string, string | number> = {}) => {
  let node: unknown = mn;
  for (const part of key.split(".")) node = (node as Record<string, unknown>)[part];
  return String(node).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name]));
};

function rowsFor(lineCount = 3): ReceiptRow[] {
  const model = buildReceiptModel({
    business: { name: "Өнөр Үйлдвэр ХХК", taxId: "1234567", footer: "Баярлалаа" },
    location: { name: "Төв салбар" },
    sale: {
      number: "UB1-000123",
      occurredAt: new Date("2026-10-14T17:30:00Z"),
      cashierName: "Болор",
      netAmount: 909_091n * BigInt(lineCount),
      vatAmount: 90_909n * BigInt(lineCount),
      cityTaxAmount: 0n,
      discountAmount: 0n,
      itemsAmount: 1_000_000n * BigInt(lineCount),
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: 1_000_000n * BigInt(lineCount),
    },
    lines: Array.from({ length: lineCount }, (_, i) => ({
      lineNo: i + 1,
      name: `Өндөг, том хэмжээтэй, шинэхэн ${i + 1}`,
      unit: "PIECE" as const,
      qtyMilli: 1000,
      unitPrice: 1_000_000n,
      taxTreatment: "STANDARD" as const,
      vatRateBps: 1000,
      cityTaxRateBps: 0,
      netAmount: 909_091n,
      vatAmount: 90_909n,
      cityTaxAmount: 0n,
      totalAmount: 1_000_000n,
    })),
    discounts: [],
    payments: [{ method: "CASH", amount: 1_000_000n * BigInt(lineCount), change: 0n }],
  });
  return buildReceiptRows(model, makeReceiptLabels(t), { locale: "mn" });
}

/** All Unicode code points that any embedded font's ToUnicode CMap maps to. */
function toUnicodeTargets(doc: PDFDocument): Set<number> {
  const found = new Set<number>();
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    const text = Buffer.from(decodePDFRawStream(object).decode()).toString("latin1");
    if (!text.includes("beginbfchar") && !text.includes("beginbfrange")) continue;
    for (const match of text.matchAll(/<[0-9A-Fa-f]{4}>\s+<([0-9A-Fa-f]{4})>/g)) {
      found.add(parseInt(match[1]!, 16));
    }
  }
  return found;
}

describe("renderReceiptPdf", () => {
  it("produces a single 80 mm wide page whose height fits the content", async () => {
    const small = await PDFDocument.load(await renderReceiptPdf(rowsFor(1)));
    const large = await PDFDocument.load(await renderReceiptPdf(rowsFor(20)));
    expect(small.getPageCount()).toBe(1);
    const { width, height } = small.getPage(0).getSize();
    expect(width).toBeCloseTo((80 / 25.4) * 72, 1);
    expect(height).toBeGreaterThan(200);
    expect(large.getPage(0).getSize().height).toBeGreaterThan(height * 2);
  });

  it("supports the 58 mm option", async () => {
    const doc = await PDFDocument.load(await renderReceiptPdf(rowsFor(2), { paperMm: 58 }));
    expect(doc.getPage(0).getSize().width).toBeCloseTo((58 / 25.4) * 72, 1);
  });

  it("embeds a Cyrillic-capable font and maps Mongolian glyphs, Ү, Ө and ₮", async () => {
    const bytes = await renderReceiptPdf(rowsFor(2), { title: "Баримт" });
    expect(Buffer.from(bytes.slice(0, 5)).toString("latin1")).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    const fontNames = [...doc.context.enumerateIndirectObjects()]
      .map(([, o]) => (o as { get?: (n: PDFName) => unknown }).get?.(PDFName.of("BaseFont")))
      .filter(Boolean)
      .map(String);
    expect(fontNames.some((name) => name.includes("DejaVuSans"))).toBe(true);

    const targets = toUnicodeTargets(doc);
    for (const char of "ӨөҮүБолорХК₮Баримт") {
      expect(targets.has(char.codePointAt(0)!), `glyph ${char}`).toBe(true);
    }
  });
});

describe("wrapText", () => {
  const measure = (s: string) => s.length;
  it("wraps on spaces and splits words longer than the line", () => {
    expect(wrapText("aa bb cc", 5, measure)).toEqual(["aa bb", "cc"]);
    expect(wrapText("abcdefghij", 4, measure)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("", 5, measure)).toEqual([""]);
  });
});
