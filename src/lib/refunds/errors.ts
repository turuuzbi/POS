/**
 * Refund / void failures as the register sees them. The service reports a
 * contract error code (domain/refund-contract.ts, domain/void-contract.ts) in
 * the generic action envelope's `fieldErrors` (the same way checkout does:
 * `{ <field>: [CODE], "<field>.details": [json] }`); anything else is a plain
 * action failure (not signed in, forbidden, internal ...).
 *
 * The extractor does not hard-code the field name: it accepts the first
 * non-"details" entry whose value is a known contract code.
 */
import {
  REFUND_ERROR_CODES,
  REFUND_ERROR_MESSAGE_KEYS,
  type RefundErrorCode,
} from "@/domain/refund-contract";
import {
  VOID_ERROR_CODES,
  VOID_ERROR_MESSAGE_KEYS,
  type VoidErrorCode,
} from "@/domain/void-contract";
import type { ActionErrorCode, ActionFailure } from "@/server/actions/define-action";

export type FailureSource = "refund" | "void";

export type FailureView =
  | {
      kind: "contract";
      source: FailureSource;
      code: RefundErrorCode | VoidErrorCode;
      messageKey: string;
      details?: Record<string, unknown>;
    }
  | { kind: "action"; code: ActionErrorCode };

const CODES: Record<FailureSource, ReadonlySet<string>> = {
  refund: new Set<string>(REFUND_ERROR_CODES),
  void: new Set<string>(VOID_ERROR_CODES),
};

function messageKeyOf(source: FailureSource, code: string): string {
  return source === "refund"
    ? REFUND_ERROR_MESSAGE_KEYS[code as RefundErrorCode]
    : VOID_ERROR_MESSAGE_KEYS[code as VoidErrorCode];
}

export function failureView(failure: ActionFailure, source: FailureSource): FailureView {
  const fields = failure.fieldErrors ?? {};
  for (const [key, values] of Object.entries(fields)) {
    if (key.endsWith(".details")) continue;
    const code = values[0];
    if (code && CODES[source].has(code)) {
      let details: Record<string, unknown> | undefined;
      const raw = fields[`${key}.details`]?.[0];
      if (raw) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === "object") details = parsed as Record<string, unknown>;
        } catch {
          details = undefined;
        }
      }
      return {
        kind: "contract",
        source,
        code: code as RefundErrorCode | VoidErrorCode,
        messageKey: messageKeyOf(source, code),
        ...(details ? { details } : {}),
      };
    }
  }
  return { kind: "action", code: failure.code };
}

/**
 * Failures after which the same request may still be committing (or may have
 * committed): they are retried verbatim and, when they persist, treated as an
 * unknown outcome rather than a definitive refusal.
 */
const TRANSIENT_CONTRACT = new Set<string>(["INTERNAL", "CONCURRENT_DUPLICATE"]);

export function isTransient(view: FailureView): boolean {
  if (view.kind === "action") return view.code === "INTERNAL";
  return TRANSIENT_CONTRACT.has(view.code);
}

/**
 * Codes that say the stored rows moved on under the cashier (another till
 * refunded the line, the total changed): reload the sale and recompute.
 */
const STALE_CODES = new Set<string>([
  "ALREADY_REFUNDED",
  "OVER_REFUND",
  "SALE_NOT_COMPLETED",
  "ALREADY_VOIDED",
  "TOTAL_MISMATCH",
]);
export function isStale(view: FailureView): boolean {
  return view.kind === "contract" && STALE_CODES.has(view.code);
}

/** Approval tokens were refused or are missing: ask the manager again. */
export function isApprovalProblem(view: FailureView): boolean {
  return (
    view.kind === "contract" &&
    (view.code === "APPROVAL_REQUIRED" || view.code === "APPROVAL_INVALID")
  );
}

/**
 * i18n lookups to try, in order. `refundErrors.<messageKey>` is owned by the
 * service slice; `refunds.issues.<CODE>` is this UI's own text for the same
 * codes (the client planner raises them too); `refunds.errors.generic` ends.
 */
export function messageCandidates(view: FailureView): string[] {
  if (view.kind === "action") return [`errors.${view.code}`];
  return [
    `refundErrors.${view.messageKey}`,
    `refundErrors.${view.code}`,
    `refunds.issues.${view.code}`,
  ];
}
