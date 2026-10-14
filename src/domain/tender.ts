/**
 * Tenders (payments) for one sale. Pure validation + change math.
 *
 * `amount` is what is APPLIED to the sale (never includes change). For CASH,
 * `tendered` is the cash handed over (≥ amount; omitted = exact) and
 * `change = tendered − amount`. Rules:
 *   - every amount is a positive integer in möngö;
 *   - Σ applied amounts === payable exactly;
 *   - a non-cash tender can never exceed the balance still owed;
 *   - change only comes from cash; `tendered` is accepted for cash only;
 *   - at most MAX_TENDERS tenders;
 *   - cash amounts/tendered are multiples of `cashUnit` (smallest coin).
 */
import { MINOR_PER_MAJOR, fromMajor, sum, type Money } from "./money";

export const TENDER_METHODS = [
  "CASH",
  "CARD",
  "BANK_TRANSFER",
  "QPAY",
  "GIFT_CARD",
  "STORE_CREDIT",
] as const;
export type TenderMethod = (typeof TENDER_METHODS)[number];

export const MAX_TENDERS = 6;

export interface Tender {
  method: TenderMethod;
  amount: Money;
  /** Cash only: handed over by the customer. */
  tendered?: Money;
  reference?: string;
}

export type TenderIssueCode =
  | "TOO_MANY_TENDERS"
  | "NON_POSITIVE_AMOUNT"
  | "TENDERED_NOT_CASH"
  | "TENDERED_LESS_THAN_AMOUNT"
  | "CASH_NOT_IN_UNITS"
  | "NON_CASH_EXCEEDS_BALANCE"
  | "OVERPAID"
  | "UNDERPAID";

export interface TenderIssue {
  code: TenderIssueCode;
  /** Index of the offending tender, when the issue is about one tender. */
  index?: number;
}

export interface AppliedTender {
  method: TenderMethod;
  amount: Money;
  /** CASH: tendered (defaults to amount); null otherwise. */
  tendered: Money | null;
  change: Money;
  reference?: string;
}

export type TenderValidation =
  | { ok: true; applied: AppliedTender[]; totalApplied: Money; totalChange: Money }
  | { ok: false; issues: TenderIssue[] };

export interface TenderOptions {
  /** Smallest cash denomination in möngö. Default 100 (1₮). */
  cashUnit?: Money;
  maxTenders?: number;
}

export function validateTenders(
  payable: Money,
  tenders: readonly Tender[],
  options: TenderOptions = {},
): TenderValidation {
  const { cashUnit = MINOR_PER_MAJOR, maxTenders = MAX_TENDERS } = options;
  if (payable < 0n) throw new RangeError("validateTenders: payable must not be negative");
  const issues: TenderIssue[] = [];
  if (tenders.length > maxTenders) issues.push({ code: "TOO_MANY_TENDERS" });

  let running = 0n;
  const applied: AppliedTender[] = [];
  tenders.forEach((tender, index) => {
    if (typeof tender.amount !== "bigint" || tender.amount <= 0n) {
      issues.push({ code: "NON_POSITIVE_AMOUNT", index });
      return;
    }
    const isCash = tender.method === "CASH";
    if (!isCash && tender.tendered !== undefined) {
      issues.push({ code: "TENDERED_NOT_CASH", index });
    }
    let tendered: Money | null = null;
    if (isCash) {
      tendered = tender.tendered ?? tender.amount;
      if (tendered < tender.amount) issues.push({ code: "TENDERED_LESS_THAN_AMOUNT", index });
      if (tender.amount % cashUnit !== 0n || tendered % cashUnit !== 0n) {
        issues.push({ code: "CASH_NOT_IN_UNITS", index });
      }
    }
    // Compared against the balance still owed BEFORE this tender.
    if (running + tender.amount > payable) {
      issues.push({ code: isCash ? "OVERPAID" : "NON_CASH_EXCEEDS_BALANCE", index });
    }
    running += tender.amount;
    const change = tendered !== null && tendered >= tender.amount ? tendered - tender.amount : 0n;
    applied.push({
      method: tender.method,
      amount: tender.amount,
      tendered,
      change,
      ...(tender.reference !== undefined ? { reference: tender.reference } : {}),
    });
  });

  if (running < payable) issues.push({ code: "UNDERPAID" });
  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    applied,
    totalApplied: running,
    totalChange: sum(applied.map((t) => t.change)),
  };
}

/** Change owed for a cash tender. Throws when the customer handed over too little. */
export function computeChange(applied: Money, tendered: Money): Money {
  if (tendered < applied) throw new RangeError("computeChange: tendered is less than the amount");
  return tendered - applied;
}

/** Balance still owed after the given tenders. Signed: negative = over-applied. */
export function remainingBalance(
  payable: Money,
  tenders: readonly Pick<Tender, "amount">[],
): Money {
  return payable - sum(tenders.map((t) => t.amount));
}

/**
 * Turn "customer hands over X in cash" into a tender against `remaining`:
 * applies at most the remaining balance and returns the rest as change.
 */
export function cashTenderFor(remaining: Money, tendered: Money): Tender & { amount: Money } {
  if (remaining <= 0n) throw new RangeError("cashTenderFor: nothing left to pay");
  if (tendered <= 0n) throw new RangeError("cashTenderFor: tendered must be positive");
  const amount = tendered < remaining ? tendered : remaining;
  return { method: "CASH", amount, tendered };
}

/** Banknotes (₮) used to build quick "customer pays" buttons. */
export const QUICK_NOTES: readonly Money[] = [1000, 5000, 10_000, 20_000].map(fromMajor);

/**
 * Quick cash amounts for a remaining balance, ascending, unique: the exact
 * amount first, then the balance rounded UP to each note (1 000 / 5 000 /
 * 10 000 / 20 000 ₮). Duplicates collapse: 37 500₮ → 37 500, 38 000, 40 000.
 */
export function quickCashAmounts(remaining: Money, notes: readonly Money[] = QUICK_NOTES): Money[] {
  if (remaining <= 0n) return [];
  const out = new Set<Money>([remaining]);
  for (const note of notes) {
    if (note <= 0n) continue;
    out.add(((remaining + note - 1n) / note) * note);
  }
  return [...out].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
