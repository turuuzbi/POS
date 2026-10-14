/**
 * How a checkout failure travels through the generic action envelope
 * (`ActionResult` / `ActionFailure`), whose `code` set is fixed:
 *
 *   { ok: false, error: { code, fieldErrors: {
 *       checkout: ["STALE_PRICE"],                       // CheckoutErrorCode
 *       "checkout.details": ['{"lineId":"…"}']           // optional JSON
 *   } } }
 *
 * The register UI reads it with `checkoutCodeFromFailure`, translates
 * `checkout.errors.<CODE>` and may use the details (line ids, amounts as
 * decimal strings) to point at the offending line.
 */
import { CHECKOUT_ERROR_CODES, type CheckoutErrorCode } from "./checkout-contract";

/** Extra code of this slice: a tender method that is not built yet (gift card, store credit). */
export const EXTRA_CHECKOUT_CODES = ["TENDER_NOT_AVAILABLE"] as const;
export type CheckoutFailureCode = CheckoutErrorCode | (typeof EXTRA_CHECKOUT_CODES)[number];

export const CHECKOUT_FAILURE_FIELD = "checkout";
export const CHECKOUT_FAILURE_DETAILS_FIELD = "checkout.details";

const KNOWN = new Set<string>([...CHECKOUT_ERROR_CODES, ...EXTRA_CHECKOUT_CODES]);

export interface CheckoutFailureView {
  code: CheckoutFailureCode;
  /** i18n key in the `checkout` namespace, e.g. "checkout.errors.STALE_PRICE". */
  messageKey: string;
  details?: Record<string, unknown>;
}

/** The checkout code carried by an action failure, or null for any other failure. */
export function checkoutCodeFromFailure(failure: {
  fieldErrors?: Record<string, string[]>;
}): CheckoutFailureView | null {
  const code = failure.fieldErrors?.[CHECKOUT_FAILURE_FIELD]?.[0];
  if (!code || !KNOWN.has(code)) return null;
  const rawDetails = failure.fieldErrors?.[CHECKOUT_FAILURE_DETAILS_FIELD]?.[0];
  let details: Record<string, unknown> | undefined;
  if (rawDetails) {
    try {
      const parsed: unknown = JSON.parse(rawDetails);
      if (parsed && typeof parsed === "object") details = parsed as Record<string, unknown>;
    } catch {
      details = undefined;
    }
  }
  return {
    code: code as CheckoutFailureCode,
    messageKey: `checkout.errors.${code}`,
    ...(details ? { details } : {}),
  };
}
