import { describe, expect, it, vi } from "vitest";
import type { ActionResult } from "@/server/actions/define-action";
import { submitRefund, submitVoid } from "./submit";
import type { RefundInputWire } from "@/domain/refund-contract";
import type { VoidInputWire } from "./void";

const refundResult = {
  refundId: "01900000-0000-7000-8000-000000000032",
  receiptNumber: "UB1-R-000001",
  saleId: "01900000-0000-7000-8000-000000000001",
  totals: {
    itemsTotal: "500000",
    netAmount: "454545",
    vatAmount: "45455",
    cityTaxAmount: "0",
    tipAmount: "0",
    roundingAmount: "0",
    totalAmount: "500000",
  },
  lines: [
    {
      saleLineId: "01900000-0000-7000-8000-000000000011",
      qtyMilli: 1000,
      restock: true,
      totalAmount: "500000",
    },
  ],
  payments: [{ method: "CASH", amount: "500000", originalPaymentId: null }],
  cashRefund: "500000",
  exchange: null,
  completesSale: false,
  replayed: false,
};

const input = { refundId: refundResult.refundId } as unknown as RefundInputWire;
const noSleep = { sleep: async () => {} };
const ok = (data: unknown): ActionResult<unknown> => ({ ok: true, data });
const fail = (
  code: "INTERNAL" | "VALIDATION" | "FORBIDDEN",
  fieldErrors?: Record<string, string[]>,
): ActionResult<unknown> => ({
  ok: false,
  error: { code, ...(fieldErrors ? { fieldErrors } : {}) },
});

describe("submitRefund", () => {
  it("parses a good answer into bigint money", async () => {
    const call = vi.fn().mockResolvedValue(ok(refundResult));
    const outcome = await submitRefund(call, input, noSleep);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.cashRefund).toBe(500_000n);
      expect(outcome.attempts).toBe(1);
    }
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries the IDENTICAL input after a network error and succeeds", async () => {
    const call = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(ok({ ...refundResult, replayed: true }));
    const outcome = await submitRefund(call, input, noSleep);
    expect(outcome.ok && outcome.attempts).toBe(2);
    expect(call.mock.calls[0]![0]).toBe(call.mock.calls[1]![0]);
  });

  it("stops at a definitive refusal without retrying", async () => {
    const call = vi.fn().mockResolvedValue(fail("VALIDATION", { refund: ["OVER_REFUND"] }));
    const outcome = await submitRefund(call, input, noSleep);
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ ok: false, kind: "failure" });
    if (!outcome.ok && outcome.kind === "failure") {
      expect(outcome.view).toMatchObject({ kind: "contract", code: "OVER_REFUND" });
    }
  });

  it("calls a persistent INTERNAL or unreadable answer UNKNOWN, never a failure", async () => {
    const internal = vi.fn().mockResolvedValue(fail("INTERNAL"));
    expect(await submitRefund(internal, input, noSleep)).toEqual({ ok: false, kind: "unknown" });
    expect(internal).toHaveBeenCalledTimes(3);
    const garbage = vi.fn().mockResolvedValue(ok({ nope: true }));
    expect(await submitRefund(garbage, input, noSleep)).toEqual({ ok: false, kind: "unknown" });
    const down = vi.fn().mockRejectedValue(new Error("down"));
    expect(await submitRefund(down, input, noSleep)).toEqual({ ok: false, kind: "unknown" });
  });

  it("does not retry a plain FORBIDDEN", async () => {
    const call = vi.fn().mockResolvedValue(fail("FORBIDDEN"));
    const outcome = await submitRefund(call, input, noSleep);
    expect(call).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      ok: false,
      kind: "failure",
      view: { kind: "action", code: "FORBIDDEN" },
    });
  });
});

describe("submitVoid", () => {
  it("parses a void result", async () => {
    const call = vi.fn().mockResolvedValue(
      ok({
        saleId: "01900000-0000-7000-8000-000000000001",
        receiptNumber: "UB1-000123",
        totalAmount: "1850200",
        cashReturned: "850200",
        replayed: false,
      }),
    );
    const outcome = await submitVoid(call, {} as VoidInputWire, noSleep);
    expect(outcome.ok && outcome.result.cashReturned).toBe(850_200n);
  });
});
