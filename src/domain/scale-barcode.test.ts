import { describe, expect, it } from "vitest";
import {
  buildScaleBarcode,
  DEFAULT_SCALE_RULES,
  ean13CheckDigit,
  isValidEan13,
  normalizePlu,
  parseScaleBarcode,
  scaleBarcodeRulesSchema,
  type ScaleBarcodeRule,
  weightToValue,
} from "./scale-barcode";

const weightRule = DEFAULT_SCALE_RULES[0]!;
const priceRule: ScaleBarcodeRule = {
  prefix: "21",
  itemCodeLength: 5,
  valueType: "PRICE",
  valueLength: 5,
  valueDecimals: 0,
};

describe("EAN-13 check digit", () => {
  it("matches known codes", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1); // 4006381333931
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
    expect(isValidEan13("400638133393")).toBe(false);
    expect(isValidEan13("40063813339a1")).toBe(false);
  });
});

describe("parseScaleBarcode", () => {
  it("decodes a weight label (PLU 123, 1.250 kg)", () => {
    const code = buildScaleBarcode(weightRule, "123", 1250);
    expect(code).toHaveLength(13);
    expect(parseScaleBarcode(code)).toEqual({ pluCode: "123", kind: "WEIGHT", qtyMilli: 1250 });
  });

  it("decodes a price label (PLU 45, 12,345₮)", () => {
    const code = buildScaleBarcode(priceRule, "45", 12345);
    expect(parseScaleBarcode(code, [weightRule, priceRule])).toEqual({
      pluCode: "45",
      kind: "PRICE",
      price: 1_234_500n,
    });
  });

  it("honours value decimals for weight (2 decimals = 10 g steps)", () => {
    const rule: ScaleBarcodeRule = { ...weightRule, valueDecimals: 2 };
    const code = buildScaleBarcode(rule, "7", 125); // 1.25 kg
    expect(parseScaleBarcode(code, [rule])).toEqual({
      pluCode: "7",
      kind: "WEIGHT",
      qtyMilli: 1250,
    });
  });

  it("rejects bad check digits, unknown prefixes and zero values", () => {
    const code = buildScaleBarcode(weightRule, "123", 1250);
    const corrupted = code.slice(0, 12) + String((Number(code[12]) + 1) % 10);
    expect(parseScaleBarcode(corrupted)).toBeNull();
    expect(parseScaleBarcode("4006381333931")).toBeNull();
    const zero = buildScaleBarcode(weightRule, "123", 0);
    expect(parseScaleBarcode(zero)).toBeNull();
  });

  it("rejects weights beyond the per-line maximum", () => {
    const wide: ScaleBarcodeRule = {
      prefix: "2",
      itemCodeLength: 4,
      valueType: "WEIGHT",
      valueLength: 7,
      valueDecimals: 0,
    };
    // 5 000 000 kg would be 5e9 milli — beyond MAX_QTY_MILLI and the Int4 columns.
    expect(parseScaleBarcode(buildScaleBarcode(wide, "1", 5_000_000), [wide])).toBeNull();
    expect(parseScaleBarcode(buildScaleBarcode(wide, "1", 12), [wide])).toMatchObject({
      qtyMilli: 12_000,
    });
  });

  it("prefers the longest matching prefix", () => {
    const general: ScaleBarcodeRule = { ...weightRule, prefix: "2", itemCodeLength: 6 };
    const code = buildScaleBarcode(priceRule, "45", 500);
    expect(parseScaleBarcode(code, [general, priceRule])).toMatchObject({ kind: "PRICE" });
  });

  it("round-trips weights through weightToValue", () => {
    for (const grams of [1, 999, 1250, 99_999]) {
      const code = buildScaleBarcode(weightRule, "1", weightToValue(weightRule, grams));
      expect(parseScaleBarcode(code)).toMatchObject({ qtyMilli: grams });
    }
    expect(() => weightToValue({ ...weightRule, valueDecimals: 2 }, 1255)).toThrow(RangeError);
  });
});

describe("rules schema", () => {
  it("accepts the defaults and rejects lengths that do not add up to 13", () => {
    expect(scaleBarcodeRulesSchema.safeParse(DEFAULT_SCALE_RULES).success).toBe(true);
    expect(scaleBarcodeRulesSchema.safeParse([{ ...weightRule, valueLength: 4 }]).success).toBe(
      false,
    );
    expect(scaleBarcodeRulesSchema.safeParse([{ ...priceRule, valueDecimals: 3 }]).success).toBe(
      false,
    );
  });
});

describe("normalizePlu", () => {
  it("strips leading zeros but keeps a single zero", () => {
    expect(normalizePlu("00123")).toBe("123");
    expect(normalizePlu("00000")).toBe("0");
    expect(normalizePlu("120")).toBe("120");
  });
});
