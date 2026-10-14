import "server-only";
import { v7 as uuidv7 } from "uuid";
import { can, canAccessLocation } from "@/domain/access";
import {
  computeTotalsDetailed,
  requiredApprovals,
  type CartLine,
  type CatalogSnapshot,
  type CatalogVariant,
} from "@/domain/cart";
import { variantLabel } from "@/domain/catalog";
import {
  CHECKOUT_FAILURE_DETAILS_FIELD,
  CHECKOUT_FAILURE_FIELD,
  type CheckoutFailureCode,
} from "@/domain/checkout-failure";
import {
  cartFromCheckoutInput,
  checkoutErrorFromTender,
  checkoutFingerprint,
  type CheckoutInput,
  type CheckoutResult,
} from "@/domain/checkout-contract";
import { DEFAULT_APPROVAL_POLICY, approvalKeys } from "@/domain/discounts";
import { hasPermission, type ApprovablePermission } from "@/domain/permissions";
import {
  DEFAULT_SCALE_RULES,
  normalizePlu,
  parseScaleBarcode,
  scaleBarcodeRulesSchema,
  type ScaleBarcodeRule,
} from "@/domain/scale-barcode";
import { cashUnitForRounding, validateTenders, type Tender } from "@/domain/tender";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { audit } from "../audit";
import { verifyApproval } from "../auth/approval";
import type { CurrentUser } from "../auth/session";
import { randomToken } from "../crypto";
import { db, type Tx } from "../db";
import { ActionError, type ActionErrorCode } from "../errors";
import type { RequestMeta } from "../request";
import { confirmIntentPaid } from "./payments";
import type { RegisterContext } from "./register-context";
import { nextSequenceValue } from "./sequence";
import { postStockMovements } from "./stock";

/**
 * The checkout transaction (docs/PLAN.md section 3).
 *
 * Idempotency. The client's UUIDv7 is the Sale primary key and the
 * idempotency key. Everything runs in ONE transaction that first takes a
 * transaction-scoped advisory lock derived from the sale id, so duplicates of
 * the same sale queue up instead of racing; whoever gets the lock after the
 * first commit finds the stored sale and replays it. The Sale row also keeps
 * the checkout fingerprint: the same id with different content is
 * IDEMPOTENCY_CONFLICT. A PK conflict that still slips through (a writer
 * outside the lock) is answered by re-reading the committed sale.
 *
 * Authority. Prices, tax classes and settings are reloaded from the database
 * and every total is recomputed with the shared domain code; the client's
 * `expectedPayable` is only compared (TOTAL_MISMATCH), never used.
 *
 * Receipt numbers. "<location code>-<6 digits>" from the gap-free Sequence
 * `sale:<locationCode>`, incremented inside this transaction: a rolled back
 * checkout gives its number back, and checkouts at one location serialise on
 * the counter row for the rest of their transaction (the price of no gaps).
 * Lock order is always: sale advisory lock, shift (shared), sequence row,
 * payment intents, stock levels (by variant id) — so no deadlocks.
 *
 * Approvals. The cashier needs the permission for a price override /
 * above-policy discount, or a token from `grantApproval`
 * (src/server/auth/approval.ts) bound to permission, device and scope. The
 * accepted scope is the sale id (or `<saleId>:<approval key>`).
 *
 * Stock. Tracked STANDARD items post SALE movements through
 * postStockMovements; BusinessSettings.allowNegativeStock=false turns an
 * insufficient balance into INSUFFICIENT_STOCK, otherwise the sale goes
 * through (negative stock is a warning, decision 6). Sales created here are
 * online, so `requiresReview` stays false (it is for offline replays).
 */

export class CheckoutFailure extends ActionError {
  constructor(
    readonly failure: CheckoutFailureCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(genericCode(failure), failure, {
      [CHECKOUT_FAILURE_FIELD]: [failure],
      ...(details ? { [CHECKOUT_FAILURE_DETAILS_FIELD]: [JSON.stringify(details)] } : {}),
    });
    this.name = "CheckoutFailure";
  }
}

function genericCode(failure: CheckoutFailureCode): ActionErrorCode {
  switch (failure) {
    case "INSUFFICIENT_STOCK":
      return "INSUFFICIENT_STOCK";
    case "IDEMPOTENCY_CONFLICT":
    case "CONCURRENT_DUPLICATE":
    case "SALE_OWNERSHIP_MISMATCH":
      return "CONFLICT";
    case "PERMISSION_DENIED":
      return "FORBIDDEN";
    case "SHIFT_REQUIRED":
      return "INVALID_STATE";
    case "INTERNAL":
      return "INTERNAL";
    default:
      return "VALIDATION";
  }
}

