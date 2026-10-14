import { mockProvidersAllowed } from "@/server/adapters/mock-guard";
import { markMockInvoicePaid } from "@/server/adapters/payments";
import { can, getCurrentUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { syncPaymentIntent } from "@/server/services/payments";

export const dynamic = "force-dynamic";

/**
 * DEV/TEST ONLY: pretend the customer paid a mock QPay invoice, so a flow can
 * be completed without a bank app. Disabled (404) in production unless
 * ALLOW_MOCK_PROVIDERS=1 (staging); on multi-instance hosting the in-memory
 * paid flag may land on another instance, use MOCK_QPAY_AUTOPAY_SECONDS there;
 * requires a signed-in user who may sell. The payment still has to be
 * confirmed through the normal server-side check, which this route runs.
 * Body: { "intentId": "<PaymentIntent id>" }.
 */
export async function POST(request: Request): Promise<Response> {
  if (!mockProvidersAllowed()) return new Response(null, { status: 404 });
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  if (!can(user, "pos.sell")) return new Response(null, { status: 403 });

  let intentId: unknown;
  try {
    intentId = ((await request.json()) as { intentId?: unknown }).intentId;
  } catch {
    return new Response(null, { status: 400 });
  }
  if (typeof intentId !== "string" || !/^[0-9a-f-]{36}$/i.test(intentId)) {
    return new Response(null, { status: 400 });
  }
  const intent = await db.paymentIntent.findUnique({
    where: { id: intentId },
    select: { providerRef: true, provider: true },
  });
  if (!intent?.providerRef || intent.provider !== "mock") {
    return new Response(null, { status: 404 });
  }
  markMockInvoicePaid(intent.providerRef);
  const result = await syncPaymentIntent(intentId);
  return Response.json({ status: result?.status ?? null });
}
