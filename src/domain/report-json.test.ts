import { describe, expect, it } from "vitest";
import { buildXReport, buildZReport, reportToJson, type ShiftReportInput } from "./report";
import { parseReportJson } from "./report-json";
import { shiftCodeFromFailure } from "./shift-failure";

const input: ShiftReportInput = {
  shift: {
    id: "s1",
    registerId: "r1",
    openedAt: new Date("2026-10-15T01:00:00Z"),
    openingFloat: 5_000_000n,
  },
  sales: [
    {
      id: "a",
      number: "UB1-000001",
      occurredAt: new Date("2026-10-15T02:00:00Z"),
      void: null,
      itemsAmount: 110_000n,
      discountAmount: 0n,
      tipAmount: 0n,
      roundingAmount: 0n,
      totalAmount: 110_000n,
      lines: [
        {
          qtyMilli: 2000,
          unit: "PIECE",
          taxTreatment: "STANDARD",
          vatRateBps: 1000,
          cityTaxRateBps: 0,
          netAmount: 100_000n,
          vatAmount: 10_000n,
          cityTaxAmount: 0n,
          totalAmount: 110_000n,
        },
      ],
      payments: [{ method: "CASH", amount: 110_000n, change: 0n }],
    },
  ],
  refunds: [],
  cashMovements: [{ type: "CASH_IN", amount: 100_000n }],
  asOf: new Date("2026-10-15T09:00:00Z"),
};

describe("parseReportJson", () => {
  it("round-trips an X report", () => {
    const report = buildXReport(input);
    expect(parseReportJson(reportToJson(report))).toEqual(report);
  });

  it("round-trips a Z report with its closing count", () => {
    const report = buildZReport(input, {
      closedAt: new Date("2026-10-15T09:00:00Z"),
      countedCash: 5_210_000n,
      denominations: { "20000": 2, "10000": 1, "1000": 2, "100": 1 },
      note: "ok",
    });
    const parsed = parseReportJson(JSON.parse(JSON.stringify(reportToJson(report))));
    expect(parsed).toEqual(report);
    expect(parsed?.closing?.cashVariance).toBe(0n);
  });

  it("rejects a malformed snapshot", () => {
    expect(parseReportJson({ kind: "Z" })).toBeNull();
    expect(parseReportJson(null)).toBeNull();
  });
});

describe("shiftCodeFromFailure", () => {
  it("reads the code and details", () => {
    expect(
      shiftCodeFromFailure({
        fieldErrors: {
          shift: ["APPROVAL_REQUIRED"],
          "shift.details": ['{"key":"cash:overdraw"}'],
        },
      }),
    ).toEqual({ code: "APPROVAL_REQUIRED", details: { key: "cash:overdraw" } });
  });

  it("ignores unknown codes and other failures", () => {
    expect(shiftCodeFromFailure({ fieldErrors: { shift: ["NOPE"] } })).toBeNull();
    expect(shiftCodeFromFailure({})).toBeNull();
    expect(
      shiftCodeFromFailure({
        fieldErrors: { shift: ["INTERNAL"], "shift.details": ["not json"] },
      }),
    ).toEqual({ code: "INTERNAL" });
  });
});
