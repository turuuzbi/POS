import { describe, expect, it } from "vitest";
import { toWire } from "./checkout-contract";
import {
  VOID_ERROR_CODES,
  VOID_ERROR_MESSAGE_KEYS,
  isSameVoid,
  isVoidApprovalScope,
  voidApprovalScope,
  voidErrorFromIssues,
  voidFingerprint,
  voidInputSchema,
  voidResultSchema,
} from "./void-contract";

const SALE = "01900000-0000-7000-8000-000000000002";
const input = (extra: Record<string, unknown> = {}) =>
  voidInputSchema.parse({
    saleId: SALE,
    reason: "ENTRY_ERROR",
    createdAtClient: "2026-10-15T10:00:00Z",
    ...extra,
  });

describe("void contract", () => {
  it("validates input", () => {
    expect(input().approvals).toEqual({});
    for (const bad of [{ reason: "BORED" }, { saleId: "nope" }, { note: "x".repeat(501) }]) {
      expect(
        voidInputSchema.safeParse({
          saleId: SALE,
          reason: "ENTRY_ERROR",
          createdAtClient: "2026-10-15T10:00:00Z",
          ...bad,
        }).success,
      ).toBe(false);
    }
  });
  it("error codes and key map", () => {
    for (const c of VOID_ERROR_CODES) expect(VOID_ERROR_MESSAGE_KEYS[c]).toBe(`void.errors.${c}`);
    expect(VOID_ERROR_CODES).toContain("VOID_NOT_ALLOWED");
    expect(voidErrorFromIssues([{ code: "HAS_REFUNDS" }]).code).toBe("ALREADY_REFUNDED");
    expect(voidErrorFromIssues([{ code: "SALE_NOT_COMPLETED" }]).code).toBe("ALREADY_VOIDED");
    expect(voidErrorFromIssues([{ code: "SALE_IN_OTHER_SHIFT" }]).code).toBe("SALE_IN_OTHER_SHIFT");
    expect(voidErrorFromIssues([]).code).toBe("VOID_NOT_ALLOWED");
  });
  it("fingerprint ignores approvals and clock", () => {
    const a = input();
    const b = input({ approvals: { void: "t" }, createdAtClient: "2030-01-01T00:00:00Z" });
    expect(voidFingerprint(a)).toBe(voidFingerprint(b));
    expect(isSameVoid(voidFingerprint(a), b)).toBe(true);
    expect(voidFingerprint(input({ reason: "OTHER", note: "x" }))).not.toBe(voidFingerprint(a));
  });
  it("approval scope is bound to sale and amount", () => {
    const s = voidApprovalScope(SALE, 1_500_000n);
    expect(s).toBe(`${SALE}:void:1500000`);
    expect(isVoidApprovalScope(s)).toBe(true);
    expect(voidApprovalScope(SALE, 1_500_001n)).not.toBe(s);
    expect(isVoidApprovalScope(SALE)).toBe(false);
  });
  it("result round-trips", () => {
    const r = {
      saleId: SALE,
      receiptNumber: "UB1-1",
      totalAmount: 5n,
      cashReturned: 5n,
      replayed: false,
    };
    expect(voidResultSchema.parse(JSON.parse(JSON.stringify(toWire(r))))).toEqual(r);
  });
});
