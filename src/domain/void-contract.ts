/**
 * Void wire contract (Phase 3): input, result, stable error codes, replay
 * fingerprint and the approval scope bound to the exact sale and amount.
 */
import { z } from "zod";
import {
  optionalText,
  sha256Hex,
  signedMoneyWire,
  stableStringify,
  uuidV7,
} from "./checkout-contract";
import { MAX_VOID_NOTE_LENGTH, VOID_REASONS, type VoidIssue } from "./void";

export const voidInputSchema = z.strictObject({
  /** The sale to void. At most one void exists per sale, so this is the idempotency key. */
  saleId: uuidV7,
  reason: z.enum(VOID_REASONS),
  note: optionalText(MAX_VOID_NOTE_LENGTH),
  /** Approval tokens by key (`voidApprovalKey`). */
  approvals: z.record(z.string().max(100), z.string().min(1).max(512)).default({}),
  createdAtClient: z.iso.datetime({ offset: true }),
});
export type VoidInput = z.output<typeof voidInputSchema>;

export const VOID_ERROR_CODES = [
  "INVALID_INPUT",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "APPROVAL_INVALID",
  "SALE_NOT_FOUND",
  "SHIFT_NOT_OPEN",
  "VOID_NOT_ALLOWED",
  "ALREADY_VOIDED",
  "ALREADY_REFUNDED",
  "SALE_IN_OTHER_SHIFT",
  "REASON_NOTE_REQUIRED",
  "NOTE_TOO_LONG",
  "NOT_SUPPORTED",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL",
] as const;
export type VoidErrorCode = (typeof VOID_ERROR_CODES)[number];

export const VOID_ERROR_MESSAGE_KEYS: Record<VoidErrorCode, string> = Object.fromEntries(
  VOID_ERROR_CODES.map((code) => [code, `void.errors.${code}`]),
) as Record<VoidErrorCode, string>;

export interface VoidError {
  code: VoidErrorCode;
  messageKey: string;
  details?: Record<string, unknown>;
}

export function voidError(code: VoidErrorCode, details?: Record<string, unknown>): VoidError {
  return { code, messageKey: VOID_ERROR_MESSAGE_KEYS[code], ...(details ? { details } : {}) };
}

/** First issue of `planVoid` → API error (all issue codes in details). */
export function voidErrorFromIssues(issues: readonly VoidIssue[]): VoidError {
  const map: Record<VoidIssue["code"], VoidErrorCode> = {
    SHIFT_NOT_OPEN: "SHIFT_NOT_OPEN",
    SALE_NOT_COMPLETED: "ALREADY_VOIDED",
    SALE_IN_OTHER_SHIFT: "SALE_IN_OTHER_SHIFT",
    HAS_REFUNDS: "ALREADY_REFUNDED",
    REASON_NOTE_REQUIRED: "REASON_NOTE_REQUIRED",
    NOTE_TOO_LONG: "NOTE_TOO_LONG",
    NOT_SUPPORTED: "NOT_SUPPORTED",
    APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  };
  const first = issues[0];
  return voidError(first ? map[first.code] : "VOID_NOT_ALLOWED", {
    issues: issues.map((i) => i.code),
  });
}

export interface VoidResult {
  saleId: string;
  receiptNumber: string;
  totalAmount: bigint;
  /** Cash handed back from the drawer. */
  cashReturned: bigint;
  replayed: boolean;
}

export const voidResultSchema = z.object({
  saleId: uuidV7,
  receiptNumber: z.string().min(1),
  totalAmount: signedMoneyWire,
  cashReturned: signedMoneyWire,
  replayed: z.boolean(),
});

/** Same content as the stored void? (approvals and clock excluded.) */
export function voidFingerprint(input: VoidInput): string {
  const { approvals: _approvals, createdAtClient: _created, ...content } = input;
  return sha256Hex(stableStringify(content));
}

export function isSameVoid(stored: string, input: VoidInput): boolean {
  return stored === voidFingerprint(input);
}

/** Key into `VoidInput.approvals`; permission `pos.void`. */
export const voidApprovalKey = "void";

/**
 * Scope an approval token must carry: `<saleId>:void:<totalAmount>`. A token is
 * good for one sale at one amount only.
 */
export function voidApprovalScope(saleId: string, totalAmount: bigint): string {
  return `${saleId}:void:${totalAmount.toString()}`;
}

const VOID_SCOPE_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:void:\d+$/i;
export function isVoidApprovalScope(scope: string): boolean {
  return VOID_SCOPE_SHAPE.test(scope);
}
