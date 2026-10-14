/**
 * Inventory math (pure). Quantities are milli-units (see qty.ts), costs are
 * möngö per whole unit (see money.ts).
 */
import { divRound, type Money } from "./money";
import { MAX_QTY_MILLI, extend, type QtyMilli } from "./qty";

/**
 * Moving-average unit cost after receiving `receivedMilli` at `unitCost`.
 * Stock already on hand (across all locations) keeps its weight; when there
 * is none — or less than none, after selling into negative stock — the
 * received cost simply becomes the average.
 */
export function movingAverageCost(
  onHandMilli: QtyMilli,
  currentCost: Money,
  receivedMilli: QtyMilli,
  unitCost: Money,
): Money {
  if (receivedMilli <= 0) throw new RangeError("movingAverageCost: receivedMilli must be positive");
  if (onHandMilli <= 0) return unitCost;
  const onHand = BigInt(onHandMilli);
  const received = BigInt(receivedMilli);
  return divRound(onHand * currentCost + received * unitCost, onHand + received);
}

/** A balance stays within what the database (Int4) and the domain allow. */
export function isValidBalance(balanceMilli: number): boolean {
  return Number.isSafeInteger(balanceMilli) && Math.abs(balanceMilli) <= MAX_QTY_MILLI * 2;
}

/** Signed difference that brings `onHandMilli` to `countedMilli`. */
export function countVariance(onHandMilli: QtyMilli, countedMilli: QtyMilli): QtyMilli {
  return countedMilli - onHandMilli;
}

/** Value of a quantity variance at a unit cost (möngö per whole unit), rounded once. */
export function varianceValue(varianceMilli: QtyMilli, unitCost: Money): Money {
  return extend(unitCost, varianceMilli);
}

/** Counted quantity after a scan adds `addMilli` to what was counted so far (null = not counted). */
export function addToCount(countedMilli: QtyMilli | null, addMilli: QtyMilli): QtyMilli {
  const next = (countedMilli ?? 0) + addMilli;
  if (!Number.isSafeInteger(next) || next < 0 || next > MAX_QTY_MILLI) {
    throw new RangeError("addToCount: out of range");
  }
  return next;
}

export interface VarianceInput {
  /** What the count is compared with (current on-hand while the count is open). */
  expectedMilli: QtyMilli;
  countedMilli: QtyMilli | null;
  unitCost: Money;
}

export interface VarianceSummary {
  counted: number;
  uncounted: number;
  surplusLines: number;
  shortageLines: number;
  surplusMilli: QtyMilli;
  shortageMilli: QtyMilli;
  /** Net value of the variances (surplus − shortage). */
  netValue: Money;
}

/**
 * Totals for the review screen. Uncounted lines contribute nothing unless
 * `countAll` (uncounted = zero on the shelf) is chosen.
 */
export function summarizeVariance(lines: VarianceInput[], countAll: boolean): VarianceSummary {
  const out: VarianceSummary = {
    counted: 0,
    uncounted: 0,
    surplusLines: 0,
    shortageLines: 0,
    surplusMilli: 0,
    shortageMilli: 0,
    netValue: 0n,
  };
  for (const line of lines) {
    if (line.countedMilli === null) out.uncounted++;
    else out.counted++;
    const counted = line.countedMilli ?? (countAll ? 0 : null);
    if (counted === null) continue;
    const variance = countVariance(line.expectedMilli, counted);
    if (variance > 0) {
      out.surplusLines++;
      out.surplusMilli += variance;
    } else if (variance < 0) {
      out.shortageLines++;
      out.shortageMilli += -variance;
    }
    out.netValue += varianceValue(variance, line.unitCost);
  }
  return out;
}
