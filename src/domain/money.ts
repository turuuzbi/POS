/**
 * Money primitives. Pure and framework-free: shared by the browser (instant
 * cart totals) and the server (authoritative recomputation).
 *
 * All amounts are `bigint` integer minor units of MNT (möngö, 1 ₮ = 100).
 * Floats never enter money math: there is no API here that accepts a
 * fractional `number`.
 */

/** Integer minor units (möngö). */
export type Money = bigint;

export const CURRENCY = "MNT";
export const CURRENCY_SYMBOL = "₮";
/** Minor units per major unit (ISO 4217 exponent 2). */
export const MINOR_PER_MAJOR = 100n;
/** Basis points per 100%. */
export const BPS_DENOMINATOR = 10_000n;

export type RoundingMode =
  /** Round half away from zero (commercial rounding). The default. */
  | "HALF_UP"
  /** Round half to even (banker's rounding). */
  | "HALF_EVEN"
  /** Toward zero (truncate). */
  | "DOWN"
  /** Away from zero. */
  | "UP"
  /** Toward −∞. */
  | "FLOOR"
  /** Toward +∞. */
  | "CEIL";

const abs = (n: bigint): bigint => (n < 0n ? -n : n);

/**
 * Exact integer division `numerator / denominator` with explicit rounding.
 * Correct for every sign combination and arbitrarily large operands.
 */
export function divRound(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = "HALF_UP",
): bigint {
  if (denominator === 0n) throw new RangeError("divRound: division by zero");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  const quotient = numerator / denominator; // truncates toward zero
  const remainder = numerator % denominator; // takes the sign of the numerator
  if (remainder === 0n) return quotient;

  const awayFromZero = numerator < 0n ? quotient - 1n : quotient + 1n;
  const twiceRemainder = abs(remainder) * 2n;

  switch (mode) {
    case "DOWN":
      return quotient;
    case "UP":
      return awayFromZero;
    case "FLOOR":
      return numerator < 0n ? quotient - 1n : quotient;
    case "CEIL":
      return numerator > 0n ? quotient + 1n : quotient;
    case "HALF_UP":
      return twiceRemainder >= denominator ? awayFromZero : quotient;
    case "HALF_EVEN":
      if (twiceRemainder > denominator) return awayFromZero;
      if (twiceRemainder < denominator) return quotient;
      return quotient % 2n === 0n ? quotient : awayFromZero;
  }
}

/** `a × b / denominator`, rounded once at the end (no intermediate rounding). */
export function mulDiv(
  a: bigint,
  b: bigint,
  denominator: bigint,
  mode: RoundingMode = "HALF_UP",
): bigint {
  return divRound(a * b, denominator, mode);
}

/** `amount × bps / 10 000`, e.g. `percentOf(1000_00n, 1000)` = 100_00n (10%). */
export function percentOf(
  amount: Money,
  bps: number | bigint,
  mode: RoundingMode = "HALF_UP",
): Money {
  return mulDiv(amount, toBigIntStrict(bps, "bps"), BPS_DENOMINATOR, mode);
}

/** Round to the nearest multiple of `unit` (e.g. `100n` = whole ₮). */
export function roundToUnit(amount: Money, unit: Money, mode: RoundingMode = "HALF_UP"): Money {
  if (unit <= 0n) throw new RangeError("roundToUnit: unit must be positive");
  return divRound(amount, unit, mode) * unit;
}

export function sum(values: Iterable<Money>): Money {
  let total = 0n;
  for (const value of values) total += value;
  return total;
}

export function min(a: Money, b: Money): Money {
  return a < b ? a : b;
}

export function max(a: Money, b: Money): Money {
  return a > b ? a : b;
}

/**
 * Split `total` across `weights` in proportion, so that the parts sum to
 * exactly `total` (largest-remainder method). Leftover units go to the
 * largest fractional remainders; ties go to the earlier index, so the result
 * is deterministic. Used to spread cart discounts over lines.
 */
