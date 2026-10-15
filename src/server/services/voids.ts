import "server-only";
import { can } from "@/domain/access";
import { failureFields, VOID_FAILURE_FIELD } from "@/domain/refund-failure";
import {
  isSameVoid,
  voidApprovalKey,
  voidApprovalScope,
  voidError,
  voidErrorFromIssues,
  voidFingerprint,
  type VoidError,
  type VoidErrorCode,
  type VoidInput,
  type VoidResult,
} from "@/domain/void-contract";
import { planVoid, type VoidPlan } from "@/domain/void";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { audit } from "../audit";
import { getPaymentProvider } from "../adapters/payments";
import { db, type Tx } from "../db";
import { ActionError, type ActionErrorCode } from "../errors";
import { checkApprovalToken } from "./approval-check";
import type { CheckoutContext } from "./checkout";
import { postStockMovements } from "./stock";

/**
 * Voiding a sale (docs/shifts-refunds-domain.md).
 *
 * A void is an append-only SaleVoid row, nothing else is mutated except the
 * PaymentIntent of a refunded QPay payment (a mutable provider state machine).
 * "Voided" therefore means "a SaleVoid row exists" everywhere (receipts,
 * reports, refunds).
 *
 * Concurrency. The sale row is locked FOR UPDATE first (the same lock a refund
 * of this sale takes, so a void and a refund can never both succeed), then the
 * register's OPEN shift FOR SHARE (a closing shift takes it FOR UPDATE and so
 * waits for us, or we see it CLOSED). The void is keyed by the sale id, so
 * duplicates serialise on the sale lock and the loser replays the stored void.
 *
 * Provider calls (QPay refund) happen last inside the transaction: a refusal
 * rolls everything back (nothing half-voided). The provider call carries an
 * idempotency key so a retry after a rollback cannot refund twice.
 */

export class VoidFailure extends ActionError {
  constructor(
    readonly failure: VoidErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    const fields = failureFields(VOID_FAILURE_FIELD);
    super(genericCode(failure), failure, {
      [fields.code]: [failure],
      ...(details ? { [fields.details]: [JSON.stringify(details)] } : {}),
    });
    this.name = "VoidFailure";
  }
  static from(error: VoidError): VoidFailure {
    return new VoidFailure(error.code, error.details);
  }
}

function genericCode(code: VoidErrorCode): ActionErrorCode {
  switch (code) {
    case "PERMISSION_DENIED":
      return "FORBIDDEN";
    case "SALE_NOT_FOUND":
      return "NOT_FOUND";
    case "IDEMPOTENCY_CONFLICT":
      return "CONFLICT";
    case "SHIFT_NOT_OPEN":
    case "VOID_NOT_ALLOWED":
    case "ALREADY_VOIDED":
    case "ALREADY_REFUNDED":
    case "SALE_IN_OTHER_SHIFT":
      return "INVALID_STATE";
    case "INTERNAL":
      return "INTERNAL";
    default:
      return "VALIDATION";
  }
}

export interface VoidOutcome {
  result: VoidResult;
  /** True when this call wrote the void (the caller schedules the fiscal return). */
  created: boolean;
}

const saleArgs = {
  include: {
    lines: { orderBy: { lineNo: "asc" as const } },
    payments: { orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }] },
    void: true,
    fiscalReceipt: { select: { status: true } },
    _count: { select: { refunds: true } },
  },
} satisfies Prisma.SaleDefaultArgs;
type LoadedSale = Prisma.SaleGetPayload<typeof saleArgs>;

