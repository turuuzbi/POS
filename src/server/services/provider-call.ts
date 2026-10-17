import "server-only";
import { getPaymentProvider } from "../adapters/payments";
import type { ProviderRefund, RefundInput } from "../adapters/payments/types";

/**
 * Provider refunds run inside the caller's database transaction, so a hung
 * provider must not hold the sale / sequence / stock locks for long. After
 * this the call is abandoned, the caller rolls back and answers with a
 * retryable error; the provider idempotency key (`refund:<refundId>:<payment>`
 * / `void:<saleId>:<payment>`) makes the retry safe even if the abandoned call
 * did reach the provider.
 */
export const PROVIDER_REFUND_TIMEOUT_MS = 10_000;

let timeoutMs = PROVIDER_REFUND_TIMEOUT_MS;

/** Tests: shorten the deadline (pass null to restore the default). */
export function setProviderRefundTimeoutForTests(next: number | null): void {
  timeoutMs = next ?? PROVIDER_REFUND_TIMEOUT_MS;
}

export class ProviderTimeoutError extends Error {
  constructor() {
    super("payment provider refund timed out");
    this.name = "ProviderTimeoutError";
  }
}

export async function refundThroughProvider(input: RefundInput): Promise<ProviderRefund> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ProviderTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([getPaymentProvider().refund(input), deadline]);
  } finally {
    clearTimeout(timer);
  }
}