export interface CheckoutContext {
  user: Pick<CurrentUser, "id" | "role" | "locationIds">;
  device: RegisterContext;
  meta: RequestMeta;
  /** Injectable clock (tests). */
  now?: Date;
}

/** Client clocks further than this from the server are ignored for Sale.occurredAt. */
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;

const storedSaleArgs = {
  include: {
    lines: { select: { grossAmount: true } },
    payments: { orderBy: { createdAt: "asc" as const } },
  },
} satisfies Prisma.SaleDefaultArgs;
type StoredSale = Prisma.SaleGetPayload<typeof storedSaleArgs>;

export async function checkoutSale(
  input: CheckoutInput,
  ctx: CheckoutContext,
  client: PrismaClient = db,
): Promise<CheckoutResult> {
  const fingerprint = checkoutFingerprint(input);

  // Fast path for plain replays (no transaction, no provider calls).
  const existing = await client.sale.findUnique({ where: { id: input.saleId }, ...storedSaleArgs });
  if (existing) return replay(existing, fingerprint, ctx);

  if (!can(ctx.user, "pos.sell", ctx.device.locationId)) {
    throw new CheckoutFailure("PERMISSION_DENIED");
  }

  // QPay is re-verified with the provider BEFORE the transaction: a slow
  // provider must not hold row locks. The transaction then re-reads the
  // (provider-confirmed) intents under lock.
  for (const tender of input.tenders) {
    if (tender.method === "QPAY" && tender.paymentIntentId) {
      if (!(await confirmIntentPaid(tender.paymentIntentId))) {
        throw new CheckoutFailure("PAYMENT_NOT_CONFIRMED", {
          paymentIntentId: tender.paymentIntentId,
        });
      }
    }
  }

  try {
    return await client.$transaction((tx) => runCheckout(tx, input, fingerprint, ctx), {
      maxWait: 15_000,
      timeout: 30_000,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Someone else committed this sale id (or reused a payment intent) first.
      const winner = await client.sale.findUnique({
        where: { id: input.saleId },
        ...storedSaleArgs,
      });
      if (winner) return replay(winner, fingerprint, ctx);
      throw new CheckoutFailure("CONCURRENT_DUPLICATE");
    }
    throw error;
  }
}

function replay(stored: StoredSale, fingerprint: string, ctx: CheckoutContext): CheckoutResult {
  if (stored.cashierId !== ctx.user.id || stored.registerId !== ctx.device.registerId) {
    throw new CheckoutFailure("SALE_OWNERSHIP_MISMATCH");
  }
  if (stored.fingerprint !== null && stored.fingerprint !== fingerprint) {
    throw new CheckoutFailure("IDEMPOTENCY_CONFLICT");
  }
  return toResult(stored, true);
}

function toResult(sale: StoredSale, replayed: boolean): CheckoutResult {
  const subtotal = sale.lines.reduce((acc, l) => acc + l.grossAmount, 0n);
  return {
    saleId: sale.id,
    receiptNumber: sale.number,
    status: sale.requiresReview ? "COMPLETED_NEEDS_REVIEW" : "COMPLETED",
    totals: {
      subtotal,
      discountTotal: sale.discountAmount,
      netTotal: sale.netAmount,
      vatTotal: sale.vatAmount,
      cityTotal: sale.cityTaxAmount,
      total: sale.itemsAmount,
      roundingAmount: sale.roundingAmount,
      payable: sale.totalAmount,
    },
    payments: sale.payments.map((p) => ({
      method: p.method as CheckoutResult["payments"][number]["method"],
      amount: p.amount,
      tendered: p.tendered,
      change: p.change,
      ...(p.reference ? { reference: p.reference } : {}),
    })),
    change: sale.payments.reduce((acc, p) => acc + p.change, 0n),
    shareToken: sale.publicToken,
    replayed,
  };
}

// ---------------------------------------------------------------------------

type LoadedVariant = Prisma.ProductVariantGetPayload<{
  include: { product: { include: { taxClass: true } } };
}>;

async function runCheckout(
  tx: Tx,
  input: CheckoutInput,
  fingerprint: string,
  ctx: CheckoutContext,
): Promise<CheckoutResult> {
  const { user, device } = ctx;
  const now = ctx.now ?? new Date();

  // 1. Serialise duplicates of this sale id; a loser replays the winner.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.saleId}, 0))`;
  const stored = await tx.sale.findUnique({ where: { id: input.saleId }, ...storedSaleArgs });
  if (stored) return replay(stored, fingerprint, ctx);

  // 2. An OPEN shift on this device's register (shared lock: a closing shift waits for us).
  const shifts = await tx.$queryRaw<{ id: string; locationId: string }[]>`
    SELECT "id", "locationId" FROM "Shift"
    WHERE "registerId" = ${device.registerId}::uuid AND "status" = 'OPEN'::"ShiftStatus"
    FOR SHARE`;
  const shift = shifts[0];
  if (!shift || shift.locationId !== device.locationId) throw new CheckoutFailure("SHIFT_REQUIRED");

  // 3. Authoritative data from the database.
  const [settingsRow, location] = await Promise.all([
    tx.businessSettings.findUnique({ where: { id: 1 } }),
    tx.location.findUnique({
      where: { id: device.locationId },
      select: { id: true, code: true, isActive: true },
    }),
  ]);
  if (!location?.isActive) throw new CheckoutFailure("SHIFT_REQUIRED");
  const settings = {
    totalRoundingUnit: settingsRow?.totalRoundingUnit ?? 100n,
    allowNegativeStock: settingsRow?.allowNegativeStock ?? true,
  };
  const rulesParsed = scaleBarcodeRulesSchema.safeParse(settingsRow?.scaleBarcodeRules);
  const rules: readonly ScaleBarcodeRule[] =
    rulesParsed.success && rulesParsed.data.length > 0 ? rulesParsed.data : DEFAULT_SCALE_RULES;

  if (input.customerId) {
    const customer = await tx.customer.findFirst({
      where: { id: input.customerId, isActive: true },
      select: { id: true },
    });
    if (!customer) throw new CheckoutFailure("CUSTOMER_NOT_FOUND");
  }

  // 4. Catalog snapshot for exactly the variants in play.
  const wantedIds = new Set<string>();
  const wantedPlus = new Set<string>();
  for (const line of input.lines) {
    if (line.variantId) wantedIds.add(line.variantId);
    if (line.scaleBarcode) {
      const match = parseScaleBarcode(line.scaleBarcode, rules);
      if (match) wantedPlus.add(match.pluCode);
    }
  }
  const loaded: LoadedVariant[] = await tx.productVariant.findMany({
    where: {
      OR: [
        ...(wantedIds.size > 0 ? [{ id: { in: [...wantedIds] } }] : []),
        ...(wantedPlus.size > 0 ? [{ pluCode: { in: [...wantedPlus] } }] : []),
      ],
    },
    include: { product: { include: { taxClass: true } } },
  });
  const byId = new Map(loaded.map((v) => [v.id, v]));
  const usedVariants = new Set<string>(wantedIds);
  for (const v of loaded) {
    if (v.pluCode && wantedPlus.has(normalizePlu(v.pluCode))) usedVariants.add(v.id);
  }
  for (const id of usedVariants) {
    const v = byId.get(id);
    if (!v) continue; // reported as VARIANT_NOT_FOUND by the cart below
    if (!v.isActive || !v.product.isActive) {
      throw new CheckoutFailure("VARIANT_INACTIVE", { variantId: id });
    }
    if (v.product.type === "GIFT_CARD") {
      // Selling a gift card issues one: Phase 4.
      throw new CheckoutFailure("INVALID_INPUT", { reason: "GIFT_CARD_SALE_UNAVAILABLE" });
    }
  }
  const catalog: CatalogSnapshot = {
    variants: Object.fromEntries(
      loaded.map((v): [string, CatalogVariant] => [
        v.id,
        {
          variantId: v.id,
          productId: v.productId,
          name: variantLabel(v.product.name, v),
          ...(v.sku ? { sku: v.sku } : {}),
          categoryId: v.product.categoryId,
          productType: v.product.type,
          unitCost: v.cost,
          unit: v.product.unit,
          price: v.price,
          pricesIncludeTax: v.product.pricesIncludeTax,
          taxTreatment: v.product.taxClass.treatment,
          vatRateBps: v.product.taxClass.vatRateBps,
          cityTaxRateBps: v.product.taxClass.cityTaxRateBps,
          pluCode: v.pluCode,
        },
      ]),
    ),
  };

  // 5. Recompute everything.
  const built = cartFromCheckoutInput(input, catalog, rules);
  if (!built.ok) throw new CheckoutFailure(built.error.code, built.error.details);
  const cart = built.cart;
  if (cart.lines.length === 0) throw new CheckoutFailure("EMPTY_CART");
  const { totals, lineSteps, cartSteps } = computeTotalsDetailed(cart, catalog, {
    totalRoundingUnit: settings.totalRoundingUnit,
  });
  if (totals.payable !== input.expectedPayable) {
    throw new CheckoutFailure("TOTAL_MISMATCH", {
      expected: input.expectedPayable.toString(),
      actual: totals.payable.toString(),
    });
  }

  // 6. Approvals.
  const approvers = await resolveApprovals(tx, input, cart, catalog, settings, ctx);

  // 7. Tenders.
  const tenders: Tender[] = input.tenders.map((t) => ({
    method: t.method,
    amount: t.amount,
    ...(t.tendered !== undefined ? { tendered: t.tendered } : {}),
    ...(t.reference !== undefined ? { reference: t.reference } : {}),
  }));
  for (const t of input.tenders) {
    if (t.method === "GIFT_CARD" || t.method === "STORE_CREDIT") {
      // TODO(phase 4): row-locked balances, GiftCardEntry / StoreCreditEntry rows.
      throw new CheckoutFailure("TENDER_NOT_AVAILABLE", { method: t.method });
    }
  }
  const seenRefs = new Set<string>();
  for (const t of input.tenders) {
    if (t.reference === undefined) continue;
    const key = `${t.method}:${t.reference}`;
    if (seenRefs.has(key)) {
      throw new CheckoutFailure("DUPLICATE_TENDER_REFERENCE", { reference: t.reference });
    }
    seenRefs.add(key);
  }
  const validated = validateTenders(totals.payable, tenders, {
    cashUnit: cashUnitForRounding(settings.totalRoundingUnit),
  });
  if (!validated.ok) {
    const error = checkoutErrorFromTender(validated.issues);
    throw new CheckoutFailure(error.code, error.details);
  }
  const intentsByTender = await lockQpayIntents(tx, input);

  // 8. Number, sale, lines, discounts, payments.
  const number = `${location.code}-${String(await nextSequenceValue(tx, `sale:${location.code}`)).padStart(6, "0")}`;
  const publicToken = randomToken(32); // 256 bits
  const clientTime = new Date(input.createdAtClient);
  const occurredAt =
    Number.isFinite(clientTime.getTime()) &&
    Math.abs(clientTime.getTime() - now.getTime()) <= MAX_CLOCK_SKEW_MS
      ? clientTime
      : now;

  await tx.sale.create({
    data: {
      id: input.saleId,
      number,
      locationId: device.locationId,
      registerId: device.registerId,
      shiftId: shift.id,
      cashierId: user.id,
      customerId: input.customerId ?? null,
      origin: "ONLINE",
      occurredAt,
      netAmount: totals.netTotal,
      vatAmount: totals.vatTotal,
      cityTaxAmount: totals.cityTotal,
      discountAmount: totals.discountTotal,
      itemsAmount: totals.total,
      roundingAmount: totals.roundingAmount,
      totalAmount: totals.payable,
      buyerTaxId: input.buyerTaxId ?? null,
      note: input.note ?? null,
      publicToken,
      requiresReview: false,
      fingerprint,
    },
  });

  const lineIds = new Map<string, string>();
  const lineRows: Prisma.SaleLineCreateManyInput[] = [];
  const stockLines: { variantId: string; qtyDeltaMilli: number }[] = [];
  cart.lines.forEach((line: CartLine, index) => {
    const lt = totals.lines.find((l) => l.lineId === line.lineId)!;
    const v = byId.get(line.variantId)!;
    if (lt.net + lt.vat + lt.city !== lt.gross) {
      throw new CheckoutFailure("INTERNAL", { reason: "line tax parts do not add up" });
    }
    const id = uuidv7();
    lineIds.set(line.lineId, id);
    const overridden = line.priceOverride !== undefined && line.priceOverride !== v.price;
    lineRows.push({
      id,
      saleId: input.saleId,
      lineNo: index + 1,
      variantId: v.id,
      productId: v.productId,
      categoryId: v.product.categoryId,
      name: variantLabel(v.product.name, v),
      sku: v.sku,
      productType: v.product.type,
      unit: v.product.unit,
      qtyMilli: line.qtyMilli,
      catalogUnitPrice: v.price,
      unitPrice: lt.unitPrice,
      priceOverrideById: overridden
        ? (approvers.get(approvalKeys.linePrice(line.lineId)) ?? user.id)
        : null,
      pricesIncludeTax: v.product.pricesIncludeTax,
      taxTreatment: v.product.taxClass.treatment,
      vatRateBps: v.product.taxClass.vatRateBps,
      cityTaxRateBps: v.product.taxClass.cityTaxRateBps,
      grossAmount: lt.subtotal,
      discountAmount: lt.discount,
      netAmount: lt.net,
      vatAmount: lt.vat,
      cityTaxAmount: lt.city,
      totalAmount: lt.gross,
      unitCost: v.cost,
      note: line.note ?? null,
    });
    if (v.product.trackStock && v.product.type === "STANDARD") {
      stockLines.push({ variantId: v.id, qtyDeltaMilli: -line.qtyMilli });
    }
  });
  await tx.saleLine.createMany({ data: lineRows });

  const discountRows: Prisma.SaleDiscountCreateManyInput[] = [];
  cart.lines.forEach((line) => {
    (lineSteps.get(line.lineId) ?? []).forEach((step, i) => {
      discountRows.push({
        id: uuidv7(),
        saleId: input.saleId,
        saleLineId: lineIds.get(line.lineId)!,
        scope: "LINE",
        source: "MANUAL",
        kind: step.request.kind,
        percentBps: step.request.kind === "PERCENT" ? step.request.percentBps : null,
        fixedAmount: step.request.kind === "FIXED" ? step.request.amount : null,
        amount: step.amount,
        reason: step.request.reason ?? null,
        approvedById: approvers.get(approvalKeys.lineDiscount(line.lineId, i)) ?? null,
      });
    });
  });
  cartSteps.forEach((step, i) => {
    discountRows.push({
      id: uuidv7(),
      saleId: input.saleId,
      saleLineId: null,
      scope: "CART",
      source: "MANUAL",
      kind: step.request.kind,
      percentBps: step.request.kind === "PERCENT" ? step.request.percentBps : null,
      fixedAmount: step.request.kind === "FIXED" ? step.request.amount : null,
      amount: step.amount,
      reason: step.request.reason ?? null,
      approvedById: approvers.get(approvalKeys.cartDiscount(i)) ?? null,
    });
  });
  if (discountRows.length > 0) await tx.saleDiscount.createMany({ data: discountRows });

  const paymentRows: Prisma.SalePaymentCreateManyInput[] = validated.applied.map((applied, i) => {
    const intent = input.tenders[i]!;
    const stored = intentsByTender.get(i);
    return {
      id: uuidv7(),
      saleId: input.saleId,
      method: applied.method,
      amount: applied.amount,
      tendered: applied.tendered,
      change: applied.change,
      reference: stored?.paymentRef ?? applied.reference ?? null,
      cardBrand: intent.cardBrand ?? null,
      cardLast4: intent.cardLast4 ?? null,
      paymentIntentId: stored?.id ?? null,
    };
  });
  if (paymentRows.length > 0) await tx.salePayment.createMany({ data: paymentRows });

  // 9. Stock (the only way stock changes).
  if (stockLines.length > 0) {
    try {
      await postStockMovements(tx, {
        locationId: device.locationId,
        type: "SALE",
        createdById: user.id,
        note: number,
        refs: { saleId: input.saleId },
        forbidNegative: !settings.allowNegativeStock,
        lines: stockLines,
      });
    } catch (error) {
      if (error instanceof ActionError && error.code === "INSUFFICIENT_STOCK") {
        throw new CheckoutFailure("INSUFFICIENT_STOCK", { message: error.message });
      }
      throw error;
    }
  }

  // 10. Audit.
  await audit(tx, {
    actorId: user.id,
    action: "sale.checkout",
    entityType: "Sale",
    entityId: input.saleId,
    locationId: device.locationId,
    registerId: device.registerId,
    after: {
      number,
      payable: totals.payable.toString(),
      total: totals.total.toString(),
      lines: cart.lines.length,
      tenders: validated.applied.map((t) => ({ method: t.method, amount: t.amount.toString() })),
    },
    meta: { deviceId: device.deviceId, shiftId: shift.id },
    ...ctx.meta,
  });
  for (const [key, approverId] of approvers) {
    if (approverId === user.id) continue;
    await audit(tx, {
      actorId: approverId,
      action: "sale.approval_used",
      entityType: "Sale",
      entityId: input.saleId,
      locationId: device.locationId,
      registerId: device.registerId,
      meta: { key, requestedById: user.id, deviceId: device.deviceId },
      ...ctx.meta,
    });
  }

  const fresh = await tx.sale.findUniqueOrThrow({
    where: { id: input.saleId },
    ...storedSaleArgs,
  });
  return toResult(fresh, false);
}

// ---------------------------------------------------------------------------

/**
 * For every approval the cart needs: the cashier's own permission, or a valid
 * token from a manager who still holds the permission at this location.
 * Returns requirement key → approving user id.
 */
async function resolveApprovals(
  tx: Tx,
  input: CheckoutInput,
  cart: Parameters<typeof requiredApprovals>[0],
  catalog: CatalogSnapshot,
  settings: { totalRoundingUnit: bigint },
  ctx: CheckoutContext,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const requirements = requiredApprovals(cart, catalog, DEFAULT_APPROVAL_POLICY, {
    totalRoundingUnit: settings.totalRoundingUnit,
  });
  for (const req of requirements) {
    if (can(ctx.user, req.permission, ctx.device.locationId)) {
      out.set(req.key, ctx.user.id);
      continue;
    }
    const token = input.approvals[req.key];
    if (!token) throw new CheckoutFailure("APPROVAL_REQUIRED", { key: req.key });
    const claims = verifyApprovalToken(token, req.permission, input.saleId, req.key, ctx);
    if (!claims) throw new CheckoutFailure("APPROVAL_INVALID", { key: req.key });
    const approver = await tx.user.findUnique({
      where: { id: claims.approverId },
      include: { locations: { select: { locationId: true } } },
    });
    const subject = approver && {
      role: approver.role,
      locationIds:
        approver.role === "OWNER" ? ("ALL" as const) : approver.locations.map((l) => l.locationId),
    };
    if (
      !approver ||
      !approver.isActive ||
      !subject ||
      !hasPermission(approver.role, req.permission) ||
      !canAccessLocation(subject, ctx.device.locationId)
    ) {
      throw new CheckoutFailure("APPROVAL_INVALID", { key: req.key });
    }
    out.set(req.key, approver.id);
  }
  return out;
}

function verifyApprovalToken(
  token: string,
  permission: ApprovablePermission,
  saleId: string,
  key: string,
  ctx: CheckoutContext,
) {
  const base = { permission, deviceId: ctx.device.deviceId };
  return (
    verifyApproval(token, { ...base, scope: saleId }, ctx.now) ??
    verifyApproval(token, { ...base, scope: `${saleId}:${key}` }, ctx.now)
  );
}

/**
 * Lock and check the PaymentIntent behind every QPAY tender: it must exist,
 * be PAID (the provider already confirmed it), belong to this sale, match the
 * tender amount and not be consumed by another payment. Returns tender index
 * → intent (id, provider payment reference).
 */
async function lockQpayIntents(
  tx: Tx,
  input: CheckoutInput,
): Promise<Map<number, { id: string; paymentRef: string | null }>> {
  const out = new Map<number, { id: string; paymentRef: string | null }>();
  const ids = [
    ...new Set(
      input.tenders
        .filter((t) => t.method === "QPAY" && t.paymentIntentId)
        .map((t) => t.paymentIntentId!),
    ),
  ].sort();
  if (ids.length === 0) return out;
  await tx.$queryRaw`SELECT "id" FROM "PaymentIntent" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR UPDATE`;
  const intents = await tx.paymentIntent.findMany({
    where: { id: { in: ids } },
    include: { salePayment: { select: { id: true } } },
  });
  const byId = new Map(intents.map((i) => [i.id, i]));
  input.tenders.forEach((tender, index) => {
    if (tender.method !== "QPAY") return;
    const intent = byId.get(tender.paymentIntentId!);
    if (
      !intent ||
      intent.status !== "PAID" ||
      intent.saleId !== input.saleId ||
      intent.amount !== tender.amount ||
      intent.salePayment
    ) {
      throw new CheckoutFailure("PAYMENT_NOT_CONFIRMED", {
        paymentIntentId: tender.paymentIntentId,
      });
    }
    const raw = intent.raw as { paymentRef?: unknown } | null;
    out.set(index, {
      id: intent.id,
      // The provider's payment id when it gave one, else its invoice id.
      paymentRef: typeof raw?.paymentRef === "string" ? raw.paymentRef : intent.providerRef,
    });
  });
  return out;
}
