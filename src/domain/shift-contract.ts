/**
 * Shift wire contract (Phase 3): close-shift and cash-movement inputs, results,
 * stable error codes, idempotency fingerprints and approval scopes.
 *
 * Money crosses JSON as decimal strings of möngö. registerId, shiftId (for
 * movements), cashier and location are derived server-side from the device.
 */
import { z } from "zod";
import {
  moneyWire,
  optionalText,
  sha256Hex,
  signedMoneyWire,
  stableStringify,
  uuid,
  uuidV7,
} from "./checkout-contract";
import {
  CASH_MOVEMENT_TYPES,
  MAX_CLOSING_NOTE_LENGTH,
  MAX_REASON_LENGTH,
  MNT_DENOMINATIONS,
  type CashMovementIssueCode,
  type ShiftIssue,
} from "./shift";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const openShiftInputSchema = z.object({
  openingFloat: moneyWire,
});
export type OpenShiftInput = z.output<typeof openShiftInputSchema>;

/** Counts keyed by denomination in ₮; unknown keys and bad counts are rejected by `parseDenominations`. */
const denominationsWire = z
  .record(z.string().max(8), z.number().int().nonnegative().safe())
  .refine((r) => Object.keys(r).length <= MNT_DENOMINATIONS.length, "too many denominations");

export const closeShiftInputSchema = z.object({
  shiftId: uuid,
  denominations: denominationsWire,
  note: optionalText(MAX_CLOSING_NOTE_LENGTH),
});
export type CloseShiftInput = z.output<typeof closeShiftInputSchema>;

export const cashMovementInputSchema = z.object({
  /** Client-generated UUIDv7: the idempotency key (and CashMovement.id). */
  movementId: uuidV7,
  type: z.enum(CASH_MOVEMENT_TYPES),
  amount: moneyWire.refine((v) => v > 0n, "must be positive"),
  reason: z.string().trim().min(1).max(MAX_REASON_LENGTH),
  /** Approval tokens by key (`shiftApprovalKeys`). */
  approvals: z.record(z.string().max(100), z.string().min(1).max(512)).default({}),
  createdAtClient: z.iso.datetime({ offset: true }),
});
export type CashMovementInput = z.output<typeof cashMovementInputSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const SHIFT_ERROR_CODES = [
  "INVALID_INPUT",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "SHIFT_NOT_FOUND",
  "SHIFT_NOT_OPEN",
  "SHIFT_ALREADY_OPEN",
  "DENOMINATIONS_INVALID",
  "VARIANCE_NOTE_REQUIRED",
  "NOTE_TOO_LONG",
  "AMOUNT_NOT_POSITIVE",
  "AMOUNT_TOO_LARGE",
  "AMOUNT_NOT_IN_UNITS",
  "REASON_REQUIRED",
  "REASON_TOO_LONG",
  "PAYOUT_EXCEEDS_CASH",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL",
] as const;
export type ShiftErrorCode = (typeof SHIFT_ERROR_CODES)[number];

/** i18n key (namespace `shift.errors`) per code. */
export const SHIFT_ERROR_MESSAGE_KEYS: Record<ShiftErrorCode, string> = Object.fromEntries(
  SHIFT_ERROR_CODES.map((code) => [code, `shift.errors.${code}`]),
) as Record<ShiftErrorCode, string>;

export interface ShiftError {
  code: ShiftErrorCode;
  messageKey: string;
  details?: Record<string, unknown>;
}

export function shiftError(code: ShiftErrorCode, details?: Record<string, unknown>): ShiftError {
  return { code, messageKey: SHIFT_ERROR_MESSAGE_KEYS[code], ...(details ? { details } : {}) };
}

/** First issue of `validateCloseShift` / `validateCashMovement` → error (all codes in details). */
export function shiftErrorFromIssues(
  issues: readonly (ShiftIssue | { code: CashMovementIssueCode })[],
): ShiftError {
  const first = issues[0];
  const code = (first?.code ?? "INVALID_INPUT") as ShiftErrorCode;
  return shiftError(SHIFT_ERROR_CODES.includes(code) ? code : "INVALID_INPUT", {
    issues: issues.map((i) => i.code),
  });
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface CloseShiftResult {
  shiftId: string;
  zReportNumber: number;
  expectedCash: bigint;
  countedCash: bigint;
  cashVariance: bigint;
  classification: "OK" | "SHORT" | "OVER";
}

export const closeShiftResultSchema = z.object({
  shiftId: uuid,
  zReportNumber: z.number().int().positive(),
  expectedCash: signedMoneyWire,
  countedCash: signedMoneyWire,
  cashVariance: signedMoneyWire,
  classification: z.enum(["OK", "SHORT", "OVER"]),
});

export interface CashMovementResult {
  movementId: string;
  type: (typeof CASH_MOVEMENT_TYPES)[number];
  amount: bigint;
  expectedCashAfter: bigint;
  replayed: boolean;
}

export const cashMovementResultSchema = z.object({
  movementId: uuidV7,
  type: z.enum(CASH_MOVEMENT_TYPES),
  amount: signedMoneyWire,
  expectedCashAfter: signedMoneyWire,
  replayed: z.boolean(),
});

// ---------------------------------------------------------------------------
// Fingerprint (idempotent replay of a cash movement)
// ---------------------------------------------------------------------------

/**
 * Canonical content of a cash movement. Excluded: approvals (re-minted on
 * retry) and createdAtClient (clock). The stored row must be compared
 * field-by-field if no fingerprint column exists.
 */
export function cashMovementFingerprint(input: CashMovementInput): string {
  const { approvals: _approvals, createdAtClient: _created, ...content } = input;
  return sha256Hex(stableStringify(content));
}

export function isSameCashMovement(stored: string, input: CashMovementInput): boolean {
  return stored === cashMovementFingerprint(input);
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

export const shiftApprovalKeys = {
  /** Paying out more than the drawer should hold. Permission `pos.cash_movement`. */
  overdraw: "cash:overdraw",
  /** Cash in / out by a cashier without `pos.cash_movement`. Permission `pos.cash_movement`. */
  movement: "cash:movement",
} as const;

/**
 * Scope an approval token must carry for a cash movement:
 * `<movementId>:cash:<key>:<type>:<amount>`. Bound to the exact type and
 * amount, so a token for a 5 000₮ pay-out cannot approve a 50 000₮ one.
 */
export function cashMovementApprovalScope(
  movementId: string,
  key: (typeof shiftApprovalKeys)[keyof typeof shiftApprovalKeys],
  value: { type: (typeof CASH_MOVEMENT_TYPES)[number]; amount: bigint },
): string {
  return `${movementId}:${key}:${value.type}:${value.amount.toString()}`;
}

const CASH_SCOPE_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:cash:(?:overdraw|movement):(?:CASH_IN|CASH_OUT):\d+$/i;
export function isCashMovementApprovalScope(scope: string): boolean {
  return CASH_SCOPE_SHAPE.test(scope);
}
