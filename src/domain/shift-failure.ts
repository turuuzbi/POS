/**
 * How a shift failure travels through the generic action envelope, like
 * `checkout-failure.ts`:
 *
 *   { ok: false, error: { code, fieldErrors: { shift: ["VARIANCE_NOTE_REQUIRED"],
 *                                              "shift.details": ['{"key":"cash:overdraw"}'] } } }
 *
 * The register reads it with `shiftCodeFromFailure` and translates
 * `shifts.errors.<CODE>` (messages/<locale>/shifts.json).
 */
import { SHIFT_ERROR_CODES, type ShiftErrorCode } from "./shift-contract";

export const SHIFT_FAILURE_FIELD = "shift";
export const SHIFT_FAILURE_DETAILS_FIELD = "shift.details";

const KNOWN = new Set<string>(SHIFT_ERROR_CODES);

export interface ShiftFailureView {
  code: ShiftErrorCode;
  details?: Record<string, unknown>;
}

export function shiftCodeFromFailure(failure: {
  fieldErrors?: Record<string, string[]>;
}): ShiftFailureView | null {
  const code = failure.fieldErrors?.[SHIFT_FAILURE_FIELD]?.[0];
  if (!code || !KNOWN.has(code)) return null;
  let details: Record<string, unknown> | undefined;
  const raw = failure.fieldErrors?.[SHIFT_FAILURE_DETAILS_FIELD]?.[0];
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object") details = parsed as Record<string, unknown>;
    } catch {
      details = undefined;
    }
  }
  return { code: code as ShiftErrorCode, ...(details ? { details } : {}) };
}
