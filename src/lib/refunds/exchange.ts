/**
 * Exchange mode of the register. The cashier picks the lines to take back on
 * the Returns screen; the register cart then collects the replacement items.
 * What survives between those two screens (and a page reload, which must not
 * lose a half-finished exchange) is this small context, kept per register +
 * cashier in localStorage. The original sale is re-read from the server when
 * it is needed again, never persisted.
 *
 * The replacement sale is the register's normal cart (`saleId` = the sale id
 * of the cart when the exchange is finished). Order of commits:
 *   1. the replacement checkout (tenders for the net due + the EXCHANGE_CREDIT
 *      tender for the credit applied), then
 *   2. the refund with `exchange: { saleId, expectedPayable }`, which links it.
 * Both are idempotent, so a crash between them is repaired by resending step 2
 * (`checkedOut` remembers that step 1 is done).
 */
import { z } from "zod";
import { RETURN_REASONS } from "@/domain/refund";
import { uuid, uuidV7 } from "@/domain/checkout-contract";
import type { Money } from "@/domain/money";
import { PAYOUT_METHODS, type Choices, type Draft, type PayoutChoice } from "./plan";

const payoutSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ORIGINAL") }),
  z.object({ kind: z.literal("METHOD"), method: z.enum(PAYOUT_METHODS) }),
  z.object({
    kind: z.literal("CUSTOM"),
    entries: z.array(
      z.object({ method: z.enum(PAYOUT_METHODS), amount: z.string().regex(/^\d+$/) }),
    ),
  }),
]);

export const exchangeContextSchema = z.object({
  v: z.literal(1),
  refundId: uuidV7,
  saleId: uuid,
  saleNumber: z.string().max(60),
  choices: z.record(
    z.string(),
    z.object({ qtyMilli: z.number().int().positive(), restock: z.boolean() }),
  ),
  reason: z.enum(RETURN_REASONS),
  note: z.string().max(500),
  payout: payoutSchema,
  /** Step 1 is done: the replacement sale exists with this payable. */
  checkedOut: z.object({ saleId: uuidV7, payable: z.string().regex(/^\d+$/) }).nullable(),
});
export type StoredExchange = z.output<typeof exchangeContextSchema>;

export interface ExchangeContext {
  refundId: string;
  saleId: string;
  saleNumber: string;
  draft: Draft & { reason: NonNullable<Draft["reason"]> };
  checkedOut: { saleId: string; payable: Money } | null;
}

export function toStored(context: ExchangeContext): StoredExchange {
  const payout: StoredExchange["payout"] =
    context.draft.payout.kind === "CUSTOM"
      ? {
          kind: "CUSTOM",
          entries: context.draft.payout.entries.map((e) => ({
            method: e.method,
            amount: e.amount.toString(),
          })),
        }
      : context.draft.payout;
  return {
    v: 1,
    refundId: context.refundId,
    saleId: context.saleId,
    saleNumber: context.saleNumber,
    choices: { ...context.draft.choices },
    reason: context.draft.reason,
    note: context.draft.note,
    payout,
    checkedOut: context.checkedOut
      ? { saleId: context.checkedOut.saleId, payable: context.checkedOut.payable.toString() }
      : null,
  };
}

export function fromStored(stored: StoredExchange): ExchangeContext {
  const payout: PayoutChoice =
    stored.payout.kind === "CUSTOM"
      ? {
          kind: "CUSTOM",
          entries: stored.payout.entries.map((e) => ({
            method: e.method,
            amount: BigInt(e.amount),
          })),
        }
      : stored.payout;
  const choices: Choices = stored.choices;
  return {
    refundId: stored.refundId,
    saleId: stored.saleId,
    saleNumber: stored.saleNumber,
    draft: { choices, reason: stored.reason, note: stored.note, payout },
    checkedOut: stored.checkedOut
      ? { saleId: stored.checkedOut.saleId, payable: BigInt(stored.checkedOut.payable) }
      : null,
  };
}

export const exchangeKey = (scope: string) => `pos:exchange:v1:${scope}`;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function loadExchange(store: KeyValueStore | null, scope: string): ExchangeContext | null {
  if (!store) return null;
  try {
    const raw = store.getItem(exchangeKey(scope));
    if (!raw) return null;
    const parsed = exchangeContextSchema.safeParse(JSON.parse(raw));
    return parsed.success ? fromStored(parsed.data) : null;
  } catch {
    return null;
  }
}

export function saveExchange(
  store: KeyValueStore | null,
  scope: string,
  context: ExchangeContext | null,
): void {
  if (!store) return;
  try {
    if (context) store.setItem(exchangeKey(scope), JSON.stringify(toStored(context)));
    else store.removeItem(exchangeKey(scope));
  } catch {
    // Blocked or full storage: the exchange simply is not restored after a reload.
  }
}

/** localStorage, or null where it is blocked (private mode, policy). */
export function browserStore(): KeyValueStore | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
