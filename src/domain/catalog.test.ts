import { describe, expect, it } from "vitest";
import {
  barcodeField,
  hasValidCheckDigit,
  moneyField,
  percentField,
  pluField,
  productInputSchema,
  variantLabel,
  type ProductFormValues,
} from "./catalog";

const TAX = "0190a000-0000-7000-8000-000000000001";

function product(overrides: Partial<ProductFormValues> = {}): ProductFormValues {
  return {
    name: "Сүү 1л",
    type: "STANDARD",
    unit: "PIECE",
    categoryId: null,
    taxClassId: TAX,
    pricesIncludeTax: true,
    trackStock: true,
    variants: [{ price: "3,500", barcodes: ["8650001000015"] }],
    ...overrides,
  };
}

const issues = (input: ProductFormValues) => {
  const result = productInputSchema.safeParse(input);
  return result.success
    ? []
    : result.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).sort();
};

describe("field parsers", () => {
  it("parses tögrög to möngö and rejects junk, negatives and absurd amounts", () => {
    expect(moneyField.parse("12,500")).toBe(1_250_000n);
    expect(moneyField.parse("0.5")).toBe(50n);
    for (const bad of ["", "abc", "-1", "1.234", "2000000000"]) {
      expect(moneyField.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("parses a percentage to basis points", () => {
    expect(percentField.parse("10")).toBe(1000);
    expect(percentField.parse("2.5")).toBe(250);
    expect(percentField.parse("0")).toBe(0);
    expect(percentField.safeParse("100.01").success).toBe(false);
    expect(percentField.safeParse("-1").success).toBe(false);
  });

  it("validates GS1 check digits and leaves other codes alone", () => {
    expect(hasValidCheckDigit("8650001000015")).toBe(true);
    expect(hasValidCheckDigit("8650001000014")).toBe(false);
    expect(hasValidCheckDigit("036000291452")).toBe(true); // UPC-A
    expect(hasValidCheckDigit("96385074")).toBe(true); // EAN-8
    expect(hasValidCheckDigit("SHOP-0001")).toBe(true);
    expect(barcodeField.safeParse(" 8650001000015 ").data).toBe("8650001000015");
    expect(barcodeField.safeParse("12").success).toBe(false);
    expect(barcodeField.safeParse("has space").success).toBe(false);
  });

  it("normalises scale PLUs and turns blanks into null", () => {
    expect(pluField.parse("00123")).toBe("123");
    expect(pluField.parse("")).toBeNull();
    expect(pluField.safeParse("12345678").success).toBe(false);
  });
});

describe("productInputSchema", () => {
  it("accepts a simple product and normalises it", () => {
    const parsed = productInputSchema.parse(product());
    expect(parsed.variants[0]).toMatchObject({ price: 350_000n, sku: null, isActive: true });
    expect(parsed.options).toEqual([]);
  });

  it("finds duplicates inside the product", () => {
    expect(
      issues(
        product({
          variants: [
            { sku: "A1", pluCode: "12", price: "1", barcodes: ["8650001000015"] },
            { sku: "a1", pluCode: "0012", price: "1", barcodes: ["8650001000015"] },
          ],
        }),
      ),
    ).toEqual([
      "variants.1.barcodes.0:duplicate",
      "variants.1.pluCode:duplicate",
      "variants.1.sku:duplicate",
    ]);
  });

  it("requires every variant to pick a value of every option, once per combination", () => {
    expect(
      issues(
        product({
          options: [{ name: "Хэмжээ", values: ["S", "M"] }],
          variants: [
            { option1: "S", price: "1" },
            { option1: "S", price: "1" },
            { option1: "XL", price: "1" },
            { option1: "M", option2: "Red", price: "1" },
          ],
        }),
      ),
    ).toEqual([
      "variants.1.option1:duplicate",
      "variants.2.option1:invalid",
      "variants.3.option2:invalid",
    ]);
  });

  it("never tracks stock for services and gift cards", () => {
    expect(issues(product({ type: "SERVICE", trackStock: true }))).toEqual(["trackStock:invalid"]);
    expect(issues(product({ type: "SERVICE", trackStock: false }))).toEqual([]);
    expect(issues(product({ type: "GIFT_CARD", trackStock: false, unit: "KG" }))).toEqual([
      "unit:invalid",
    ]);
  });

  it("reports stable codes for missing and oversized fields", () => {
    expect(issues(product({ name: "  ", variants: [] }))).toEqual([
      "name:required",
      "variants:required",
    ]);
    expect(issues(product({ name: "x".repeat(161) }))).toEqual(["name:tooLong"]);
  });
});

describe("variantLabel", () => {
  it("prefers the variant name, then option values, then the product name", () => {
    expect(variantLabel("Цамц", { name: "Улаан M" })).toBe("Цамц — Улаан M");
    expect(variantLabel("Цамц", { option1: "M", option2: "Улаан" })).toBe("Цамц — M / Улаан");
    expect(variantLabel("Сүү", {})).toBe("Сүү");
  });
});
