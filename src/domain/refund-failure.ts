/**
 * How refund / void / shift failures travel through the generic action
 * envelope (`ActionResult` / `ActionFailure`), the same convention as
 * checkout-failure.ts but one field per area:
 *
 *   { ok: false, error: { code, fieldErrors: {
 *       refund: ["OVER_REFUND"],                       // RefundErrorCode (or "void" / "shift")
 *       "refund.details": ['{"issues":[…]}']           // optional JSON
 *   } } }
 *
 * The UI reads it with `refundCodeFromFailure` / `voidCodeFromFailure` /
 * `shiftCodeFromFailure` and translates the message key (namespace
 * `refundErrors`, key e.g. `refund.errors.OVER_REFUND`).
 */
import { REFUND_ERROR_CODES, type RefundErrorCode } from "./refund-contract";
import { SHIFT_ERROR_CODES, type ShiftErrorCode } from "./shift-contract";
import { VOID_ERROR_CODES, type VoidErrorCode } from "./void-contract";

export const REFUND_FAILURE_FIELD = "refund";
export const VOID_FAILURE_FIELD = "void";
export const SHIFT_FAILURE_FIELD = "shift";

type Failure = { fieldErrors?: Record<string, string[]> };

export interface ContractFailureView<Code extends string> {
  code: Code;
  /** i18n key inside the `refundErrors` namespace, e.g. "refund.errors.OVER_REFUND". */
  messageKey: string;
  details?: Record<string, unknown>;
}

/** Field names an error is written under. */
export function failureFields(field: string): { code: string; details: string } {
  return { code: field, details: `${field}.details` };
}

function read<Code extends string>(
  failure: Failure,
  field: string,
  known: ReadonlySet<string>,
): ContractFailureView<Code> | null {
  const code = failure.fieldErrors?.[field]?.[0];
  if (!code || !known.has(code)) return null;
  const rawDetails = failure.fieldErrors?.[`${field}.details`]?.[0];
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
    code: code as Code,
    messageKey: `${field}.errors.${code}`,
    ...(details ? { details } : {}),
  };
}

const REFUND_KNOWN = new Set<string>(REFUND_ERROR_CODES);
const VOID_KNOWN = new Set<string>(VOID_ERROR_CODES);
const SHIFT_KNOWN = new Set<string>(SHIFT_ERROR_CODES);

export const refundCodeFromFailure = (failure: Failure) =>
  read<RefundErrorCode>(failure, REFUND_FAILURE_FIELD, REFUND_KNOWN);
export const voidCodeFromFailure = (failure: Failure) =>
  read<VoidErrorCode>(failure, VOID_FAILURE_FIELD, VOID_KNOWN);
export const shiftCodeFromFailure = (failure: Failure) =>
  read<ShiftErrorCode>(failure, SHIFT_FAILURE_FIELD, SHIFT_KNOWN);
