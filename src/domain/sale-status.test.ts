import { describe, expect, it } from "vitest";
import { deriveSaleStatus, isSaleStatus, refundState } from "./sale-status";

describe("deriveSaleStatus", () => {
  it("is completed without voids or refunds", () => {
    expect(deriveSaleStatus({ voided: false, saleTotal: 1000n, refundTotals: [] })).toBe(
      "COMPLETED",
    );
  });
  it("is voided whenever a void exists", () => {
    expect(deriveSaleStatus({ voided: true, saleTotal: 1000n, refundTotals: [] })).toBe("VOIDED");
    // Defensive: a void wins even if a refund row somehow exists.
    expect(deriveSaleStatus({ voided: true, saleTotal: 1000n, refundTotals: [1000n] })).toBe(
      "VOIDED",
    );
  });
  it("is partially refunded below the sale total", () => {
    expect(deriveSaleStatus({ voided: false, saleTotal: 1000n, refundTotals: [300n] })).toBe(
      "PARTIALLY_REFUNDED",
    );
    expect(deriveSaleStatus({ voided: false, saleTotal: 1000n, refundTotals: [300n, 699n] })).toBe(
      "PARTIALLY_REFUNDED",
    );
  });
  it("is refunded once refunds add up to the total, in any partition", () => {
    expect(deriveSaleStatus({ voided: false, saleTotal: 1000n, refundTotals: [1000n] })).toBe(
      "REFUNDED",
    );
    expect(deriveSaleStatus({ voided: false, saleTotal: 1000n, refundTotals: [400n, 600n] })).toBe(
      "REFUNDED",
    );
  });
  it("treats a zero-value refund row by comparing totals", () => {
    expect(deriveSaleStatus({ voided: false, saleTotal: 0n, refundTotals: [0n] })).toBe("REFUNDED");
    expect(deriveSaleStatus({ voided: false, saleTotal: 100n, refundTotals: [0n] })).toBe(
      "PARTIALLY_REFUNDED",
    );
  });
  it("maps to the receipt refund state", () => {
    expect(refundState(1000n, [])).toBe("NONE");
    expect(refundState(1000n, [1n])).toBe("PARTIAL");
    expect(refundState(1000n, [1000n])).toBe("FULL");
  });
  it("recognises its vocabulary", () => {
    expect(isSaleStatus("VOIDED")).toBe(true);
    expect(isSaleStatus("voided")).toBe(false);
    expect(isSaleStatus(undefined)).toBe(false);
  });
});
