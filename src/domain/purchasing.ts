/**
 * Purchasing rules (pure; shared by client forms and server services).
 * Money is möngö (bigint), quantities are integer milli-units, rates are bps.
 */
import { z } from "zod";
import { moneyField, optionalText, requiredText } from "./catalog";
import { sum, type Money } from "./money";
import { extend, MAX_QTY_MILLI, type QtyMilli } from "./qty";

export const PURCHASE_ORDER_STATUSES = [
  "DRAFT",
  "ORDERED",
  "PARTIALLY_RECEIVED",
  "RECEIVED",
  "CANCELLED",
] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/**
 * How far above the ordered quantity a PO line may be received, in basis
 * points of the ordered quantity. 0 = never receive more than was ordered.
 * Raise it (e.g. 1000 = +10%) if suppliers routinely over-deliver.
 */
export const OVER_RECEIPT_TOLERANCE_BPS = 0;

export const MAX_PO_LINES = 200;

const TRANSITIONS: Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]> = {
  DRAFT: ["ORDERED", "CANCELLED"],
  ORDERED: ["PARTIALLY_RECEIVED", "CANCELLED"],
  // Closing short (the supplier will not deliver the rest) is PARTIALLY_RECEIVED -> RECEIVED.
  PARTIALLY_RECEIVED: ["RECEIVED"],
  RECEIVED: [],
  CANCELLED: [],
};

export function canTransition(from: PurchaseOrderStatus, to: PurchaseOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Lines and header may change only while the order is a draft. */
export function isEditable(status: PurchaseOrderStatus): boolean {
  return status === "DRAFT";
}

/** Goods can be booked against an order that was sent and is not closed. */
export function canReceive(status: PurchaseOrderStatus): boolean {
  return status === "ORDERED" || status === "PARTIALLY_RECEIVED";
}

export interface OrderLineQty {
  qtyOrderedMilli: QtyMilli;
  qtyReceivedMilli: QtyMilli;
}

/** Most that may still be received on a line, including the over-receipt tolerance. */
export function maxReceivableMilli(
  line: OrderLineQty,
  toleranceBps: number = OVER_RECEIPT_TOLERANCE_BPS,
): QtyMilli {
  const ceiling = Math.floor((line.qtyOrderedMilli * (10_000 + toleranceBps)) / 10_000);
  return Math.max(0, ceiling - line.qtyReceivedMilli);
}

/** Quantity still expected (never negative); what a receipt form pre-fills. */
export function outstandingMilli(line: OrderLineQty): QtyMilli {
  return Math.max(0, line.qtyOrderedMilli - line.qtyReceivedMilli);
}

/** Status after receiving: nothing yet is ORDERED, every line covered is RECEIVED. */
export function statusAfterReceiving(lines: readonly OrderLineQty[]): PurchaseOrderStatus {
  if (lines.length > 0 && lines.every((l) => l.qtyReceivedMilli >= l.qtyOrderedMilli)) {
    return "RECEIVED";
  }
  return lines.some((l) => l.qtyReceivedMilli > 0) ? "PARTIALLY_RECEIVED" : "ORDERED";
}

/** `unitCost x qty`, rounded once (cost is per whole unit). */
export function lineTotal(unitCost: Money, qtyMilli: QtyMilli): Money {
  return extend(unitCost, qtyMilli);
}

export function orderTotal(lines: readonly { unitCost: Money; qtyMilli: QtyMilli }[]): Money {
  return sum(lines.map((l) => lineTotal(l.unitCost, l.qtyMilli)));
}

// Input schemas. Validation messages are stable codes (see <FieldError>).

const qtyMilliField = z
  .number("invalidQty")
  .int("invalidQty")
  .positive("invalidQty")
  .max(MAX_QTY_MILLI, "invalidQty");

export const supplierInputSchema = z.object({
  name: requiredText(120),
  contactName: optionalText(120),
  phone: optionalText(40),
  email: optionalText(120).refine((v) => v === null || /^\S+@\S+\.\S+$/.test(v), "invalid"),
  taxId: optionalText(40),
  address: optionalText(300),
  notes: optionalText(1000),
});
export type SupplierInput = z.output<typeof supplierInputSchema>;

export const supplierItemInputSchema = z.object({
  supplierId: z.uuid(),
  variantId: z.uuid(),
  supplierSku: optionalText(80),
  /** Typed in tugrugs; blank means unknown. */
  cost: z
    .string()
    .trim()
    .nullish()
    .transform((v, ctx): Money | null => {
      if (!v) return null;
      const parsed = moneyField.safeParse(v);
      if (!parsed.success) {
        ctx.addIssue({ code: "custom", message: "invalidMoney" });
        return z.NEVER;
      }
      return parsed.data;
    }),
  isPreferred: z.boolean().default(false),
});
export type SupplierItemInput = z.output<typeof supplierItemInputSchema>;

const poLineSchema = z.object({
  variantId: z.uuid(),
  qtyMilli: qtyMilliField,
  unitCost: moneyField,
});

export const purchaseOrderInputSchema = z.object({
  supplierId: z.uuid(),
  locationId: z.uuid(),
  expectedAt: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "invalid")
    .nullish()
    .transform((v) => v ?? null),
  note: optionalText(1000),
  lines: z
    .array(poLineSchema)
    .max(MAX_PO_LINES, "tooLong")
    .refine((lines) => new Set(lines.map((l) => l.variantId)).size === lines.length, "duplicate"),
});
export type PurchaseOrderInput = z.output<typeof purchaseOrderInputSchema>;

const receiptLineSchema = z.object({
  purchaseOrderLineId: z.uuid().optional(),
  variantId: z.uuid().optional(),
  qtyMilli: qtyMilliField,
  /** Must be typed (blank is not 0): users who cannot see costs send "0", which the server ignores. */
  unitCost: z.string().trim().min(1, "invalidMoney").pipe(moneyField),
});

export const receiptInputSchema = z
  .object({
    purchaseOrderId: z.uuid().optional(),
    supplierId: z.uuid().nullish(),
    locationId: z.uuid().optional(),
    note: optionalText(1000),
    lines: z.array(receiptLineSchema).min(1, "required").max(MAX_PO_LINES, "tooLong"),
  })
  .superRefine((input, ctx) => {
    const key = (l: (typeof input.lines)[number]) =>
      input.purchaseOrderId ? l.purchaseOrderLineId : l.variantId;
    if (input.lines.some((l) => !key(l))) {
      ctx.addIssue({ code: "custom", path: ["lines"], message: "invalid" });
    } else if (new Set(input.lines.map(key)).size !== input.lines.length) {
      ctx.addIssue({ code: "custom", path: ["lines"], message: "duplicate" });
    }
    if (!input.purchaseOrderId && !input.locationId) {
      ctx.addIssue({ code: "custom", path: ["locationId"], message: "required" });
    }
  });
export type ReceiptInput = z.output<typeof receiptInputSchema>;
