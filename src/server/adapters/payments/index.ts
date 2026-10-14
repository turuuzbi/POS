import "server-only";
import { createMockQpayProvider } from "./mock-qpay";
import type { PaymentProvider } from "./types";

export type { PaymentProvider } from "./types";
export { markMockInvoicePaid } from "./mock-qpay";

let provider: PaymentProvider | undefined;

/**
 * The configured payment provider. Only the mock exists today.
 * TODO(qpay): select a real adapter by PAYMENT_PROVIDER once its credentials
 * and contract are confirmed.
 */
export function getPaymentProvider(): PaymentProvider {
  return (provider ??= createMockQpayProvider());
}

/** Tests: swap the provider (pass null to restore the default). */
export function setPaymentProviderForTests(next: PaymentProvider | null): void {
  provider = next ?? undefined;
}
