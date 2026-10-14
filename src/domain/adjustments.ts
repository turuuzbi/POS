/**
 * Stock adjustments (pure): reasons, which direction each may move stock, and
 * the input schema shared by the form and the server action.
 */
import { z } from "zod";
import { MAX_QTY_MILLI, parseQty, type QtyMilli, type Unit } from "./qty";

export const ADJUSTMENT_REASONS = [
  "DAMAGED",
  "EXPIRED",
  "LOST_STOLEN",
  "FOUND",
  "INTERNAL_USE",
  "CORRECTION",
  "OTHER",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export type AdjustmentDirection = "decrease" | "increase" | "both";

/** Which way a reason may move stock: damage only removes, "found" only adds. */
export const REASON_DIRECTION: Record<AdjustmentReason, AdjustmentDirection> = {
  DAMAGED: "decrease",
  EXPIRED: "decrease",
  LOST_STOLEN: "decrease",
  FOUND: "increase",
  INTERNAL_USE: "decrease",
  CORRECTION: "both",
  OTHER: "both",
};

/** Reasons that need an explanation in the note (they hide loss or an unexplained fix). */
export const NOTE_REQUIRED_REASONS: readonly AdjustmentReason[] = [
  "LOST_STOLEN",
  "CORRECTION",
  "OTHER",
];

export function isNoteRequired(reason: AdjustmentReason): boolean {
  return NOTE_REQUIRED_REASONS.includes(reason);
}

/** True when `deltaMilli` is a move the reason allows (zero is always fine). */
export function isDeltaAllowed(reason: AdjustmentReason, deltaMilli: QtyMilli): boolean {
  const direction = REASON_DIRECTION[reason];
  if (deltaMilli === 0 || direction === "both") return true;
  return direction === "decrease" ? deltaMilli < 0 : deltaMilli > 0;
}

export const MAX_ADJUSTMENT_LINES = 200;

const qtyInt = z.number().int("invalidQty").min(-MAX_QTY_MILLI, "invalidQty").max(MAX_QTY_MILLI);

export const adjustmentLineSchema = z.discriminatedUnion("mode", [
  /** Move stock by a signed amount. */
  z.object({
    mode: z.literal("delta"),
    variantId: z.uuid(),
    qtyMilli: qtyInt.refine((n) => n !== 0, "invalidQty"),
  }),
  /** Set stock to a counted amount. */
  z.object({
    mode: z.literal("set"),
    variantId: z.uuid(),
    qtyMilli: qtyInt.refine((n) => n >= 0, "invalidQty"),
  }),
]);
export type AdjustmentLineInput = z.infer<typeof adjustmentLineSchema>;

export const adjustmentInputSchema = z
  .object({
    locationId: z.uuid(),
    reason: z.enum(ADJUSTMENT_REASONS),
    note: z
      .string()
      .trim()
      .max(500, "tooLong")
      .nullish()
      .transform((value) => (value ? value : null)),
    lines: z.array(adjustmentLineSchema).min(1, "required").max(MAX_ADJUSTMENT_LINES, "tooLong"),
  })
  .superRefine((value, ctx) => {
    if (isNoteRequired(value.reason) && !value.note) {
      ctx.addIssue({ code: "custom", path: ["note"], message: "required" });
    }
    const seen = new Set<string>();
    value.lines.forEach((line, index) => {
      if (seen.has(line.variantId)) {
        ctx.addIssue({ code: "custom", path: ["lines", index], message: "duplicate" });
      }
      seen.add(line.variantId);
      if (line.mode === "delta" && !isDeltaAllowed(value.reason, line.qtyMilli)) {
        ctx.addIssue({ code: "custom", path: ["lines", index, "qtyMilli"], message: "invalid" });
      }
    });
  });
export type AdjustmentInput = z.infer<typeof adjustmentInputSchema>;

const ZERO = /^0+(?:[.,]0*)?$/;

/**
 * Typed line quantity → milli units; null when it isn't a valid entry for the
 * unit. In "delta" mode the reason's direction decides the sign for
 * decrease-only/increase-only reasons; otherwise a leading "-" (or "−") means
 * removal. In "set" mode zero is allowed.
 */
export function parseLineQty(
  text: string,
  mode: "delta" | "set",
  unit: Unit,
  direction: AdjustmentDirection,
): QtyMilli | null {
  const raw = text.trim().replace("−", "-");
  if (mode === "set") return ZERO.test(raw) ? 0 : parseQty(raw, unit);
  const magnitude = parseQty(raw.replace(/^[+-]/, ""), unit);
  if (magnitude === null) return null;
  const negative =
    direction === "decrease" ? true : direction === "increase" ? false : raw.startsWith("-");
  return negative ? -magnitude : magnitude;
}

/** Value of a stock change at a unit cost snapshot (möngö per whole unit). */
export function adjustmentValue(deltaMilli: QtyMilli, unitCost: bigint): bigint {
  return (BigInt(deltaMilli) * unitCost) / 1000n;
}
