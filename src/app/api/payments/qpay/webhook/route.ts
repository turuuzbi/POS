import { handleQpayWebhook } from "@/server/services/payments";

export const dynamic = "force-dynamic";

/**
 * QPay callback. NEVER trusted: whatever the body or query says, the only
 * effect is that the server asks the provider about the invoice and records
 * the provider's own answer (syncPaymentIntent). Always answers 200 with the
 * same body, so the endpoint reveals nothing about which invoices exist.
 *
 * TODO(qpay): the real callback format (GET ?payment_id=… vs POST body) and
 * any shared-secret / allow-list check, once the contract is confirmed.
 */
async function trigger(providerRef: string | null): Promise<Response> {
  if (providerRef && providerRef.length <= 200) {
    try {
      await handleQpayWebhook(providerRef);
    } catch (error) {
      console.error("[qpay webhook] status check failed", error);
    }
  }
  return Response.json({ ok: true });
}

export async function POST(request: Request): Promise<Response> {
  let providerRef: string | null = null;
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>;
      const candidate = record.providerRef ?? record.invoice_id ?? record.object_id;
      if (typeof candidate === "string") providerRef = candidate;
    }
  } catch {
    // unparsable body: nothing to check
  }
  return trigger(providerRef);
}

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  return trigger(params.get("providerRef") ?? params.get("invoice_id"));
}
