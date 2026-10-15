import type { QpayStatus } from "@/domain/qpay";

/**
 * Asynchronous payment provider (QPay). The webhook is never trusted:
 * the server only ever believes `checkPayment` answers.
 */

export interface CreateInvoiceInput {
  /** Our PaymentIntent id (the provider's sender invoice number). */
  intentId: string;
  /** Client sale id the invoice is for. */
  saleId: string;
  /** möngö */
  amount: bigint;
  description: string;
  /** Invoice lifetime. */
  expiresInSeconds: number;
}

export interface ProviderInvoice {
  /** Provider's invoice id; unique per provider. */
  providerRef: string;
  qrText: string;
  deeplinks: { name: string; link: string }[];
  expiresAt: Date | null;
  raw: Record<string, unknown>;
}

export interface ProviderPaymentCheck {
  status: QpayStatus;
  /** möngö actually paid (PAID only). */
  paidAmount?: bigint;
  paidAt?: Date;
  /** Provider's payment id, kept as the SalePayment reference. */
  paymentRef?: string;
  raw: Record<string, unknown>;
}

export interface RefundInput {
  providerRef: string;
  amount: bigint;
  reason?: string;
  /** Retries with the same key must not refund twice (our refund id + payment id). */
  idempotencyKey?: string;
}

export interface ProviderRefund {
  status: "REFUNDED" | "FAILED";
  refundRef?: string;
  raw: Record<string, unknown>;
}

export interface PaymentProvider {
  /** Stored in PaymentIntent.provider. */
  readonly name: string;
  createInvoice(input: CreateInvoiceInput): Promise<ProviderInvoice>;
  checkPayment(providerRef: string): Promise<ProviderPaymentCheck>;
  refund(input: RefundInput): Promise<ProviderRefund>;
}
