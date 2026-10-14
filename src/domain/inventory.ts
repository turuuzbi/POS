/**
 * Inventory math (pure). Quantities are milli-units (see qty.ts), costs are
 * möngö per whole unit (see money.ts).
 */
import { divRound, type Money } from "./money";
import { MAX_QTY_MILLI, type QtyMilli } from "./qty";

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
