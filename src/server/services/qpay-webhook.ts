import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { handleQpayWebhook } from "./payments";

/**
 * The QPay callback endpoint's logic (the route file only forwards).
 *
 * The callback is a hint, never evidence: a request that passes every check
 * here only makes the server ask the provider about an invoice that exists as
 * a PENDING PaymentIntent in our database (handleQpayWebhook). Checks, in order:
 *   1. shared secret (QPAY_WEBHOOK_SECRET; unset = every call is rejected,
 *      mock mode included), compared in constant time,
 *   2. payload shape (a plain invoice id, nothing else is looked at),
 *   3. in-process throttle per invoice id and per client IP.
 * Every request that passes the secret check gets the same empty 200,
 * whether or not the invoice exists, so the endpoint cannot be used to
 * enumerate invoices.
 */

const REF = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_BODY_BYTES = 4096;

export const WEBHOOK_LIMITS = {
  windowMs: 60_000,
  perRef: 6,
  perIp: 60,
  /** Bound on tracked keys so a flood of random refs cannot grow memory. */
  maxKeys: 5000,
} as const;

const hits = new Map<string, { windowStart: number; count: number }>();

/** True when this key is within `limit` hits for the current window (and counts the hit). */
function allow(key: string, limit: number, now: number): boolean {
  const entry = hits.get(key);
  if (!entry || now - entry.windowStart >= WEBHOOK_LIMITS.windowMs) {
    if (hits.size >= WEBHOOK_LIMITS.maxKeys) {
      for (const [k, v] of hits) {
        if (now - v.windowStart >= WEBHOOK_LIMITS.windowMs) hits.delete(k);
      }
      if (hits.size >= WEBHOOK_LIMITS.maxKeys) hits.clear();
    }
    hits.set(key, { windowStart: now, count: 1 });
    return true;
  }
  entry.count += 1;
  return entry.count <= limit;
}

/** Tests: forget all throttle state. */
export function resetQpayWebhookThrottleForTests(): void {
  hits.clear();
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function secretMatches(request: Request, url: URL): boolean {
  const expected = process.env.QPAY_WEBHOOK_SECRET;
  if (!expected) return false;
  const auth = request.headers.get("authorization");
  const presented =
    request.headers.get("x-webhook-secret") ??
    (auth?.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : null) ??
    url.searchParams.get("token");
  if (!presented) return false;
  return timingSafeEqual(digest(presented), digest(expected));
}

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

async function extractRef(request: Request, url: URL): Promise<string | null> {
  let candidate: unknown;
  if (request.method === "GET") {
    candidate = url.searchParams.get("providerRef") ?? url.searchParams.get("invoice_id");
  } else {
    try {
      const text = await request.text();
      if (text.length > MAX_BODY_BYTES) return null;
      const body: unknown = JSON.parse(text);
      if (body && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        candidate = record.providerRef ?? record.invoice_id ?? record.object_id;
      }
    } catch {
      return null;
    }
  }
  return typeof candidate === "string" && REF.test(candidate) ? candidate : null;
}

export async function handleQpayWebhookRequest(
  request: Request,
  now: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  if (!secretMatches(request, url)) return new Response(null, { status: 401 });

  const ok = new Response(null, { status: 200 });
  if (!allow(`ip:${clientIp(request)}`, WEBHOOK_LIMITS.perIp, now)) return ok;
  const providerRef = await extractRef(request, url);
  if (!providerRef || !allow(`ref:${providerRef}`, WEBHOOK_LIMITS.perRef, now)) return ok;
  try {
    await handleQpayWebhook(providerRef);
  } catch (error) {
    console.error("[qpay webhook] status check failed", error);
  }
  return ok;
}
