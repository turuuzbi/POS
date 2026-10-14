/**
 * Sale total rounding (cash rounding). The unit comes from
 * `BusinessSettings.totalRoundingUnit` (möngö): 100 = whole ₮ (default),
 * 500 = 5₮, 1000 = 10₮.
 *
 * Only the total PAYABLE is rounded. Line and sale tax are NOT recomputed from
 * the rounded figure: the signed difference is stored on its own as
 * `Sale.roundingAmount`, so `total + roundingAmount = payable` always holds.
 */
import { MINOR_PER_MAJOR, roundToUnit, type Money, type RoundingMode } from "./money";

export const DEFAULT_ROUNDING_UNIT: Money = MINOR_PER_MAJOR;

/** Units the settings UI offers: 1₮ (default), 5₮, 10₮, plus exact (1 möngö). */
export const ALLOWED_ROUNDING_UNITS: readonly Money[] = [1n, 100n, 500n, 1000n];

export interface RoundedTotal {
  /** The pre-rounding total (Σ line gross). */
  total: Money;
  /** Signed: payable − total. Positive when rounded up. */
  roundingAmount: Money;
  /** What the customer owes: a multiple of the unit. */
  payable: Money;
}

export function roundTotal(
  total: Money,
  unit: Money = DEFAULT_ROUNDING_UNIT,
  mode: RoundingMode = "HALF_UP",
): RoundedTotal {
  if (total < 0n) throw new RangeError("roundTotal: total must not be negative");
  if (unit <= 0n) throw new RangeError("roundTotal: unit must be positive");
  const payable = roundToUnit(total, unit, mode);
  return { total, roundingAmount: payable - total, payable };
}
