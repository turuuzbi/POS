/**
 * Shift cash math (Phase 3, pure). Money is bigint möngö; counts are ints.
 *
 *   expected = openingFloat + cashSales(net of change) − cashRefunds + cashIn − cashOut
 *   variance = counted − expected          (negative = short, positive = over)
 *
 * `cashSales` is the sum of CASH `SalePayment.amount` of non-voided sales
 * (that column already excludes change), `cashRefunds` the CASH
 * `RefundPayment.amount` paid out during the shift. Nothing here reads a clock
 * or the database.
 */
import { fromMajor, sum, type Money } from "./money";

// ---------------------------------------------------------------------------
// Denominations
// ---------------------------------------------------------------------------

/** MNT notes and coins in whole tögrög, largest first. The single source of truth. */
export const MNT_DENOMINATIONS = [20_000, 10_000, 5000, 1000, 500, 100, 50, 20, 10] as const;
export type MntDenomination = (typeof MNT_DENOMINATIONS)[number];

/** Upper bound on the count of one denomination (sanity; 100 000 notes of 20 000₮ = 2bn₮). */
export const MAX_DENOMINATION_COUNT = 100_000;

/** Smallest countable cash unit: the smallest denomination, 10₮, in möngö. */
export const MIN_CASH_UNIT: Money = fromMajor(10n);

/** Counts keyed by the denomination in ₮ as a string, e.g. `{"20000": 3, "1000": 12}`. */
export type DenominationCounts = Partial<Record<`${MntDenomination}`, number>>;

export type DenominationIssueCode =
  "NOT_AN_OBJECT" | "UNKNOWN_DENOMINATION" | "INVALID_COUNT" | "COUNT_TOO_LARGE";

export interface DenominationIssue {
  code: DenominationIssueCode;
  denomination?: string;
}

export type DenominationsResult =
  | { ok: true; counts: Record<`${MntDenomination}`, number>; total: Money }
  | { ok: false; issues: DenominationIssue[] };

/**
 * Validate and normalise a counted-cash breakdown: only known denominations,
 * every count a non-negative safe integer ≤ MAX_DENOMINATION_COUNT. Missing
 * denominations count as 0. The result lists every denomination (stable shape
 * for JSON storage in `Shift.denominations`).
 */
export function parseDenominations(input: unknown): DenominationsResult {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, issues: [{ code: "NOT_AN_OBJECT" }] };
  }
  const issues: DenominationIssue[] = [];
  const known = new Set<string>(MNT_DENOMINATIONS.map(String));
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) issues.push({ code: "UNKNOWN_DENOMINATION", denomination: key });
  }
  const counts = {} as Record<`${MntDenomination}`, number>;
  for (const denomination of MNT_DENOMINATIONS) {
    const key = String(denomination) as `${MntDenomination}`;
    const value = key in raw ? raw[key] : 0;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      issues.push({ code: "INVALID_COUNT", denomination: key });
      counts[key] = 0;
    } else if (value > MAX_DENOMINATION_COUNT) {
      issues.push({ code: "COUNT_TOO_LARGE", denomination: key });
      counts[key] = 0;
    } else {
      counts[key] = value;
    }
  }
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, counts, total: denominationsTotal(counts) };
}

