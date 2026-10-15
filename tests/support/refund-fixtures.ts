import { v7 as uuidv7 } from "uuid";
import { expect } from "vitest";
import { computeTotals, type CatalogSnapshot } from "@/domain/cart";
import type { CheckoutInputWire } from "@/domain/checkout-contract";
import {
  refundRequestSchema,
  type RefundInput,
  type RefundInputWire,
} from "@/domain/refund-contract";
import { voidInputSchema, type VoidInput } from "@/domain/void-contract";
import { markMockInvoicePaid } from "@/server/adapters/payments";
import { signApproval } from "@/server/auth/approval";
import { checkoutSale } from "@/server/services/checkout";
import { createQpayInvoice } from "@/server/services/payments";
import { refundSale, RefundFailure, type RefundOptions } from "@/server/services/refunds";
import { VoidFailure, voidSale } from "@/server/services/voids";
import { db } from "./db";
import { buildInput, lineOf, type Till } from "./checkout-fixtures";

type LineWire = CheckoutInputWire["lines"][number];

/** The payable the server will compute for these lines (tax-inclusive catalog prices, no cart discounts). */
export async function quotePayable(lines: LineWire[], roundingUnit = 100n): Promise<bigint> {
  const variants = await db.productVariant.findMany({
    where: { id: { in: lines.map((l) => l.variantId!) } },
    include: { product: { include: { taxClass: true } } },
  });
  const catalog: CatalogSnapshot = {
    variants: Object.fromEntries(
      variants.map((v) => [
        v.id,
        {
          variantId: v.id,
          unit: v.product.unit,
          price: v.price,
          pricesIncludeTax: v.product.pricesIncludeTax,
          taxTreatment: v.product.taxClass.treatment,
          vatRateBps: v.product.taxClass.vatRateBps,
          cityTaxRateBps: v.product.taxClass.cityTaxRateBps,
        },
      ]),
    ),
  };
  const price = new Map(variants.map((v) => [v.id, v.price]));
  const totals = computeTotals(
    {
      lines: lines.map((l) => ({
        lineId: l.lineId,
        variantId: l.variantId!,
        qtyMilli: l.qtyMilli!,
        unitPrice: price.get(l.variantId!)!,
        discounts: (l.discounts ?? []).map((d) => ({ ...d })) as never,
      })),
      discounts: [],
    },
    catalog,
    { totalRoundingUnit: roundingUnit },
  );
  return totals.payable;
}

export type TenderPlan = (payable: bigint) => CheckoutInputWire["tenders"];

export const cashAll: TenderPlan = (p) => [{ method: "CASH", amount: p.toString() }];

/** A completed sale at the till; returns ids and the stored rows. */
export async function sell(
  till: Till,
  items: { variantId: string; qtyMilli?: number; discountBps?: number }[],
  tenders: TenderPlan = cashAll,
  options: { saleId?: string; user?: Parameters<Till["ctx"]>[0] } = {},
) {
  const lines = items.map((i) =>
    lineOf(i.variantId, i.qtyMilli ?? 1000, {
      discounts: i.discountBps ? [{ kind: "PERCENT", percentBps: i.discountBps }] : [],
    }),
  );
  const payable = await quotePayable(lines);
  const input = buildInput({
    ...(options.saleId ? { saleId: options.saleId } : {}),
    lines,
    expectedPayable: payable.toString(),
    tenders: tenders(payable),
  });
  await checkoutSale(input, till.ctx(options.user));
  return { saleId: input.saleId, payable, ...(await loadSale(input.saleId)) };
}

