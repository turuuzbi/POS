import { describe, expect, it } from "vitest";
import {
  adjustmentInputSchema,
  adjustmentValue,
  isDeltaAllowed,
  isNoteRequired,
  parseLineQty,
} from "./adjustments";
import { isLowStock, stockValue } from "./stock-levels";

const ids = {
  location: "0198a000-0000-7000-8000-000000000001",
  a: "0198a000-0000-7000-8000-000000000002",
  b: "0198a000-0000-7000-8000-000000000003",
};

describe("adjustment reasons", () => {
  it("restricts direction per reason", () => {
    expect(isDeltaAllowed("DAMAGED", -1000)).toBe(true);
    expect(isDeltaAllowed("DAMAGED", 1000)).toBe(false);
    expect(isDeltaAllowed("FOUND", 1000)).toBe(true);
    expect(isDeltaAllowed("FOUND", -1000)).toBe(false);
    expect(isDeltaAllowed("CORRECTION", -5)).toBe(true);
    expect(isDeltaAllowed("CORRECTION", 5)).toBe(true);
  });

  it("requires a note for loss, correction and other", () => {
    expect(isNoteRequired("LOST_STOLEN")).toBe(true);
    expect(isNoteRequired("OTHER")).toBe(true);
    expect(isNoteRequired("DAMAGED")).toBe(false);
  });
});

describe("adjustmentInputSchema", () => {
  const base = { locationId: ids.location, reason: "DAMAGED" as const };

  it("accepts signed and set lines and blanks an empty note", () => {
    const parsed = adjustmentInputSchema.parse({
      ...base,
      note: "  ",
      lines: [
        { mode: "delta", variantId: ids.a, qtyMilli: -2000 },
        { mode: "set", variantId: ids.b, qtyMilli: 0 },
      ],
    });
    expect(parsed.note).toBeNull();
  });

  it("rejects a missing required note, wrong direction, duplicates and zero deltas", () => {
    const fail = (input: unknown) => adjustmentInputSchema.safeParse(input).success;
    expect(
      fail({
        ...base,
        reason: "OTHER",
        lines: [{ mode: "delta", variantId: ids.a, qtyMilli: 1000 }],
      }),
    ).toBe(false);
    expect(fail({ ...base, lines: [{ mode: "delta", variantId: ids.a, qtyMilli: 1000 }] })).toBe(
      false,
    );
    expect(
      fail({
        ...base,
        lines: [
          { mode: "delta", variantId: ids.a, qtyMilli: -1000 },
          { mode: "set", variantId: ids.a, qtyMilli: 1000 },
        ],
      }),
    ).toBe(false);
    expect(fail({ ...base, lines: [{ mode: "delta", variantId: ids.a, qtyMilli: 0 }] })).toBe(
      false,
    );
    expect(fail({ ...base, lines: [] })).toBe(false);
    expect(fail({ ...base, lines: [{ mode: "set", variantId: ids.a, qtyMilli: -1 }] })).toBe(false);
  });
});

describe("parseLineQty", () => {
  it("applies the reason's direction and typed signs", () => {
    expect(parseLineQty("3", "delta", "PIECE", "decrease")).toBe(-3000);
    expect(parseLineQty("-3", "delta", "PIECE", "decrease")).toBe(-3000);
    expect(parseLineQty("3", "delta", "PIECE", "increase")).toBe(3000);
    expect(parseLineQty("-2,5", "delta", "KG", "both")).toBe(-2500);
    expect(parseLineQty("+2.5", "delta", "KG", "both")).toBe(2500);
    expect(parseLineQty("−1", "delta", "PIECE", "both")).toBe(-1000);
  });

  it("rejects fractions of pieces and junk, allows zero only when setting", () => {
    expect(parseLineQty("1.5", "delta", "PIECE", "both")).toBeNull();
    expect(parseLineQty("abc", "delta", "KG", "both")).toBeNull();
    expect(parseLineQty("", "set", "KG", "both")).toBeNull();
    expect(parseLineQty("0", "delta", "PIECE", "both")).toBeNull();
    expect(parseLineQty("0", "set", "PIECE", "both")).toBe(0);
  });
});

describe("stock levels", () => {
  it("flags items at or below the reorder point only when one is set", () => {
    expect(isLowStock(5000, 5000)).toBe(true);
    expect(isLowStock(4999, 5000)).toBe(true);
    expect(isLowStock(5001, 5000)).toBe(false);
    expect(isLowStock(0, null)).toBe(false);
  });

  it("values stock at average cost", () => {
    expect(stockValue(2500, 1000n)).toBe(2500n);
    expect(adjustmentValue(-1500, 2000n)).toBe(-3000n);
  });
});
