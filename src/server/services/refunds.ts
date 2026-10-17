import "server-only";
import { can } from "@/domain/access";
import {
  checkoutFingerprint,
  type CheckoutInput,
  type CheckoutResult,
} from "@/domain/checkout-contract";
import {
  isSameRefund,
  toPlanRequest,
  refundApprovalRequirements,
  refundError,
  refundErrorFromIssues,
  refundFingerprint,
  refundResultFromPlan,
  type RefundError,
  type RefundErrorCode,
  type RefundInput,
  type RefundResult,
} from "@/domain/refund-contract";
import { failureFields, REFUND_FAILURE_FIELD } from "@/domain/refund-failure";
import {
  isFullyRefunded,
  planRefund,
  type PaymentMethod,
  type PreviousRefund,
  type RefundPlan,
  type RefundSaleSnapshot,
} from "@/domain/refund";
import { cashUnitForRounding } from "@/domain/tender";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { audit } from "../audit";
import { db, type Tx } from "../db";
import { ActionError, type ActionErrorCode } from "../errors";
import { checkApprovalToken } from "./approval-check";
import { CheckoutFailure, checkoutInTransaction, type CheckoutContext } from "./checkout";
import { confirmIntentPaid } from "./payments";
import { nextSequenceValue } from "./sequence";
import { ProviderTimeoutError, refundThroughProvider } from "./provider-call";
import { postStockMovements } from "./stock";
import { withTxRetry } from "../tx-retry";

/**
 * Refund / return / exchange against an original sale
 * (docs/shifts-refunds-domain.md). Everything is ONE transaction.
 *
 * Idempotency. `refundId` (client UUIDv7) is the Refund primary key. Duplicates
 * queue on a transaction-scoped advisory lock derived from it and replay the
 * stored refund; the stored `fingerprint` turns the same id with other content
 * into IDEMPOTENCY_CONFLICT.
 *
 * Caps under concurrency. After the advisory lock the ORIGINAL sale row is
 * locked FOR UPDATE (a void of the sale takes the same lock), the stored
 * refunds are re-read and `planRefund` runs on that fresh state: two refunds of
 * the same lines serialise, and the second sees the first (ALREADY_REFUNDED /
 * OVER_REFUND). Lock order: refund advisory -> original sale row -> shift
 * (FOR SHARE, like checkout) -> exchange sale advisory (checkout core) ->
 * sale/refund sequence rows -> payment intents -> stock levels.
 * Every refund therefore takes the REFUND sequence row first (right after the
 * approvals), then, for an exchange, the sale sequence row inside the checkout
 * core, then ALL stock levels it will touch in one sorted pass (the sale's
 * lines and the restocked variants together, `alsoLock`). Plain checkouts take
 * sale sequence -> stock levels, voids sale row -> stock levels: the order is
 * the same for everybody, so no cycle. Should Postgres still pick a deadlock
 * victim (40P01 / P2034) the transaction is re-run (same refund id, idempotent).
 *
 * Shift. The refund is booked on the register's CURRENT open shift (cash paid
 * out leaves THAT drawer), not the original sale's shift.
 *
 * Provider payouts (QPay) run last in the transaction, after every database
 * check and write, with an idempotency key and a hard timeout
 * (PROVIDER_REFUND_TIMEOUT_MS); a refusal or a timeout rolls the refund back
 * (PAYMENT_PROVIDER_FAILED, details.retryable on a timeout) and the retry,
 * carrying the same key, cannot pay out twice. Fiscal returns are issued after
 * commit.
 *
 * Exchange. The replacement sale is created by the checkout core in the same
 * transaction with an EXCHANGE_CREDIT payment for the credit; the customer's
 * tenders cover the net due; Refund.exchangeSaleId links both. The stock
 * guard of the replacement sale is deferred until the returned goods are back
 * on the shelf, then re-checked.
 */

export class RefundFailure extends ActionError {
  constructor(
    readonly failure: RefundErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    const fields = failureFields(REFUND_FAILURE_FIELD);
    super(genericCode(failure), failure, {
      [fields.code]: [failure],
      ...(details ? { [fields.details]: [JSON.stringify(details)] } : {}),
    });
    this.name = "RefundFailure";
  }
  static from(error: RefundError): RefundFailure {
    return new RefundFailure(error.code, error.details);
  }
}