export function allocate(total: Money, weights: readonly bigint[]): Money[] {
  if (weights.some((w) => w < 0n)) throw new RangeError("allocate: weights must be non-negative");
  const weightSum = sum(weights);
  if (weightSum === 0n) {
    if (total === 0n) return weights.map(() => 0n);
    throw new RangeError("allocate: cannot allocate a non-zero total over zero weights");
  }
  const negative = total < 0n;
  const magnitude = abs(total);

  const parts = weights.map((w) => (magnitude * w) / weightSum);
  const remainders = weights.map((w, index) => ({ index, remainder: (magnitude * w) % weightSum }));
  let leftover = magnitude - sum(parts);

  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (leftover === 0n) break;
    parts[index] = (parts[index] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return negative ? parts.map((p) => -p) : parts;
}

/**
 * Whole tögrög → minor units. Accepts only integers (a `number` must be a safe
 * integer) so a float can never sneak in. For user input use `parseMoney`.
 */
export function fromMajor(major: number | bigint): Money {
  return toBigIntStrict(major, "major") * MINOR_PER_MAJOR;
}

function toBigIntStrict(value: number | bigint, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${label} must be a safe integer, got ${String(value)}`);
  }
  return BigInt(value);
}

export interface FormatMoneyOptions {
  /** BCP 47 locale for digit grouping. Default "mn". */
  locale?: string;
  /**
   * "auto" (default): show möngö only when non-zero; "always": always two
   * decimals; "never": round to whole ₮ (half-up) for display.
   */
  minor?: "auto" | "always" | "never";
  /** Append the ₮ symbol. Default true. */
  symbol?: boolean;
}

/** `1234550n` → `"12,345.50₮"`; `1234500n` → `"12,345₮"`. */
export function formatMoney(amount: Money, options: FormatMoneyOptions = {}): string {
  const { locale = "mn", minor = "auto", symbol = true } = options;
  const negative = amount < 0n;
  let magnitude = abs(amount);
  if (minor === "never") magnitude = roundToUnit(magnitude, MINOR_PER_MAJOR);

  const major = magnitude / MINOR_PER_MAJOR;
  const fraction = magnitude % MINOR_PER_MAJOR;
  let text = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(major);
  if (minor === "always" || (minor === "auto" && fraction !== 0n)) {
    text += decimalSeparator(locale) + fraction.toString().padStart(2, "0");
  }
  return `${negative ? "-" : ""}${text}${symbol ? CURRENCY_SYMBOL : ""}`;
}

const separatorCache = new Map<string, string>();
function decimalSeparator(locale: string): string {
  let separator = separatorCache.get(locale);
  if (separator === undefined) {
    separator =
      new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === "decimal")
        ?.value ?? ".";
    separatorCache.set(locale, separator);
  }
  return separator;
}

const MONEY_INPUT = /^(-)?(\d{1,3}(?:[ ,]\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse user-typed tögrög into minor units. Accepts `12345`, `12,345`,
 * `12 345`, `12345.5`, `12,345.50`, with an optional ₮ before or after.
 * Comma and space are digit-group separators only; "." is the decimal mark.
 * Returns null for anything ambiguous or malformed (e.g. 3 decimals).
 */
export function parseMoney(input: string, { allowNegative = false } = {}): Money | null {
  const normalized = input
    .trim()
    .replace(/ | /g, " ")
    .replace(/^₮\s*|\s*₮$/g, "")
    .trim();
  const match = MONEY_INPUT.exec(normalized);
  if (!match) return null;
  const [, sign, integerPart = "", fractionPart = ""] = match;
  if (sign && !allowNegative) return null;
  const major = BigInt(integerPart.replace(/[ ,]/g, ""));
  const minor = BigInt(fractionPart.padEnd(2, "0") || "0");
  const value = major * MINOR_PER_MAJOR + minor;
  return sign ? -value : value;
}
