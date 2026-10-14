/**
 * The register's side of the checkout contract: build the CheckoutInput from
 * the cart and tenders, send it (retrying a lost response with the SAME
 * input, hence the same saleId) and interpret the answer.
 */
import type { Cart } from "@/domain/cart";
import {
  CHECKOUT_ERROR_CODES,
  checkoutInputSchema,
  checkoutResultSchema,
  discountToWire,
  lineIntentsFromCart,
  type CheckoutInputWire,
  type CheckoutResult,
} from "@/domain/checkout-contract";
import type { Money } from "@/domain/money";
import type { Tender } from "@/domain/tender";
import type { ActionErrorCode, ActionResult } from "@/server/actions/define-action";

export interface TenderDraft extends Tender {
  /** QPAY: the verified PaymentIntent. */
  paymentIntentId?: string;
}

export function tenderToWire(tender: TenderDraft): CheckoutInputWire["tenders"][number] {
  return {
    method: tender.method,
    amount: tender.amount.toString(),
    ...(tender.method === "CASH" && tender.tendered !== undefined
      ? { tendered: tender.tendered.toString() }
      : {}),
    ...(tender.reference ? { reference: tender.reference } : {}),
    ...(tender.paymentIntentId ? { paymentIntentId: tender.paymentIntentId } : {}),
  };
}

export interface BuildInput {
  saleId: string;
  cart: Cart;
  tenders: readonly TenderDraft[];
  expectedPayable: Money;
  approvals: Record<string, string>;
  note?: string;
  now?: Date;
}

/** Wire input for `checkoutAction`; money as decimal möngö strings. */
export function buildCheckoutInput(input: BuildInput): CheckoutInputWire {
  return {
    saleId: input.saleId,
    lines: lineIntentsFromCart(input.cart),
    cartDiscounts: input.cart.discounts.map(discountToWire),
    tenders: input.tenders.map(tenderToWire),
    expectedPayable: input.expectedPayable.toString(),
    approvals: input.approvals,
    ...(input.note ? { note: input.note } : {}),
    createdAtClient: (input.now ?? new Date()).toISOString(),
  };
}

/** Local pre-flight with the same schema the server uses. */
export function validateCheckoutInput(wire: CheckoutInputWire): boolean {
  return checkoutInputSchema.safeParse(wire).success;
}

// --- Failure mapping -----------------------------------------------------------------

const KNOWN_CODES = new Set<string>([...CHECKOUT_ERROR_CODES, "TENDER_NOT_AVAILABLE"]);
const CHECKOUT_FIELD = "checkout";
const CHECKOUT_DETAILS_FIELD = "checkout.details";

export interface CheckoutFailureView {
  code: string;
  details?: Record<string, unknown>;
}

/** The checkout code the service put in `fieldErrors.checkout[0]`, if any. */
export function checkoutFailureFromAction(failure: {
  fieldErrors?: Record<string, string[]>;
}): CheckoutFailureView | null {
  const code = failure.fieldErrors?.[CHECKOUT_FIELD]?.[0];
  if (!code || !KNOWN_CODES.has(code)) return null;
  let details: Record<string, unknown> | undefined;
  const raw = failure.fieldErrors?.[CHECKOUT_DETAILS_FIELD]?.[0];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") details = parsed as Record<string, unknown>;
    } catch {
      details = undefined;
    }
  }
  return { code, ...(details ? { details } : {}) };
}

export type ChargeOutcome =
  /** `attempts` > 1: an earlier attempt got no usable answer, so `result.replayed` may be our own sale. */
  | { ok: true; result: CheckoutResult; attempts: number }
  /** The server answered with a checkout error code. */
  | { ok: false; kind: "checkout"; code: string; details?: Record<string, unknown> }
  /** A generic action failure (not signed in, validation, internal …). */
  | { ok: false; kind: "action"; code: ActionErrorCode }
  /** No usable answer after the retries: the sale may or may not exist. */
  | { ok: false; kind: "unknown" };

export interface ChargeOptions {
  maxAttempts?: number;
  /** Delay before attempt n+1 (ms). */
  delays?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
}

const RETRYABLE_CHECKOUT = new Set(["CONCURRENT_DUPLICATE"]);

/**
 * Send the checkout. A thrown error (network down, response lost) or an
 * INTERNAL answer is retried with the identical input: the server treats the
 * repeated saleId as a replay, so a retry can never double-charge.
 */
export async function submitCheckout(
  call: (input: CheckoutInputWire) => Promise<ActionResult<unknown>>,
  input: CheckoutInputWire,
  options: ChargeOptions = {},
): Promise<ChargeOutcome> {
  const { maxAttempts = 3, delays = [500, 1500], sleep = defaultSleep } = options;
  let lastWasFailure: ChargeOutcome = { ok: false, kind: "unknown" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: ActionResult<unknown> | undefined;
    try {
      response = await call(input);
    } catch {
      response = undefined; // network error: the sale may have committed
      lastWasFailure = { ok: false, kind: "unknown" };
    }
    if (response?.ok) {
      const parsed = checkoutResultSchema.safeParse(response.data);
      if (parsed.success) return { ok: true, result: parsed.data, attempts: attempt };
      lastWasFailure = { ok: false, kind: "unknown" };
    } else if (response) {
      const view = checkoutFailureFromAction(response.error);
      if (view) {
        if (!RETRYABLE_CHECKOUT.has(view.code)) {
          return {
            ok: false,
            kind: "checkout",
            code: view.code,
            ...(view.details ? { details: view.details } : {}),
          };
        }
        lastWasFailure = { ok: false, kind: "checkout", code: view.code };
      } else if (response.error.code !== "INTERNAL") {
        return { ok: false, kind: "action", code: response.error.code };
      } else {
        lastWasFailure = { ok: false, kind: "action", code: "INTERNAL" };
      }
    }
    if (attempt < maxAttempts) await sleep(delays[Math.min(attempt - 1, delays.length - 1)] ?? 500);
  }
  // INTERNAL and CONCURRENT_DUPLICATE that outlast the retries are NOT definitive:
  // the sale may be committing (or committed) under this saleId, so the caller
  // must keep the wire and the cart locked, exactly like a lost response.
  return lastWasFailure.kind === "checkout" || lastWasFailure.kind === "action"
    ? { ok: false, kind: "unknown" }
    : lastWasFailure;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delay before the next QPay status check: gentle exponential backoff, capped. */
export function qpayPollDelay(attempt: number): number {
  return Math.min(1500 * 1.35 ** Math.max(0, attempt), 8000);
}
