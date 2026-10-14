/**
 * Payments taken so far for the sale being rung up. They live in the register
 * store (and the saved draft) rather than in the tender dialog, so a QPay
 * invoice that was paid, or is still waiting, survives Back, a rejected
 * checkout that closes the dialog, and a reload. A paid QPay intent is money
 * already taken: while one exists (or an invoice is open) the cart is locked.
 */
import { z } from "zod";
import type { Money } from "@/domain/money";
import type { QpayInvoice } from "@/domain/qpay";
import { MAX_TENDERS, TENDER_METHODS } from "@/domain/tender";
import type { TenderDraft } from "./charge";

export interface PendingInvoice {
  invoice: QpayInvoice;
  /** What the invoice was issued for. */
  amount: Money;
}

export interface PaymentState {
  tenders: TenderDraft[];
  /** The payable the tenders were taken against (non-QPAY tenders are dropped if it changes). */
  payable: Money | null;
  invoice: PendingInvoice | null;
}

export const EMPTY_PAYMENT: PaymentState = { tenders: [], payable: null, invoice: null };

export function isPaymentEmpty(p: PaymentState): boolean {
  return p.tenders.length === 0 && p.invoice === null;
}

/** Money is (or may be) already taken outside the register: the cart must not change. */
export function hasLockedPayment(p: PaymentState): boolean {
  return p.invoice !== null || p.tenders.some((t) => t.method === "QPAY");
}

export function addPaymentTender(p: PaymentState, tender: TenderDraft, payable: Money) {
  if (p.tenders.length >= MAX_TENDERS) return p;
  return { ...p, payable, tenders: [...p.tenders, tender] };
}

/** QPAY tenders are verified payments and cannot be removed. */
export function removePaymentTender(p: PaymentState, index: number): PaymentState {
  const tender = p.tenders[index];
  if (!tender || tender.method === "QPAY") return p;
  const tenders = p.tenders.filter((_, i) => i !== index);
  return tenders.length === 0 && p.invoice === null ? EMPTY_PAYMENT : { ...p, tenders };
}

export function setPaymentInvoice(p: PaymentState, invoice: PendingInvoice | null): PaymentState {
  return { ...p, invoice };
}

/** The cart changed: forget everything that is not locked by a real QPay payment. */
export function dropUnlockedPayment(p: PaymentState): PaymentState {
  return isPaymentEmpty(p) || hasLockedPayment(p) ? p : EMPTY_PAYMENT;
}

/** Before taking payment: tenders taken for a different amount no longer apply. */
export function reconcilePayment(p: PaymentState, payable: Money): PaymentState {
  if (isPaymentEmpty(p) || hasLockedPayment(p)) return p;
  return p.payable === payable ? p : EMPTY_PAYMENT;
}

// --- JSON (the saved draft) -------------------------------------------------------------

const money = z.string().regex(/^\d{1,15}$/);

export const paymentJsonSchema = z.object({
  tenders: z
    .array(
      z.object({
        method: z.enum(TENDER_METHODS),
        amount: money,
        tendered: money.optional(),
        reference: z.string().max(100).optional(),
        paymentIntentId: z.string().max(100).optional(),
      }),
    )
    .max(MAX_TENDERS),
  payable: money.nullable().optional(),
  invoice: z
    .object({
      amount: money,
      invoice: z.object({
        intentId: z.string().min(1).max(100),
        qrText: z.string().max(4000),
        deeplinks: z.array(z.object({ name: z.string(), link: z.string() })).max(20),
        expiresAt: z.string().nullable(),
      }),
    })
    .nullable()
    .optional(),
});

export type PaymentJson = z.input<typeof paymentJsonSchema>;

export function paymentToJson(p: PaymentState): PaymentJson {
  return {
    tenders: p.tenders.map((t) => ({
      method: t.method,
      amount: t.amount.toString(),
      ...(t.tendered !== undefined ? { tendered: t.tendered.toString() } : {}),
      ...(t.reference ? { reference: t.reference } : {}),
      ...(t.paymentIntentId ? { paymentIntentId: t.paymentIntentId } : {}),
    })),
    payable: p.payable === null ? null : p.payable.toString(),
    invoice: p.invoice ? { amount: p.invoice.amount.toString(), invoice: p.invoice.invoice } : null,
  };
}

export function paymentFromJson(json: unknown): PaymentState {
  const parsed = paymentJsonSchema.safeParse(json);
  if (!parsed.success) return EMPTY_PAYMENT;
  const d = parsed.data;
  return {
    tenders: d.tenders.map((t) => ({
      method: t.method,
      amount: BigInt(t.amount),
      ...(t.tendered !== undefined ? { tendered: BigInt(t.tendered) } : {}),
      ...(t.reference ? { reference: t.reference } : {}),
      ...(t.paymentIntentId ? { paymentIntentId: t.paymentIntentId } : {}),
    })),
    payable: d.payable == null ? null : BigInt(d.payable),
    invoice: d.invoice ? { amount: BigInt(d.invoice.amount), invoice: d.invoice.invoice } : null,
  };
}
