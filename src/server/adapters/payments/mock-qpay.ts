import "server-only";
import { randomUUID } from "node:crypto";
import { mockProvidersAllowed } from "../mock-guard";
import type {
  CreateInvoiceInput,
  PaymentProvider,
  ProviderInvoice,
  ProviderPaymentCheck,
  ProviderRefund,
  RefundInput,
} from "./types";

/**
 * Deterministic QPay stand-in for development, tests and e2e.
 *
 * The provider holds no database state: everything it needs is in the invoice
 * id it hands out, `mock_<amount>_<createdMs>_<nonce>`. An invoice becomes PAID when
 *   1. `markMockInvoicePaid(ref)` is called (the dev-only route
 *      /api/payments/qpay/mock-pay and the integration tests do), or
 *   2. MOCK_QPAY_AUTOPAY_SECONDS is set and that many seconds have passed since
 *      creation. In `next dev` the default is 5 so a developer can click
 *      through. Both paths are honoured ONLY when mock providers are allowed
 *      (not production, or ALLOW_MOCK_PROVIDERS=1; see ../mock-guard.ts), so a
 *      production deployment can never "receive" money that never arrived.
 * MOCK_QPAY_AUTOPAY_SECONDS=never disables auto-pay even in development.
 *
 * LIMITATION (dev / staging / e2e only): the state of `markMockInvoicePaid`
 * lives in this process (globalThis). That is what a single dev/e2e server
 * needs; on multi-instance or serverless hosting the instance that handled
 * mock-pay may not be the one that later checks the invoice. Auto-pay is
 * stateless (derived from the invoice id) and works across instances, so use
 * MOCK_QPAY_AUTOPAY_SECONDS on such a staging deploy.
 *
 * TODO(qpay): the real adapter (OAuth token, POST /v2/invoice, POST
 * /v2/payment/check, POST /v2/payment/refund, callback verification) replaces
 * this file; keep the PaymentProvider interface.
 */

const globalForMock = globalThis as unknown as {
  mockQpayPaid?: Map<string, { paidAt: Date }>;
  mockQpayRefunded?: Set<string>;
};
const paid = (globalForMock.mockQpayPaid ??= new Map());
const refunded = (globalForMock.mockQpayRefunded ??= new Set());

const REF = /^mock_(\d{1,15})_(\d{10,15})_([a-f0-9]{8})$/;

export function parseMockRef(ref: string): { amount: bigint; createdMs: number } | null {
  const m = REF.exec(ref);
  return m ? { amount: BigInt(m[1]!), createdMs: Number(m[2]) } : null;
}

/** Test/dev hook: the customer "paid" this invoice. Returns false for an unknown ref. */
export function markMockInvoicePaid(providerRef: string, at: Date = new Date()): boolean {
  if (!mockProvidersAllowed() || !parseMockRef(providerRef)) return false;
  paid.set(providerRef, { paidAt: at });
  return true;
}

function autoPaySeconds(): number | null {
  if (!mockProvidersAllowed()) return null;
  const raw = process.env.MOCK_QPAY_AUTOPAY_SECONDS;
  if (raw === "never") return null;
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return process.env.NODE_ENV === "development" ? 5 : null;
}

export function createMockQpayProvider(now: () => Date = () => new Date()): PaymentProvider {
  return {
    name: "mock",

    async createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice> {
      const created = now();
      const providerRef = `mock_${input.amount}_${created.getTime()}_${randomUUID().slice(0, 8)}`;
      const expiresAt = new Date(created.getTime() + input.expiresInSeconds * 1000);
      return {
        providerRef,
        qrText: `MOCKQPAY:${providerRef}`,
        deeplinks: [
          { name: "Mock bank", link: `mockbank://pay?invoice=${providerRef}` },
          { name: "Mock wallet", link: `mockwallet://pay?invoice=${providerRef}` },
        ],
        expiresAt,
        raw: { mock: true, senderInvoiceNo: input.intentId, saleId: input.saleId },
      };
    },

    async checkPayment(providerRef: string): Promise<ProviderPaymentCheck> {
      const parsed = parseMockRef(providerRef);
      if (!parsed) return { status: "FAILED", raw: { mock: true, error: "unknown invoice" } };
      const current = now();
      let marked = paid.get(providerRef)?.paidAt;
      const auto = autoPaySeconds();
      if (!marked && auto !== null && current.getTime() >= parsed.createdMs + auto * 1000) {
        marked = new Date(parsed.createdMs + auto * 1000);
      }
      if (refunded.has(providerRef)) {
        return { status: "CANCELLED", raw: { mock: true, refunded: true } };
      }
      if (!marked) return { status: "PENDING", raw: { mock: true } };
      return {
        status: "PAID",
        paidAmount: parsed.amount,
        paidAt: marked,
        paymentRef: `mockpay_${providerRef.slice(-8)}`,
        raw: { mock: true, paidAt: marked.toISOString() },
      };
    },

    async refund(input: RefundInput): Promise<ProviderRefund> {
      const parsed = parseMockRef(input.providerRef);
      if (!parsed || !paid.has(input.providerRef) || input.amount > parsed.amount) {
        return { status: "FAILED", raw: { mock: true } };
      }
      refunded.add(input.providerRef);
      return {
        status: "REFUNDED",
        refundRef: `mockrefund_${input.providerRef.slice(-8)}`,
        raw: { mock: true, amount: input.amount.toString() },
      };
    },
  };
}