export async function loadSale(saleId: string) {
  const sale = await db.sale.findUniqueOrThrow({
    where: { id: saleId },
    include: {
      lines: { orderBy: { lineNo: "asc" } },
      payments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  return { sale, lines: sale.lines, payments: sale.payments };
}

export type RefundLineWire = RefundInputWire["lines"][number];

/** All remaining quantity of every line. */
export function allLines(lines: { id: string; qtyMilli: number }[], restock = true) {
  return lines.map((l) => ({ saleLineId: l.id, qtyMilli: l.qtyMilli, restock }));
}

export function refundInputOf(
  saleId: string,
  lines: RefundLineWire[],
  extra: Partial<Omit<RefundInputWire, "lines" | "saleId">> = {},
): RefundInput {
  return refundRequestSchema.parse({
    refundId: uuidv7(),
    saleId,
    lines,
    reason: "CHANGED_MIND",
    expectedTotal: "0",
    approvals: {},
    createdAtClient: new Date().toISOString(),
    ...extra,
  });
}

type Ctx = ReturnType<Till["ctx"]>;

/** Fill in `expectedTotal` by asking the server (TOTAL_MISMATCH carries the actual total). */
export async function withTotal(
  input: RefundInput,
  ctx: Ctx,
  options: RefundOptions = {},
): Promise<RefundInput> {
  try {
    await refundSale(input, ctx, options);
  } catch (error) {
    if (error instanceof RefundFailure && error.failure === "TOTAL_MISMATCH") {
      return { ...input, expectedTotal: BigInt(String(error.details!.actual)) };
    }
    throw error;
  }
  throw new Error("expected TOTAL_MISMATCH while quoting");
}

export async function refundOk(
  till: Till,
  saleId: string,
  lines: RefundLineWire[],
  extra: Partial<Omit<RefundInputWire, "lines" | "saleId">> = {},
  user?: Parameters<Till["ctx"]>[0],
  options: RefundOptions = {},
  nowOverride?: Date,
) {
  const ctx = { ...till.ctx(user), ...(nowOverride ? { now: nowOverride } : {}) };
  const input = await withTotal(refundInputOf(saleId, lines, extra), ctx, options);
  const outcome = await refundSale(input, ctx, options);
  return { input, outcome, result: outcome.result };
}

export async function refundFailure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RefundFailure);
    return error as RefundFailure;
  }
  throw new Error("expected the refund to fail");
}

export async function voidFailure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(VoidFailure);
    return error as VoidFailure;
  }
  throw new Error("expected the void to fail");
}

export function voidInputOf(saleId: string, extra: Record<string, unknown> = {}): VoidInput {
  return voidInputSchema.parse({
    saleId,
    reason: "ENTRY_ERROR",
    approvals: {},
    createdAtClient: new Date().toISOString(),
    ...extra,
  });
}

export const doVoid = (
  till: Till,
  saleId: string,
  extra: Record<string, unknown> = {},
  user?: Parameters<Till["ctx"]>[0],
) => voidSale(voidInputOf(saleId, extra), till.ctx(user));

/** A manager approval token for this device, permission and scope. */
export function approvalToken(
  till: Till,
  permission: "pos.void" | "pos.refund.approve",
  scope: string,
  now?: Date,
  approverId = till.manager.id,
): string {
  return signApproval({ approverId, permission, scope, deviceId: till.device.id }, now);
}

/** A PAID QPay invoice for the sale about to be rung up. */
export async function paidQpayIntent(till: Till, saleId: string, amount: bigint) {
  const invoice = await createQpayInvoice({ saleId, amount }, till.ctx().user, till.ctx().device, {
    ip: null,
    userAgent: null,
  });
  const intent = await db.paymentIntent.findUniqueOrThrow({ where: { id: invoice.intentId } });
  markMockInvoicePaid(intent.providerRef!);
  return { intentId: invoice.intentId, providerRef: intent.providerRef! };
}

/** Stock on hand of a variant at the till's location. */
export async function onHand(till: Till, variantId: string): Promise<number> {
  return (
    (
      await db.stockLevel.findUnique({
        where: { variantId_locationId: { variantId, locationId: till.location.id } },
      })
    )?.onHandMilli ?? 0
  );
}

export { uuidv7 };