export async function voidSale(
  input: VoidInput,
  ctx: CheckoutContext,
  client: PrismaClient = db,
): Promise<VoidOutcome> {
  if (!can(ctx.user, "pos.sell", ctx.device.locationId)) {
    throw new VoidFailure("PERMISSION_DENIED");
  }
  const fingerprint = voidFingerprint(input);
  try {
    return await client.$transaction((tx) => runVoid(tx, input, fingerprint, ctx), {
      maxWait: 15_000,
      timeout: 30_000,
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // Someone committed the void of this sale between our lock and insert.
      const winner = await client.sale.findUnique({ where: { id: input.saleId }, ...saleArgs });
      if (winner?.void) return { result: toResult(winner, true), created: false };
      throw new VoidFailure("INTERNAL");
    }
    throw error;
  }
}

function toResult(sale: LoadedSale, replayed: boolean): VoidResult {
  return {
    saleId: sale.id,
    receiptNumber: sale.number,
    totalAmount: sale.totalAmount,
    cashReturned: sale.payments
      .filter((p) => p.method === "CASH")
      .reduce((acc, p) => acc + p.amount, 0n),
    replayed,
  };
}

async function runVoid(
  tx: Tx,
  input: VoidInput,
  fingerprint: string,
  ctx: CheckoutContext,
): Promise<VoidOutcome> {
  const { user, device } = ctx;

  // 1. Lock the sale (also the lock refunds take), then read it.
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "Sale" WHERE "id" = ${input.saleId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new VoidFailure("SALE_NOT_FOUND");
  const sale = await tx.sale.findUniqueOrThrow({ where: { id: input.saleId }, ...saleArgs });
  if (sale.locationId !== device.locationId) throw new VoidFailure("SALE_NOT_FOUND");

  // 2. Replay.
  if (sale.void) {
    if (sale.void.fingerprint !== null && !isSameVoid(sale.void.fingerprint, input)) {
      throw new VoidFailure("IDEMPOTENCY_CONFLICT");
    }
    return { result: toResult(sale, true), created: false };
  }

  // 3. The register's open shift (shared lock: a closing shift waits for us).
  const shifts = await tx.$queryRaw<{ id: string; locationId: string }[]>`
    SELECT "id", "locationId" FROM "Shift"
    WHERE "registerId" = ${device.registerId}::uuid AND "status" = 'OPEN'::"ShiftStatus"
    FOR SHARE`;
  const shift = shifts[0];
  // No open shift here: planVoid reports SHIFT_NOT_OPEN (status CLOSED).
  const planShift = shift
    ? { id: shift.id, status: "OPEN" as const }
    : { id: sale.shiftId, status: "CLOSED" as const };

  // 4. Permission, or an approval bound to this sale and amount.
  const ownGrant = can(user, "pos.void", device.locationId);
  let approverId: string | null = null;
  let tokenInvalid = false;
  if (!ownGrant) {
    const token = input.approvals[voidApprovalKey];
    if (token) {
      const checked = await checkApprovalToken(
        tx,
        token,
        {
          permission: "pos.void",
          scope: voidApprovalScope(sale.id, sale.totalAmount),
          deviceId: device.deviceId,
          locationId: device.locationId,
        },
        ctx.now,
      );
      if (checked.ok) approverId = checked.approverId;
      else tokenInvalid = true;
    }
  }

  // 5. Stock lines that really moved stock when the sale was rung up.
  const moved = new Set(
    (
      await tx.stockMovement.findMany({
        where: { saleId: sale.id, type: "SALE" },
        select: { variantId: true },
      })
    ).map((m) => m.variantId),
  );
  const tracked = new Map(
    (
      await tx.productVariant.findMany({
        where: { id: { in: sale.lines.map((l) => l.variantId) } },
        select: { id: true, product: { select: { trackStock: true, type: true } } },
      })
    ).map((v) => [v.id, v.product.trackStock && v.product.type === "STANDARD"]),
  );

  const planned = planVoid(
    {
      id: sale.id,
      status: "COMPLETED",
      shiftId: sale.shiftId,
      totalAmount: sale.totalAmount,
      lines: sale.lines.map((l) => ({
        id: l.id,
        variantId: l.variantId,
        qtyMilli: l.qtyMilli,
        unitCost: l.unitCost,
        tracksStock: moved.has(l.variantId) && tracked.get(l.variantId) === true,
        isGiftCard: l.productType === "GIFT_CARD",
      })),
      payments: sale.payments.map((p) => ({ id: p.id, method: p.method, amount: p.amount })),
      refundCount: sale._count.refunds,
      fiscalIssued: sale.fiscalReceipt?.status === "ISSUED",
    },
    {
      shift: planShift,
      reason: input.reason,
      note: input.note,
      grants: { void: ownGrant || approverId !== null },
    },
  );
  if (!planned.ok) {
    if (tokenInvalid && planned.issues.every((i) => i.code === "APPROVAL_REQUIRED")) {
      throw new VoidFailure("APPROVAL_INVALID", { key: voidApprovalKey });
    }
    const error = voidErrorFromIssues(planned.issues);
    throw VoidFailure.from(
      error.code === "APPROVAL_REQUIRED"
        ? voidError("APPROVAL_REQUIRED", { ...error.details, key: voidApprovalKey })
        : error,
    );
  }
  const plan = planned.plan;

  // 6. Stock back at the ORIGINAL cost snapshot.
  if (plan.stockRestores.length > 0) {
    await postStockMovements(tx, {
      locationId: sale.locationId,
      type: "SALE_VOID",
      createdById: user.id,
      note: sale.number,
      refs: { saleId: sale.id },
      lines: plan.stockRestores.map((s) => ({
        variantId: s.variantId,
        qtyDeltaMilli: s.qtyMilli,
        unitCost: s.unitCost,
      })),
    });
  }

  // 7. The void row, then the money (provider last: a refusal rolls it all back).
  const reversals = await reversePayments(tx, sale, plan);
  await tx.saleVoid.create({
    data: {
      saleId: sale.id,
      shiftId: planShift.id,
      reason: plan.reason,
      note: plan.note ?? null,
      voidedById: user.id,
      approvedById: approverId,
      fingerprint,
      reversals: reversals as unknown as Prisma.InputJsonValue,
    },
  });

  // 8. Audit.
  await audit(tx, {
    actorId: user.id,
    action: "sale.void",
    entityType: "Sale",
    entityId: sale.id,
    locationId: sale.locationId,
    registerId: device.registerId,
    after: {
      number: sale.number,
      total: sale.totalAmount.toString(),
      reason: plan.reason,
      cashReturned: plan.cashReturned.toString(),
      reversals: reversals.map((r) => ({ method: r.method, amount: r.amount })),
    },
    meta: { deviceId: device.deviceId, shiftId: planShift.id, approvedById: approverId },
    ...ctx.meta,
  });
  if (approverId) {
    await audit(tx, {
      actorId: approverId,
      action: "sale.void_approved",
      entityType: "Sale",
      entityId: sale.id,
      locationId: sale.locationId,
      registerId: device.registerId,
      meta: { requestedById: user.id, deviceId: device.deviceId },
      ...ctx.meta,
    });
  }

  return {
    result: {
      saleId: sale.id,
      receiptNumber: sale.number,
      totalAmount: sale.totalAmount,
      cashReturned: plan.cashReturned,
      replayed: false,
    },
    created: true,
  };
}

interface ReversalRecord {
  paymentId: string;
  method: string;
  kind: string;
  amount: string;
  reference: string | null;
}

async function reversePayments(
  tx: Tx,
  sale: LoadedSale,
  plan: VoidPlan,
): Promise<ReversalRecord[]> {
  const out: ReversalRecord[] = [];
  const byId = new Map(sale.payments.map((p) => [p.id, p]));
  for (const reversal of plan.paymentReversals) {
    const original = byId.get(reversal.paymentId)!;
    let reference = original.reference;
    if (reversal.kind === "QPAY_REFUND") {
      const intent = original.paymentIntentId
        ? await tx.paymentIntent.findUnique({ where: { id: original.paymentIntentId } })
        : null;
      if (!intent?.providerRef) {
        throw new VoidFailure("VOID_NOT_ALLOWED", { reason: "PAYMENT_PROVIDER_FAILED" });
      }
      let refund;
      try {
        refund = await getPaymentProvider().refund({
          providerRef: intent.providerRef,
          amount: reversal.amount,
          reason: "void",
          idempotencyKey: `void:${sale.id}:${original.id}`,
        });
      } catch {
        throw new VoidFailure("VOID_NOT_ALLOWED", { reason: "PAYMENT_PROVIDER_FAILED" });
      }
      if (refund.status !== "REFUNDED") {
        throw new VoidFailure("VOID_NOT_ALLOWED", { reason: "PAYMENT_PROVIDER_FAILED" });
      }
      reference = refund.refundRef ?? reference;
      await tx.paymentIntent.update({
        where: { id: intent.id },
        data: { status: "REFUNDED" },
      });
    }
    out.push({
      paymentId: reversal.paymentId,
      method: reversal.method,
      kind: reversal.kind,
      amount: reversal.amount.toString(),
      reference,
    });
  }
  return out;
}
