import { handleQpayWebhookRequest } from "@/server/services/qpay-webhook";

export const dynamic = "force-dynamic";

/**
 * QPay callback. NEVER trusted: it needs the shared secret (QPAY_WEBHOOK_SECRET),
 * is throttled, and its only effect is that the server asks the provider about
 * an invoice that exists as a PENDING PaymentIntent and records the provider's
 * own answer. Authenticated calls always get the same empty 200. See
 * services/qpay-webhook.ts.
 *
 * TODO(qpay): the real callback format (GET ?payment_id=… vs POST body) once
 * the contract is confirmed.
 */
export async function POST(request: Request): Promise<Response> {
  return handleQpayWebhookRequest(request);
}

export async function GET(request: Request): Promise<Response> {
  return handleQpayWebhookRequest(request);
}
