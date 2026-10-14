import "server-only";
import { assertMockProvidersAllowed } from "../mock-guard";
import { createMockQpayProvider } from "./mock-qpay";
import type { PaymentProvider } from "./types";

export type { PaymentProvider } from "./types";
export { markMockInvoicePaid } from "./mock-qpay";

let override: PaymentProvider | undefined;
let mock: PaymentProvider | undefined;

/**
 * The configured payment provider. Only the mock exists today, and it fails
 * closed in production unless ALLOW_MOCK_PROVIDERS=1 (see mock-guard.ts).
 * TODO(qpay): select a real adapter by PAYMENT_PROVIDER once its credentials
 * and contract are confirmed.
 */
export function getPaymentProvider(): PaymentProvider {
  if (override) return override;
  assertMockProvidersAllowed("payment (QPay)");
  return (mock ??= createMockQpayProvider());
}

/** Tests: swap the provider (pass null to restore the default). */
export function setPaymentProviderForTests(next: PaymentProvider | null): void {
  override = next ?? undefined;
}