/** Σ denomination × count, in möngö. Counts must already be valid. */
export function denominationsTotal(counts: DenominationCounts): Money {
  let total = 0n;
  for (const denomination of MNT_DENOMINATIONS) {
    const count = counts[String(denomination) as `${MntDenomination}`] ?? 0;
    total += fromMajor(denomination) * BigInt(count);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Expected cash and variance
// ---------------------------------------------------------------------------

export interface ExpectedCashInput {
  openingFloat: Money;
  /** CASH sale payments of non-voided sales, net of change given. */
  cashSales: Money;
  /** CASH paid out in refunds. */
  cashRefunds: Money;
  cashIn: Money;
  cashOut: Money;
}

export function expectedCash(input: ExpectedCashInput): Money {
  for (const [name, value] of Object.entries(input)) {
    if (value < 0n) throw new RangeError(`expectedCash: ${name} must not be negative`);
  }
  return input.openingFloat + input.cashSales - input.cashRefunds + input.cashIn - input.cashOut;
}

/** counted − expected. Negative = short, positive = over. */
export function cashVariance(counted: Money, expected: Money): Money {
  return counted - expected;
}

export type VarianceClass = "OK" | "SHORT" | "OVER";

/** Variance within `tolerance` (default exact) is OK. */
export function classifyVariance(variance: Money, tolerance: Money = 0n): VarianceClass {
  if (tolerance < 0n) throw new RangeError("classifyVariance: tolerance must not be negative");
  const magnitude = variance < 0n ? -variance : variance;
  if (magnitude <= tolerance) return "OK";
  return variance < 0n ? "SHORT" : "OVER";
}

/**
 * A closing note is mandatory when |variance| exceeds this. BusinessSettings
 * has no such column yet, so it is a constant (1 000₮); pass a different value
 * to `validateCloseShift` when the setting exists.
 */
export const VARIANCE_NOTE_THRESHOLD: Money = fromMajor(1000);
export const MAX_CLOSING_NOTE_LENGTH = 500;

// ---------------------------------------------------------------------------
// Close shift
// ---------------------------------------------------------------------------

export type ShiftIssueCode =
  "SHIFT_NOT_OPEN" | "DENOMINATIONS_INVALID" | "VARIANCE_NOTE_REQUIRED" | "NOTE_TOO_LONG";

export interface ShiftIssue {
  code: ShiftIssueCode;
  denominationIssues?: DenominationIssue[];
}

export interface CloseShiftInput {
  status: "OPEN" | "CLOSED";
  expectedCash: Money;
  /** Raw counted breakdown from the client (validated here). */
  denominations: unknown;
  note?: string | undefined;
  /** |variance| above this needs a note. Default VARIANCE_NOTE_THRESHOLD. */
  noteThreshold?: Money;
}

export type CloseShiftResult =
  | {
      ok: true;
      countedCash: Money;
      cashVariance: Money;
      classification: VarianceClass;
      denominations: Record<`${MntDenomination}`, number>;
      note: string | undefined;
    }
  | { ok: false; issues: ShiftIssue[] };

export function validateCloseShift(input: CloseShiftInput): CloseShiftResult {
  const issues: ShiftIssue[] = [];
  if (input.status !== "OPEN") issues.push({ code: "SHIFT_NOT_OPEN" });

  const parsed = parseDenominations(input.denominations);
  if (!parsed.ok) {
    issues.push({ code: "DENOMINATIONS_INVALID", denominationIssues: parsed.issues });
  }
  const note = input.note?.trim() || undefined;
  if (note !== undefined && note.length > MAX_CLOSING_NOTE_LENGTH) {
    issues.push({ code: "NOTE_TOO_LONG" });
  }
  if (!parsed.ok) return { ok: false, issues };

  const variance = cashVariance(parsed.total, input.expectedCash);
  const threshold = input.noteThreshold ?? VARIANCE_NOTE_THRESHOLD;
  const magnitude = variance < 0n ? -variance : variance;
  if (magnitude > threshold && note === undefined) issues.push({ code: "VARIANCE_NOTE_REQUIRED" });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    countedCash: parsed.total,
    cashVariance: variance,
    classification: classifyVariance(variance),
    denominations: parsed.counts,
    note,
  };
}

// ---------------------------------------------------------------------------
// Cash movements (pay-in / pay-out)
// ---------------------------------------------------------------------------

export const CASH_MOVEMENT_TYPES = ["CASH_IN", "CASH_OUT"] as const;
export type CashMovementKind = (typeof CASH_MOVEMENT_TYPES)[number];

export const MAX_CASH_MOVEMENT: Money = fromMajor(100_000_000);
export const MAX_REASON_LENGTH = 200;

export type CashMovementIssueCode =
  | "SHIFT_NOT_OPEN"
  | "AMOUNT_NOT_POSITIVE"
  | "AMOUNT_TOO_LARGE"
  | "AMOUNT_NOT_IN_UNITS"
  | "REASON_REQUIRED"
  | "REASON_TOO_LONG"
  | "PAYOUT_EXCEEDS_CASH";

export interface CashMovementInput {
  shiftStatus: "OPEN" | "CLOSED";
  type: CashMovementKind;
  amount: Money;
  reason: string;
  /** Current expected cash in the drawer (before this movement). */
  expectedCashOnHand: Money;
  /** A manager approved paying out more than the drawer should hold. */
  overdrawApproved?: boolean;
  /** Smallest countable note in möngö; amounts must be multiples. Default 10₮ (the smallest denomination). */
  cashUnit?: Money;
}

export type CashMovementResult =
  | { ok: true; reason: string; expectedCashAfter: Money; needsOverdrawApproval: false }
  | { ok: false; issues: { code: CashMovementIssueCode }[]; needsOverdrawApproval: boolean };

export function validateCashMovement(input: CashMovementInput): CashMovementResult {
  const issues: { code: CashMovementIssueCode }[] = [];
  let needsOverdrawApproval = false;
  const unit = input.cashUnit ?? MIN_CASH_UNIT;
  if (input.shiftStatus !== "OPEN") issues.push({ code: "SHIFT_NOT_OPEN" });
  if (input.amount <= 0n) issues.push({ code: "AMOUNT_NOT_POSITIVE" });
  else if (input.amount > MAX_CASH_MOVEMENT) issues.push({ code: "AMOUNT_TOO_LARGE" });
  else if (unit > 0n && input.amount % unit !== 0n) issues.push({ code: "AMOUNT_NOT_IN_UNITS" });
  const reason = input.reason.trim();
  if (reason === "") issues.push({ code: "REASON_REQUIRED" });
  else if (reason.length > MAX_REASON_LENGTH) issues.push({ code: "REASON_TOO_LONG" });
  if (
    input.type === "CASH_OUT" &&
    input.amount > 0n &&
    input.amount > input.expectedCashOnHand &&
    input.overdrawApproved !== true
  ) {
    issues.push({ code: "PAYOUT_EXCEEDS_CASH" });
    needsOverdrawApproval = true;
  }
  if (issues.length > 0) return { ok: false, issues, needsOverdrawApproval };
  const after =
    input.type === "CASH_IN"
      ? input.expectedCashOnHand + input.amount
      : input.expectedCashOnHand - input.amount;
  return { ok: true, reason, expectedCashAfter: after, needsOverdrawApproval: false };
}

/** Σ of movement amounts by direction (rows are already positive). */
export function sumCashMovements(movements: readonly { type: CashMovementKind; amount: Money }[]): {
  cashIn: Money;
  cashOut: Money;
} {
  return {
    cashIn: sum(movements.filter((m) => m.type === "CASH_IN").map((m) => m.amount)),
    cashOut: sum(movements.filter((m) => m.type === "CASH_OUT").map((m) => m.amount)),
  };
}