function genericCode(code: RefundErrorCode): ActionErrorCode {
  switch (code) {
    case "PERMISSION_DENIED":
      return "FORBIDDEN";
    case "SALE_NOT_FOUND":
      return "NOT_FOUND";
    case "IDEMPOTENCY_CONFLICT":
    case "CONCURRENT_DUPLICATE":
      return "CONFLICT";
    case "SHIFT_NOT_OPEN":
    case "SALE_NOT_COMPLETED":
    case "ALREADY_REFUNDED":
    case "OVER_REFUND":
    case "PAYMENT_PROVIDER_FAILED":
      return "INVALID_STATE";
    case "INTERNAL":
      return "INTERNAL";
    default:
      return "VALIDATION";
  }
}

export interface RefundOptions {
  /** The replacement sale's checkout (tenders = the NET DUE only); required with `exchange`. */
  exchangeCheckout?: CheckoutInput | undefined;
}

export interface RefundOutcome {
  result: RefundResult;
  /** True when this call wrote the refund (the caller schedules fiscal work). */
  created: boolean;
  exchangeSaleId: string | null;
}

/** Client clocks further than this from the server are ignored for Refund.occurredAt. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

const storedArgs = {
  include: {
    lines: true,
    payments: { orderBy: { id: "asc" as const } },
    exchangeSale: { select: { id: true, totalAmount: true, fingerprint: true } },
  },
} satisfies Prisma.RefundDefaultArgs;
type StoredRefund = Prisma.RefundGetPayload<typeof storedArgs>;

const saleArgs = {
  include: {
    location: { select: { code: true } },
    lines: { orderBy: { lineNo: "asc" as const } },
    payments: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
    void: { select: { id: true } },
    refunds: {
      orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
      include: { lines: true, payments: true },
    },
  },
} satisfies Prisma.SaleDefaultArgs;
type LoadedSale = Prisma.SaleGetPayload<typeof saleArgs>;

export async function refundSale(
  input: RefundInput,
  ctx: CheckoutContext,
  options: RefundOptions = {},
  client: PrismaClient = db,
): Promise<RefundOutcome> {
  if (!can(ctx.user, "pos.sell", ctx.device.locationId)) {
    throw new RefundFailure("PERMISSION_DENIED");
  }
  const fingerprint = refundFingerprint(input);
  if (Boolean(input.exchange) !== Boolean(options.exchangeCheckout)) {
    throw new RefundFailure("EXCHANGE_INVALID", { reason: "EXCHANGE_CHECKOUT_REQUIRED" });
  }
  if (input.exchange && options.exchangeCheckout) {
    const checkout = options.exchangeCheckout;
    if (
      checkout.saleId !== input.exchange.saleId ||
      checkout.expectedPayable !== input.exchange.expectedPayable
    ) {
      throw new RefundFailure("EXCHANGE_MISMATCH");
    }
  }

  // Fast path for plain replays (no provider calls, no locks).
  const existing = await client.refund.findUnique({ where: { id: input.refundId }, ...storedArgs });
  if (existing) return replay(client, existing, input, options, ctx);

  // QPay tenders of the replacement sale are re-verified BEFORE the transaction
  // (a slow provider must not hold row locks), as in checkout.
  for (const tender of options.exchangeCheckout?.tenders ?? []) {
    if (tender.method === "QPAY" && tender.paymentIntentId) {
      if (!(await confirmIntentPaid(tender.paymentIntentId))) {
        throw new RefundFailure("EXCHANGE_INVALID", {
          checkout: "PAYMENT_NOT_CONFIRMED",
          paymentIntentId: tender.paymentIntentId,
        });
      }
    }
  }

  try {
    return await withTxRetry(() =>
      client.$transaction((tx) => runRefund(tx, input, fingerprint, options, ctx), {
        maxWait: 15_000,
        timeout: 30_000,
      }),
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const winner = await client.refund.findUnique({
        where: { id: input.refundId },
        ...storedArgs,
      });
      if (winner) return replay(client, winner, input, options, ctx);
      throw new RefundFailure("CONCURRENT_DUPLICATE");
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

async function replay(
  client: PrismaClient | Tx,
  stored: StoredRefund,
  input: RefundInput,
  options: RefundOptions,
  ctx: CheckoutContext,
): Promise<RefundOutcome> {
  if (stored.locationId !== ctx.device.locationId) throw new RefundFailure("SALE_NOT_FOUND");
  if (
    stored.saleId !== input.saleId ||
    stored.registerId !== ctx.device.registerId ||
    (stored.fingerprint !== null && !isSameRefund(stored.fingerprint, input))
  ) {
    throw new RefundFailure("IDEMPOTENCY_CONFLICT");
  }
  if (
    options.exchangeCheckout &&
    (stored.exchangeSale?.id !== options.exchangeCheckout.saleId ||
      (stored.exchangeSale.fingerprint !== null &&
        stored.exchangeSale.fingerprint !== checkoutFingerprint(options.exchangeCheckout)))
  ) {
    throw new RefundFailure("IDEMPOTENCY_CONFLICT");
  }
  const sale = await client.sale.findUniqueOrThrow({
    where: { id: stored.saleId },
    ...saleArgs,
  });
  return {
    result: resultFromStored(stored, sale, true),
    created: false,
    exchangeSaleId: stored.exchangeSaleId,
  };
}

function resultFromStored(stored: StoredRefund, sale: LoadedSale, replayed: boolean): RefundResult {
  const snapshot = saleSnapshot(sale, new Map());
  const last = sale.refunds[sale.refunds.length - 1];
  const completesSale = last?.id === stored.id && isFullyRefunded(snapshot, previousRefunds(sale));
  const credit = stored.payments
    .filter((p) => p.method === "EXCHANGE_CREDIT")
    .reduce((acc, p) => acc + p.amount, 0n);
  const itemsTotal = stored.lines.reduce((acc, l) => acc + l.totalAmount, 0n);
  return {
    refundId: stored.id,
    receiptNumber: stored.number,
    saleId: stored.saleId,
    totals: {
      itemsTotal,
      netAmount: stored.netAmount,
      vatAmount: stored.vatAmount,
      cityTaxAmount: stored.cityTaxAmount,
      tipAmount: stored.tipAmount,
      roundingAmount: stored.roundingAmount,
      totalAmount: stored.totalAmount,
    },
    lines: stored.lines.map((l) => ({
      saleLineId: l.saleLineId,
      qtyMilli: l.qtyMilli,
      restock: l.restock,
      totalAmount: l.totalAmount,
    })),
    payments: stored.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      originalPaymentId: p.originalPaymentId,
    })),
    cashRefund: stored.payments
      .filter((p) => p.method === "CASH")
      .reduce((acc, p) => acc + p.amount, 0n),
    exchange: stored.exchangeSale
      ? {
          saleId: stored.exchangeSale.id,
          creditApplied: credit,
          netDue: stored.exchangeSale.totalAmount - credit,
          netRefund: stored.totalAmount - credit,
        }
      : null,
    completesSale,
    replayed,
  };
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

function previousRefunds(sale: LoadedSale): PreviousRefund[] {
  return sale.refunds.map((r) => ({
    id: r.id,
    totalAmount: r.totalAmount,
    tipAmount: r.tipAmount,
    lines: r.lines.map((l) => ({
      saleLineId: l.saleLineId,
      qtyMilli: l.qtyMilli,
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
      cityTaxAmount: l.cityTaxAmount,
      totalAmount: l.totalAmount,
    })),
    payments: r.payments.map((p) => ({
      method: p.method,
      amount: p.amount,
      originalPaymentId: p.originalPaymentId,
    })),
  }));
}

/** `tracksStock` per variant id (default true when unknown). */
function saleSnapshot(sale: LoadedSale, tracksStock: Map<string, boolean>): RefundSaleSnapshot {
  return {
    id: sale.id,
    status: sale.void ? "VOIDED" : "COMPLETED",
    occurredAt: sale.occurredAt,
    shiftId: sale.shiftId,
    totalAmount: sale.totalAmount,
    tipAmount: sale.tipAmount,
    roundingAmount: sale.roundingAmount,
    lines: sale.lines.map((l) => ({
      id: l.id,
      variantId: l.variantId,
      unit: l.unit,
      qtyMilli: l.qtyMilli,
      totalAmount: l.totalAmount,
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
      cityTaxAmount: l.cityTaxAmount,
      unitCost: l.unitCost,
      tracksStock: tracksStock.get(l.variantId) ?? true,
      isGiftCard: l.productType === "GIFT_CARD",
      pricesIncludeTax: l.pricesIncludeTax,
    })),
    payments: sale.payments.map((p) => ({
      id: p.id,
      method: p.method as PaymentMethod,
      amount: p.amount,
      change: p.change,
    })),
  };
}

