import { v7 as uuidv7 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import { checkoutInputSchema, toWire, type CheckoutInputWire } from "@/domain/checkout-contract";
import type { ActionResult } from "@/server/actions/define-action";
import {
  buildCheckoutInput,
  checkoutFailureFromAction,
  qpayPollDelay,
  submitCheckout,
} from "./charge";

const saleId = uuidv7();
const lineId = "0b0f5b6e-9a4b-4f0b-8f6a-5b0e8f7d7e11";
const variantId = "6f1c2a52-3a9d-4b71-bb9c-0a51c2c4a0d1";

const wire = (): CheckoutInputWire =>
  buildCheckoutInput({
    saleId,
    cart: {
      lines: [
        {
          lineId,
          variantId,
          qtyMilli: 2000,
          unitPrice: 500_000n,
          discounts: [{ kind: "PERCENT", percentBps: 500 }],
          note: "gift",
        },
        {
          lineId: "9d8c7b6a-5f4e-4d3c-8b2a-1a0b9c8d7e6f",
          variantId,
          qtyMilli: 1000,
          unitPrice: 1n,
          discounts: [],
          voided: true,
        },
      ],
      discounts: [{ kind: "FIXED", amount: 10_000n }],
    },
    tenders: [{ method: "CASH", amount: 940_000n, tendered: 1_000_000n }],
    expectedPayable: 940_000n,
    approvals: { "cart:discount:0": "tok" },
    now: new Date("2026-10-14T05:00:00Z"),
  });

const result = {
  saleId,
  receiptNumber: "R1-000042",
  status: "COMPLETED",
  totals: {
    subtotal: 1_000_000n,
    discountTotal: 60_000n,
    netTotal: 854_546n,
    vatTotal: 85_454n,
    cityTotal: 0n,
    total: 940_000n,
    roundingAmount: 0n,
    payable: 940_000n,
  },
  payments: [{ method: "CASH", amount: 940_000n, tendered: 1_000_000n, change: 60_000n }],
  change: 60_000n,
  shareToken: "share-token",
  replayed: false,
};

const failure = (
  fieldErrors: Record<string, string[]>,
  code = "INVALID_STATE",
): ActionResult<unknown> => ({ ok: false, error: { code, fieldErrors } }) as ActionResult<unknown>;

const noSleep = { sleep: async () => {} };

describe("buildCheckoutInput", () => {
  it("produces input the server's own schema accepts, without voided lines", () => {
    const input = wire();
    const parsed = checkoutInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.lines).toHaveLength(1);
    expect(parsed.data?.saleId).toBe(saleId);
    expect(parsed.data?.expectedPayable).toBe(940_000n);
    expect(parsed.data?.cartDiscounts[0]).toMatchObject({ kind: "FIXED", amount: 10_000n });
    expect(parsed.data?.tenders[0]).toMatchObject({
      method: "CASH",
      amount: 940_000n,
      tendered: 1_000_000n,
    });
    expect(parsed.data?.approvals).toEqual({ "cart:discount:0": "tok" });
  });

  it("is JSON-safe (money as strings)", () => {
    expect(() => JSON.stringify(wire())).not.toThrow();
  });
});

describe("submitCheckout", () => {
  it("returns the parsed result on success", async () => {
    const call = vi.fn(async () => ({ ok: true as const, data: toWire(result) }));
    const outcome = await submitCheckout(call, wire(), noSleep);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.result.change).toBe(60_000n);
      expect(outcome.result.totals.payable).toBe(940_000n);
      expect(outcome.result.receiptNumber).toBe("R1-000042");
    }
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries a lost response with the SAME input and sale id, never a new one", async () => {
    const input = wire();
    const seen: string[] = [];
    let n = 0;
    const call = vi.fn(async (sent: CheckoutInputWire) => {
      seen.push(sent.saleId);
      if (++n < 3) throw new TypeError("network down");
      return { ok: true as const, data: toWire({ ...result, replayed: true }) };
    });
    const outcome = await submitCheckout(call, input, noSleep);
    expect(outcome.ok).toBe(true);
    expect(call).toHaveBeenCalledTimes(3);
    expect(new Set(seen)).toEqual(new Set([saleId]));
    expect(call.mock.calls.every(([sent]) => sent === input)).toBe(true);
  });

  it("reports an unknown outcome after the last failed attempt", async () => {
    const call = vi.fn(async () => {
      throw new Error("offline");
    });
    const outcome = await submitCheckout(call, wire(), { ...noSleep, maxAttempts: 2 });
    expect(outcome).toEqual({ ok: false, kind: "unknown" });
    expect(call).toHaveBeenCalledTimes(2);
  });

  it("retries INTERNAL but not a definite checkout error", async () => {
    const internal = vi.fn(async () => ({
      ok: false as const,
      error: { code: "INTERNAL" as const },
    }));
    expect(await submitCheckout(internal, wire(), noSleep)).toEqual({
      ok: false,
      kind: "action",
      code: "INTERNAL",
    });
    expect(internal).toHaveBeenCalledTimes(3);

    const stale = vi.fn(async () =>
      failure({
        checkout: ["STALE_PRICE"],
        "checkout.details": [JSON.stringify({ lineId })],
      }),
    );
    const outcome = await submitCheckout(stale, wire(), noSleep);
    expect(outcome).toEqual({
      ok: false,
      kind: "checkout",
      code: "STALE_PRICE",
      details: { lineId },
    });
    expect(stale).toHaveBeenCalledTimes(1);
  });

  it("does not retry authorisation failures", async () => {
    const call = vi.fn(async () => ({ ok: false as const, error: { code: "FORBIDDEN" as const } }));
    expect(await submitCheckout(call, wire(), noSleep)).toEqual({
      ok: false,
      kind: "action",
      code: "FORBIDDEN",
    });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("treats an unparsable success body as unknown, not as a sale", async () => {
    const call = vi.fn(async () => ({ ok: true as const, data: { nope: true } }));
    expect(await submitCheckout(call, wire(), { ...noSleep, maxAttempts: 1 })).toEqual({
      ok: false,
      kind: "unknown",
    });
  });
});

describe("checkoutFailureFromAction", () => {
  it("reads the code and details the service puts in fieldErrors", () => {
    expect(
      checkoutFailureFromAction({
        fieldErrors: { checkout: ["TOTAL_MISMATCH"], "checkout.details": ['{"expected":"1"}'] },
      }),
    ).toEqual({ code: "TOTAL_MISMATCH", details: { expected: "1" } });
  });

  it("returns null for anything else", () => {
    expect(checkoutFailureFromAction({})).toBeNull();
    expect(checkoutFailureFromAction({ fieldErrors: { checkout: ["MADE_UP"] } })).toBeNull();
    expect(
      checkoutFailureFromAction({
        fieldErrors: { checkout: ["STALE_PRICE"], "checkout.details": ["{bad"] },
      }),
    ).toEqual({ code: "STALE_PRICE" });
  });
});

describe("qpayPollDelay", () => {
  it("backs off and caps", () => {
    const delays = [0, 1, 2, 3, 4, 5, 10, 50].map(qpayPollDelay);
    expect(delays[0]).toBe(1500);
    for (let i = 1; i < delays.length; i++)
      expect(delays[i]!).toBeGreaterThanOrEqual(delays[i - 1]!);
    expect(delays.at(-1)).toBe(8000);
  });
});
