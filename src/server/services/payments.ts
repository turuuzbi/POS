import "server-only";
import { v7 as uuidv7 } from "uuid";
import { can } from "@/domain/access";
import type { QpayInvoice, QpayStatus } from "@/domain/qpay";
import type { Prisma } from "@/generated/prisma/client";
import { audit } from "../audit";
import { getPaymentProvider } from "../adapters/payments";
import type { CurrentUser } from "../auth/session";
import { db } from "../db";
import { ActionError } from "../errors";
import type { RequestMeta } from "../request";
import type { RegisterContext } from "./register-context";

/** How long a QPay invoice stays payable. */
export const QPAY_INVOICE_TTL_SECONDS = 10 * 60;
/** Pending invoices one sale may accumulate (the cashier re-generating a QR). */
const MAX_INTENTS_PER_SALE = 10;

type Actor = Pick<CurrentUser, "id" | "role" | "locationIds">;

/**
 * Start a QPay invoice for (part of) a sale that has not been committed yet.
 * The PaymentIntent row is created first, then the provider is called; if the
 * provider fails the intent is marked FAILED so nothing is left half-open.
 */
export async function createQpayInvoice(
  input: { saleId: string; amount: bigint },
  user: Actor,
  register: RegisterContext,
  meta: RequestMeta,
): Promise<QpayInvoice> {
  if (!can(user, "pos.sell", register.locationId)) throw new ActionError("FORBIDDEN");
  if (input.amount <= 0n) throw new ActionError("VALIDATION");
  const provider = getPaymentProvider();

  const intentId = uuidv7();
  await db.$transaction(async (tx) => {
    // The sale id is the idempotency key: an invoice for an already committed sale is pointless.
    if (await tx.sale.findUnique({ where: { id: input.saleId }, select: { id: true } })) {
      throw new ActionError("CONFLICT");
    }
    const count = await tx.paymentIntent.count({ where: { saleId: input.saleId } });
    if (count >= MAX_INTENTS_PER_SALE) throw new ActionError("RATE_LIMITED");
    await tx.paymentIntent.create({
      data: {
        id: intentId,
        provider: provider.name,
        saleId: input.saleId,
        amount: input.amount,
        createdById: user.id,
      },
    });
  });

  try {
    const invoice = await provider.createInvoice({
      intentId,
      saleId: input.saleId,
      amount: input.amount,
      description: `POS ${input.saleId.slice(-12)}`,
      expiresInSeconds: QPAY_INVOICE_TTL_SECONDS,
    });
    await db.$transaction(async (tx) => {
      await tx.paymentIntent.update({
        where: { id: intentId },
        data: {
          providerRef: invoice.providerRef,
          qrText: invoice.qrText,
          deeplinks: invoice.deeplinks,
          expiresAt: invoice.expiresAt,
          raw: invoice.raw as Prisma.InputJsonValue,
        },
      });
      await audit(tx, {
        actorId: user.id,
        action: "payment.invoice_created",
        entityType: "PaymentIntent",
        entityId: intentId,
        locationId: register.locationId,
        registerId: register.registerId,
        after: { saleId: input.saleId, amount: input.amount.toString(), provider: provider.name },
        ...meta,
      });
    });
    return {
      intentId,
      qrText: invoice.qrText,
      deeplinks: invoice.deeplinks,
      expiresAt: invoice.expiresAt ? invoice.expiresAt.toISOString() : null,
    };
  } catch (error) {
    await db.paymentIntent
      .updateMany({ where: { id: intentId, status: "PENDING" }, data: { status: "FAILED" } })
      .catch(() => undefined);
    console.error("[payments] createInvoice failed", error);
    throw new ActionError("INTERNAL");
  }
}

/**
 * Ask the provider about an intent and persist the verdict. This is the ONLY
 * place an intent becomes PAID, and the webhook, the cashier's "check" button
 * and checkout all go through it. PENDING and EXPIRED intents are re-checked
 * (money can arrive after our local expiry); a PAID answer must carry exactly
 * the intent's amount, otherwise the intent is FAILED and stays unusable.
 */
export async function syncPaymentIntent(
  intentId: string,
  now: Date = new Date(),
): Promise<{ status: QpayStatus } | null> {
  const intent = await db.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) return null;
  if (!intent.providerRef || (intent.status !== "PENDING" && intent.status !== "EXPIRED")) {
    return { status: toQpayStatus(intent.status) };
  }
  const check = await getPaymentProvider().checkPayment(intent.providerRef);

  let next: QpayStatus = check.status;
  if (check.status === "PAID" && check.paidAmount !== intent.amount) next = "FAILED";
  if (next === "PENDING" && intent.expiresAt && intent.expiresAt <= now) next = "EXPIRED";
  if (next === intent.status) return { status: next };

  const updated = await db.paymentIntent.updateMany({
    // Compare-and-set: a concurrent sync that already moved it wins.
    where: { id: intent.id, status: intent.status },
    data: {
      status: next,
      raw: {
        ...check.raw,
        ...(check.paymentRef ? { paymentRef: check.paymentRef } : {}),
      } as Prisma.InputJsonValue,
      ...(next === "PAID" ? { paidAt: check.paidAt ?? now } : {}),
    },
  });
  if (updated.count === 1) {
    await audit(db, {
      actorId: null,
      action: `payment.${next.toLowerCase()}`,
      entityType: "PaymentIntent",
      entityId: intent.id,
      after: { saleId: intent.saleId, amount: intent.amount.toString(), status: next },
    });
  }
  const fresh = await db.paymentIntent.findUnique({
    where: { id: intent.id },
    select: { status: true },
  });
  return { status: toQpayStatus(fresh?.status ?? next) };
}

/**
 * Checkout's re-verification: bring the intent up to date, then ask the
 * provider once more and require PAID for exactly the intent's amount. The
 * stored status alone is never enough.
 */
export async function confirmIntentPaid(intentId: string): Promise<boolean> {
  const synced = await syncPaymentIntent(intentId);
  if (synced?.status !== "PAID") return false;
  const intent = await db.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent?.providerRef) return false;
  const check = await getPaymentProvider().checkPayment(intent.providerRef);
  return check.status === "PAID" && check.paidAmount === intent.amount;
}

/** Cashier asks for a status check. Only the intent's creator or a reporting-level user may. */
export async function checkQpay(intentId: string, user: Actor): Promise<{ status: QpayStatus }> {
  const intent = await db.paymentIntent.findUnique({
    where: { id: intentId },
    select: { createdById: true },
  });
  if (!intent || (intent.createdById !== user.id && !can(user, "reports.view"))) {
    throw new ActionError("NOT_FOUND");
  }
  const result = await syncPaymentIntent(intentId);
  if (!result) throw new ActionError("NOT_FOUND");
  return result;
}

/**
 * Webhook entry: find the PENDING intent for the provider's invoice id and
 * trigger a status check. Unknown refs and settled intents never reach the
 * provider (the cashier's own check still re-verifies EXPIRED ones).
 */
export async function handleQpayWebhook(providerRef: string): Promise<void> {
  const intent = await db.paymentIntent.findFirst({
    where: { provider: getPaymentProvider().name, providerRef, status: "PENDING" },
    select: { id: true },
  });
  if (intent) await syncPaymentIntent(intent.id);
}

function toQpayStatus(status: string): QpayStatus {
  // REFUNDED intents were paid; to the cashier they are no longer usable.
  return status === "REFUNDED" ? "CANCELLED" : (status as QpayStatus);
}