// ---------------------------------------------------------------------------
// The transaction
// ---------------------------------------------------------------------------

async function runRefund(
  tx: Tx,
  input: RefundInput,
  fingerprint: string,
  options: RefundOptions,
  ctx: CheckoutContext,
): Promise<RefundOutcome> {
  const { user, device } = ctx;
  const now = ctx.now ?? new Date();

  // 1. Serialise duplicates of this refund id; a loser replays the winner.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.refundId}, 0))`;
  const stored = await tx.refund.findUnique({ where: { id: input.refundId }, ...storedArgs });
  if (stored) return replay(tx, stored, input, options, ctx);

  // 2. The original sale, locked: refunds (and a void) of it serialise here.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Sale" WHERE "id" = ${input.saleId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new RefundFailure("SALE_NOT_FOUND");
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: input.saleId }, ...saleArgs });
  if (sale.locationId !== device.locationId) throw new RefundFailure("SALE_NOT_FOUND");

  // 3. The register's CURRENT open shift (shared lock: a closing shift waits for us).
  const shifts = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Shift"
    WHERE "registerId" = ${device.registerId}::uuid AND "status" = 'OPEN'::"ShiftStatus"
    FOR SHARE`;
  const shift = shifts[0];

  // 4. Settings and the stock facts of the original lines.
  const settingsRow = await tx.businessSettings.findUnique({ where: { id: 1 } });
  const roundingUnit = settingsRow?.totalRoundingUnit ?? 100n;
  const moved = new Set(
    (
      await tx.stockMovement.findMany({
        where: { saleId: sale.id, type: "SALE" },
        select: { variantId: true },
      })
    ).map((m) => m.variantId),
  );
  const trackedNow = new Map(
    (
      await tx.productVariant.findMany({
        where: { id: { in: sale.lines.map((l) => l.variantId) } },
        select: { id: true, product: { select: { trackStock: true, type: true } } },
      })
    ).map((v) => [v.id, v.product.trackStock && v.product.type === "STANDARD"]),
  );
  const tracksStock = new Map(
    sale.lines.map((l) => [
      l.variantId,
      moved.has(l.variantId) && trackedNow.get(l.variantId) === true,
    ]),
  );

  // 5. Plan. First with every grant (the plan itself does not depend on them),
  // then work out which approvals this exact refund needs.
  const snapshot = saleSnapshot(sale, tracksStock);
  const previous = previousRefunds(sale);
  const planned = planRefund(snapshot, previous, toPlanRequest(input), {
    shiftOpen: shift !== undefined,
    now,
    roundingUnit,
    cashUnit: cashUnitForRounding(roundingUnit),
    policy: { maxRefundWindowDays: settingsRow?.refundWindowDays ?? null },
    grants: { refund: true, methodOverride: true, outsideWindow: true },
  });
  if (!planned.ok) throw RefundFailure.from(refundErrorFromIssues(planned.issues));
  const plan = planned.plan;
  if (plan.totalAmount !== input.expectedTotal) {
    throw new RefundFailure("TOTAL_MISMATCH", {
      expected: input.expectedTotal.toString(),
      actual: plan.totalAmount.toString(),
    });
  }
  if (Boolean(plan.exchange) !== Boolean(options.exchangeCheckout)) {
    throw new RefundFailure("EXCHANGE_INVALID");
  }

  // 6. Approvals, each bound to the exact value (scope builders in the contract).
  const approvers = await resolveApprovals(tx, input, plan, ctx);

  // 7. The refund number FIRST: the refund sequence row is the first sequence /
  // stock lock of every refund (see the lock order above).
  const locationCode = sale.location.code;
  const number = `${locationCode}-R-${String(await nextSequenceValue(tx, `refund:${locationCode}`)).padStart(6, "0")}`;

  // 8. Exchange: the replacement sale, in this transaction. It locks the stock
  // levels of the returned goods together with its own lines.
  let exchangeSale: CheckoutResult | null = null;
  if (plan.exchange && options.exchangeCheckout) {
    exchangeSale = await createExchangeSale(
      tx,
      options.exchangeCheckout,
      input.refundId,
      plan.exchange.creditApplied,
      ctx,
      [...new Set(plan.stockRestores.map((s) => s.variantId))],
    );
  }

  // 9. Refund, lines.
  const clientTime = new Date(input.createdAtClient);
  const occurredAt =
    Number.isFinite(clientTime.getTime()) &&
    Math.abs(clientTime.getTime() - now.getTime()) <= MAX_CLOCK_SKEW_MS
      ? clientTime
      : now;
  const approvedById = approvers.get("refund") ?? [...approvers.values()][0] ?? null;

  await tx.refund.create({
    data: {
      id: input.refundId,
      number,
      saleId: sale.id,
      locationId: device.locationId,
      registerId: device.registerId,
      shiftId: shift!.id,
      customerId: sale.customerId,
      processedById: user.id,
      approvedById,
      reason: input.reason,
      note: input.note ?? null,
      netAmount: plan.netAmount,
      vatAmount: plan.vatAmount,
      cityTaxAmount: plan.cityTaxAmount,
      tipAmount: plan.tipAmount,
      roundingAmount: plan.roundingAmount,
      totalAmount: plan.totalAmount,
      exchangeSaleId: exchangeSale?.saleId ?? null,
      fingerprint,
      occurredAt,
    },
  });
  await tx.refundLine.createMany({
    data: plan.lines.map((l) => ({
      refundId: input.refundId,
      saleLineId: l.saleLineId,
      qtyMilli: l.qtyMilli,
      restock: l.restock,
      reason: l.reason ?? null,
      netAmount: l.netAmount,
      vatAmount: l.vatAmount,
      cityTaxAmount: l.cityTaxAmount,
      totalAmount: l.totalAmount,
      unitCost: l.unitCost,
    })),
  });

  // 10. Stock back at the original cost snapshot (ledger + cache, one transaction).
  if (plan.stockRestores.length > 0) {
    await postStockMovements(tx, {
      locationId: sale.locationId,
      type: "RETURN_RESTOCK",
      createdById: user.id,
      note: number,
      refs: { refundId: input.refundId, saleId: sale.id },
      lines: plan.stockRestores.map((s) => ({
        variantId: s.variantId,
        qtyDeltaMilli: s.qtyMilli,
        unitCost: s.unitCost,
      })),
    });
  }
  if (exchangeSale && settingsRow && !settingsRow.allowNegativeStock) {
    await assertExchangeStock(tx, exchangeSale.saleId, sale.locationId);
  }

  // 11. Audit (cheap, before the provider so a slow provider holds locks as briefly as possible).
  await audit(tx, {
    actorId: user.id,
    action: "refund.create",
    entityType: "Refund",
    entityId: input.refundId,
    locationId: device.locationId,
    registerId: device.registerId,
    after: {
      number,
      saleId: sale.id,
      saleNumber: sale.number,
      total: plan.totalAmount.toString(),
      reason: input.reason,
      completesSale: plan.completesSale,
      lines: plan.lines.map((l) => ({
        saleLineId: l.saleLineId,
        qtyMilli: l.qtyMilli,
        restock: l.restock,
        total: l.totalAmount.toString(),
      })),
      payments: plan.payments.map((p) => ({ method: p.method, amount: p.amount.toString() })),
      exchangeSaleId: exchangeSale?.saleId ?? null,
    },
    meta: {
      deviceId: device.deviceId,
      shiftId: shift!.id,
      approvedById,
      crossMethod: plan.needs.methodOverride,
      outsideWindow: plan.needs.outsideWindow,
    },
    ...ctx.meta,
  });
  for (const [key, approverId] of approvers) {
    await audit(tx, {
      actorId: approverId,
      action: "refund.approval_used",
      entityType: "Refund",
      entityId: input.refundId,
      locationId: device.locationId,
      registerId: device.registerId,
      meta: { key, requestedById: user.id, deviceId: device.deviceId },
      ...ctx.meta,
    });
  }

  // 12. Payouts: providers LAST (hard timeout, idempotency key), then the RefundPayment rows.
  const paymentRows = await payOut(tx, sale, plan, input.refundId, exchangeSale?.saleId ?? null);
  await tx.refundPayment.createMany({ data: paymentRows });

  return {
    result: refundResultFromPlan(input, number, plan, false),
    created: true,
    exchangeSaleId: exchangeSale?.saleId ?? null,
  };
}

// ---------------------------------------------------------------------------

/**
 * Approvals the plan needs. The actor's own permission covers `refund`
 * (`pos.refund`) and the override / window grants (`pos.refund.approve`);
 * otherwise a token from a manager, bound to the exact scope. Returns
 * requirement key -> approving user id (only for token approvals).
 */
async function resolveApprovals(
  tx: Tx,
  input: RefundInput,
  plan: RefundPlan,
  ctx: CheckoutContext,
): Promise<Map<string, string>> {
  const { user, device } = ctx;
  const out = new Map<string, string>();
  const missing: { key: string; scope: string; value: string }[] = [];
  for (const req of refundApprovalRequirements(input.refundId, input.saleId, plan)) {
    const own =
      req.key === "refund"
        ? can(user, "pos.refund", device.locationId)
        : can(user, "pos.refund.approve", device.locationId);
    if (own) continue;
    const token = input.approvals[req.key];
    if (!token) {
      missing.push({ key: req.key, scope: req.scope, value: req.value });
      continue;
    }
    const checked = await checkApprovalToken(
      tx,
      token,
      {
        permission: req.permission,
        scope: req.scope,
        deviceId: device.deviceId,
        locationId: device.locationId,
      },
      ctx.now,
    );
    if (!checked.ok) throw new RefundFailure("APPROVAL_INVALID", { key: req.key });
    out.set(req.key, checked.approverId);
  }
  if (missing.length > 0) {
    const window = missing.find((m) => m.key === "refund:window");
    if (window) {
      throw RefundFailure.from(
        refundError("REFUND_WINDOW_EXCEEDED", { key: window.key, required: missing }),
      );
    }
    throw RefundFailure.from(
      refundError("APPROVAL_REQUIRED", { key: missing[0]!.key, required: missing }),
    );
  }
  return out;
}

async function createExchangeSale(
  tx: Tx,
  checkout: CheckoutInput,
  refundId: string,
  credit: bigint,
  ctx: CheckoutContext,
  restockVariantIds: readonly string[],
): Promise<CheckoutResult> {
  if (await tx.sale.findUnique({ where: { id: checkout.saleId }, select: { id: true } })) {
    throw new RefundFailure("EXCHANGE_INVALID", { reason: "EXCHANGE_SALE_EXISTS" });
  }
  try {
    return await checkoutInTransaction(tx, checkout, ctx, {
      refundId,
      amount: credit,
      deferStockGuard: true,
      alsoLockVariantIds: restockVariantIds,
    });
  } catch (error) {
    if (error instanceof CheckoutFailure) {
      switch (error.failure) {
        case "TOTAL_MISMATCH":
          throw new RefundFailure("EXCHANGE_MISMATCH", error.details);
        case "APPROVAL_REQUIRED":
        case "APPROVAL_INVALID":
          throw new RefundFailure(error.failure, { ...error.details, exchange: true });
        case "SHIFT_REQUIRED":
          throw new RefundFailure("SHIFT_NOT_OPEN");
        case "INTERNAL":
          throw new RefundFailure("INTERNAL", error.details);
        default:
          throw new RefundFailure("EXCHANGE_INVALID", {
            checkout: error.failure,
            ...error.details,
          });
      }
    }
    throw error;
  }
}

/** With allowNegativeStock=false the replacement items must exist once the returns are back. */
async function assertExchangeStock(tx: Tx, saleId: string, locationId: string): Promise<void> {
  const negative = await tx.$queryRaw<{ variantId: string }[]>`
    SELECT l."variantId" FROM "StockLevel" l
    WHERE l."locationId" = ${locationId}::uuid AND l."onHandMilli" < 0
      AND l."variantId" IN (SELECT "variantId" FROM "SaleLine" WHERE "saleId" = ${saleId}::uuid)`;
  if (negative.length > 0) {
    throw new RefundFailure("EXCHANGE_INVALID", {
      checkout: "INSUFFICIENT_STOCK",
      variantIds: negative.map((n) => n.variantId),
    });
  }
}

/**
 * RefundPayment rows. CASH leaves the drawer (no provider); CARD / BANK keep the
 * original reference for the reversal on the terminal / statement; QPAY is
 * refunded through the provider; EXCHANGE_CREDIT points at the exchange sale.
 */
async function payOut(
  tx: Tx,
  sale: LoadedSale,
  plan: RefundPlan,
  refundId: string,
  exchangeSaleId: string | null,
): Promise<Prisma.RefundPaymentCreateManyInput[]> {
  const originals = new Map(sale.payments.map((p) => [p.id, p]));
  const rows: Prisma.RefundPaymentCreateManyInput[] = [];
  // Already paid back through QPAY per original payment, for the intent state.
  const qpayDone = new Map<string, bigint>();
  for (const refund of sale.refunds) {
    for (const p of refund.payments) {
      if (p.method === "QPAY" && p.originalPaymentId) {
        qpayDone.set(p.originalPaymentId, (qpayDone.get(p.originalPaymentId) ?? 0n) + p.amount);
      }
    }
  }
  for (const payment of plan.payments) {
    const original = payment.originalPaymentId
      ? originals.get(payment.originalPaymentId)
      : undefined;
    let reference: string | null = null;
    if (payment.method === "QPAY") {
      const intent = original?.paymentIntentId
        ? await tx.paymentIntent.findUnique({ where: { id: original.paymentIntentId } })
        : null;
      if (!original || !intent?.providerRef) {
        throw new RefundFailure("PAYMENT_PROVIDER_FAILED", { method: "QPAY" });
      }
      let outcome;
      try {
        outcome = await refundThroughProvider({
          providerRef: intent.providerRef,
          amount: payment.amount,
          reason: "refund",
          idempotencyKey: `refund:${refundId}:${original.id}`,
        });
      } catch (error) {
        // A timeout is retryable as is: the same key reaches the provider again.
        throw new RefundFailure(
          "PAYMENT_PROVIDER_FAILED",
          error instanceof ProviderTimeoutError
            ? { method: "QPAY", timedOut: true, retryable: true }
            : { method: "QPAY" },
        );
      }
      if (outcome.status !== "REFUNDED") {
        throw new RefundFailure("PAYMENT_PROVIDER_FAILED", { method: "QPAY" });
      }
      reference = outcome.refundRef ?? null;
      const total = (qpayDone.get(original.id) ?? 0n) + payment.amount;
      qpayDone.set(original.id, total);
      if (total >= intent.amount && intent.status !== "REFUNDED") {
        await tx.paymentIntent.update({ where: { id: intent.id }, data: { status: "REFUNDED" } });
      }
    } else if (payment.method === "CARD" || payment.method === "BANK_TRANSFER") {
      reference = original?.reference ?? null;
    } else if (payment.method === "EXCHANGE_CREDIT") {
      reference = exchangeSaleId;
    }
    rows.push({
      refundId,
      method: payment.method,
      amount: payment.amount,
      originalPaymentId: payment.originalPaymentId,
      reference,
    });
  }
  return rows;
}
