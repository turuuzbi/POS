import { describe, expect, it } from "vitest";
import {
  EMPTY_PAYMENT,
  addPaymentTender,
  dropUnlockedPayment,
  hasLockedPayment,
  paymentFromJson,
  paymentToJson,
  reconcilePayment,
  removePaymentTender,
  setPaymentInvoice,
  type PaymentState,
} from "./payment-state";

const invoice = {
  intentId: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b",
  qrText: "qpay://x",
  deeplinks: [{ name: "Khan", link: "khan://pay" }],
  expiresAt: null,
};
const cash = { method: "CASH" as const, amount: 500_000n, tendered: 1_000_000n };
const qpay = { method: "QPAY" as const, amount: 700_000n, paymentIntentId: invoice.intentId };

describe("payment state", () => {
  it("a paid QPay tender or an open invoice locks the cart; cash does not", () => {
    expect(hasLockedPayment(addPaymentTender(EMPTY_PAYMENT, cash, 1_200_000n))).toBe(false);
    expect(hasLockedPayment(addPaymentTender(EMPTY_PAYMENT, qpay, 700_000n))).toBe(true);
    expect(hasLockedPayment(setPaymentInvoice(EMPTY_PAYMENT, { invoice, amount: 1n }))).toBe(true);
  });

  it("a cart change forgets cash but never a QPay payment", () => {
    const withCash = addPaymentTender(EMPTY_PAYMENT, cash, 500_000n);
    expect(dropUnlockedPayment(withCash)).toEqual(EMPTY_PAYMENT);
    const withQpay = addPaymentTender(withCash, qpay, 500_000n);
    expect(dropUnlockedPayment(withQpay)).toBe(withQpay);
  });

  it("tenders taken for another payable are dropped, locked ones kept", () => {
    const withCash = addPaymentTender(EMPTY_PAYMENT, cash, 500_000n);
    expect(reconcilePayment(withCash, 500_000n)).toBe(withCash);
    expect(reconcilePayment(withCash, 600_000n)).toEqual(EMPTY_PAYMENT);
    const withQpay = addPaymentTender(EMPTY_PAYMENT, qpay, 700_000n);
    expect(reconcilePayment(withQpay, 600_000n)).toBe(withQpay);
  });

  it("QPay tenders cannot be removed", () => {
    const both = addPaymentTender(addPaymentTender(EMPTY_PAYMENT, qpay, 1n), cash, 1n);
    expect(removePaymentTender(both, 0)).toBe(both);
    expect(removePaymentTender(both, 1).tenders).toEqual([qpay]);
  });

  it("survives a reload: JSON round-trip keeps paid intents and the open invoice", () => {
    const state: PaymentState = {
      tenders: [qpay, cash],
      payable: 1_200_000n,
      invoice: { invoice, amount: 500_000n },
    };
    const json = JSON.parse(JSON.stringify(paymentToJson(state)));
    expect(paymentFromJson(json)).toEqual(state);
    expect(paymentFromJson({ tenders: "nope" })).toEqual(EMPTY_PAYMENT);
  });
});
