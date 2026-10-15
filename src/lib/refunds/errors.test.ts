import { describe, expect, it } from "vitest";
import { REFUND_ERROR_CODES } from "@/domain/refund-contract";
import { VOID_ERROR_CODES } from "@/domain/void-contract";
import mn from "../../../messages/mn";
import en from "../../../messages/en";
import { failureView, isApprovalProblem, isStale, isTransient, messageCandidates } from "./errors";

describe("failureView", () => {
  it("reads a contract code from fieldErrors, whatever the field is called", () => {
    const view = failureView(
      {
        code: "VALIDATION",
        fieldErrors: { refund: ["OVER_REFUND"], "refund.details": ['{"saleLineId":"x"}'] },
      },
      "refund",
    );
    expect(view).toMatchObject({
      kind: "contract",
      code: "OVER_REFUND",
      messageKey: "refund.errors.OVER_REFUND",
      details: { saleLineId: "x" },
    });
    expect(
      failureView({ code: "VALIDATION", fieldErrors: { checkout: ["ALREADY_VOIDED"] } }, "void"),
    ).toMatchObject({
      kind: "contract",
      code: "ALREADY_VOIDED",
      messageKey: "void.errors.ALREADY_VOIDED",
    });
  });

  it("falls back to the generic action code", () => {
    expect(failureView({ code: "FORBIDDEN" }, "refund")).toEqual({
      kind: "action",
      code: "FORBIDDEN",
    });
    expect(
      failureView({ code: "VALIDATION", fieldErrors: { "lines.0.qtyMilli": ["bad"] } }, "refund"),
    ).toEqual({ kind: "action", code: "VALIDATION" });
  });

  it("ignores unreadable details and codes of the other domain", () => {
    const view = failureView(
      { code: "VALIDATION", fieldErrors: { refund: ["TOTAL_MISMATCH"], "refund.details": ["{"] } },
      "refund",
    );
    expect(view).toMatchObject({ kind: "contract", code: "TOTAL_MISMATCH" });
    expect(view.kind === "contract" && view.details).toBeUndefined();
    expect(
      failureView({ code: "VALIDATION", fieldErrors: { void: ["VOID_NOT_ALLOWED"] } }, "refund"),
    ).toEqual({ kind: "action", code: "VALIDATION" });
  });
});

describe("classification", () => {
  const contract = (code: string) =>
    failureView({ code: "VALIDATION", fieldErrors: { refund: [code] } }, "refund");

  it("treats INTERNAL and CONCURRENT_DUPLICATE as possibly in flight", () => {
    expect(isTransient(contract("INTERNAL"))).toBe(true);
    expect(isTransient(contract("CONCURRENT_DUPLICATE"))).toBe(true);
    expect(isTransient({ kind: "action", code: "INTERNAL" })).toBe(true);
    expect(isTransient(contract("OVER_REFUND"))).toBe(false);
    expect(isTransient({ kind: "action", code: "FORBIDDEN" })).toBe(false);
  });

  it("recognises stale-sale and approval problems", () => {
    expect(isStale(contract("OVER_REFUND"))).toBe(true);
    expect(isStale(contract("TOTAL_MISMATCH"))).toBe(true);
    expect(isStale(contract("NO_LINES"))).toBe(false);
    expect(isApprovalProblem(contract("APPROVAL_INVALID"))).toBe(true);
    expect(isApprovalProblem(contract("APPROVAL_REQUIRED"))).toBe(true);
    expect(isApprovalProblem(contract("OVER_REFUND"))).toBe(false);
  });

  it("looks the service's keys up first, then this UI's own texts", () => {
    expect(messageCandidates(contract("OVER_REFUND"))).toEqual([
      "refundErrors.refund.errors.OVER_REFUND",
      "refundErrors.OVER_REFUND",
      "refunds.issues.OVER_REFUND",
    ]);
    expect(messageCandidates({ kind: "action", code: "FORBIDDEN" })).toEqual(["errors.FORBIDDEN"]);
  });
});

describe("message coverage", () => {
  const codes = [...new Set([...REFUND_ERROR_CODES, ...VOID_ERROR_CODES])];

  it.each([
    ["mn", mn],
    ["en", en],
  ] as const)("%s has a text for every refund and void error code", (_locale, catalog) => {
    const issues = (catalog as unknown as { refunds: { issues: Record<string, string> } }).refunds
      .issues;
    for (const code of codes) expect(issues[code], code).toBeTruthy();
  });
});
