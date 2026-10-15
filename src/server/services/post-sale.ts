import "server-only";
import { canAccessLocation } from "@/domain/access";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "../audit";
import type { CurrentUser } from "../auth/session";
import { getFiscalProvider } from "../adapters/fiscal";
import type { FiscalSaleRequest } from "../adapters/fiscal/types";
import { getMessagingProvider } from "../adapters/messaging";
import type { MessageChannel } from "../adapters/messaging";
import { db } from "../db";
import { ActionError } from "../errors";

/**
 * Work that happens AFTER a sale committed, as retryable records so a slow or
 * failing provider never blocks or undoes a sale:
 *   - FiscalReceipt (eBarimt adapter): PENDING -> ISSUING (claimed) -> ISSUED, or FAILED with the
 *     error and an attempt count; `retryFiscalReceipt` /
 *     `reconcileFiscalReceipts` pick up PENDING and FAILED rows.
 *   - ReceiptDelivery (SMS / e-mail): QUEUED -> SENT | FAILED.
 * Everything here is idempotent per sale.
 */

/** Create (if needed) and attempt the fiscal receipt for a sale. Never throws. */
export async function runPostSale(saleId: string): Promise<void> {
  try {
    const provider = getFiscalProvider();
    let receipt = await db.fiscalReceipt.findUnique({ where: { saleId } });
    if (!receipt) {
      try {
        receipt = await db.fiscalReceipt.create({
          data: { provider: provider.name, saleId, status: "PENDING" },
        });
      } catch (error) {
        // A concurrent runner (replay, reconcile) created it first.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
          throw error;
        }
        receipt = await db.fiscalReceipt.findUnique({ where: { saleId } });
      }
    }
    if (receipt && receipt.status !== "ISSUED" && receipt.status !== "CANCELLED") {
      await retryFiscalReceipt(receipt.id);
    }
  } catch (error) {
    console.error("[post-sale] fiscal receipt failed", saleId, error);
  }
}

/** An ISSUING claim older than this is a crashed / hung runner and may be taken over. */
export const FISCAL_CLAIM_TIMEOUT_MS = 5 * 60_000;

function staleClaim(now: Date) {
  return {
    status: "ISSUING" as const,
    OR: [
      { claimedAt: null },
      { claimedAt: { lt: new Date(now.getTime() - FISCAL_CLAIM_TIMEOUT_MS) } },
    ],
  };
}

/**
 * One attempt at issuing a PENDING / FAILED (or stale ISSUING) fiscal receipt.
 * The row is claimed first with an atomic compare-and-set to ISSUING, so
 * concurrent runners (replayed checkout, reconcile sweep) call the provider
 * at most once; a runner that loses the claim returns the current status
 * without touching the provider. The sale id is the provider's idempotency
 * key (FiscalSaleRequest.saleId), so a takeover after a crash between
 * `issue()` and the final update cannot create a second fiscal document.
 * Returns the resulting status.
 */
export async function retryFiscalReceipt(
  fiscalReceiptId: string,
  now: Date = new Date(),
): Promise<string> {
  const receipt = await db.fiscalReceipt.findUnique({
    where: { id: fiscalReceiptId },
    include: {
      sale: {
        include: {
          lines: { orderBy: { lineNo: "asc" } },
          payments: true,
          void: { select: { id: true } },
        },
      },
    },
  });
  if (!receipt || !receipt.sale) throw new ActionError("NOT_FOUND");
  if (receipt.status === "ISSUED" || receipt.status === "CANCELLED") return receipt.status;
  if (receipt.sale.void) {
    // A voided sale is never reported. An already issued document is reversed by
    // runVoidFiscal (post-refund.ts); one that never went out is simply cancelled.
    const done = await db.fiscalReceipt.updateMany({
      where: {
        id: receipt.id,
        externalId: null,
        OR: [{ status: { in: ["PENDING", "FAILED"] } }, staleClaim(new Date())],
      },
      data: { status: "CANCELLED", claimedAt: null },
    });
    return done.count === 1 ? "CANCELLED" : receipt.status;
  }

  const claimedAt = now;
  const claim = await db.fiscalReceipt.updateMany({
    where: {
      id: receipt.id,
      OR: [{ status: { in: ["PENDING", "FAILED"] } }, staleClaim(now)],
    },
    data: { status: "ISSUING", claimedAt, attempts: { increment: 1 } },
  });
  if (claim.count !== 1) {
    const current = await db.fiscalReceipt.findUnique({
      where: { id: receipt.id },
      select: { status: true },
    });
    return current?.status ?? "ISSUING";
  }
  // Only the runner that still holds THIS claim may record the outcome.
  const mine = { id: receipt.id, status: "ISSUING" as const, claimedAt };

  const sale = receipt.sale;
  const request: FiscalSaleRequest = {
    saleId: sale.id,
    receiptNumber: sale.number,
    issuedAt: sale.occurredAt,
    buyerTaxId: sale.buyerTaxId,
    lines: sale.lines.map((l) => ({
      name: l.name,
      sku: l.sku,
      qtyMilli: l.qtyMilli,
      unitPrice: l.unitPrice,
      net: l.netAmount,
      vat: l.vatAmount,
      cityTax: l.cityTaxAmount,
      total: l.totalAmount,
    })),
    net: sale.netAmount,
    vat: sale.vatAmount,
    cityTax: sale.cityTaxAmount,
    total: sale.totalAmount,
    payments: sale.payments.map((p) => ({ method: p.method, amount: p.amount })),
  };
  const requestJson = JSON.parse(
    JSON.stringify(request, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;
  try {
    const issued = await getFiscalProvider().issue(request);
    const done = await db.fiscalReceipt.updateMany({
      where: mine,
      data: {
        status: "ISSUED",
        externalId: issued.externalId,
        lotteryCode: issued.lotteryCode ?? null,
        qrData: issued.qrData ?? null,
        request: requestJson,
        response: issued.raw as Prisma.InputJsonValue,
        error: null,
        claimedAt: null,
        issuedAt: new Date(),
      },
    });
    if (done.count !== 1) return "ISSUING"; // claim was taken over; the new owner records it
    await audit(db, {
      actorId: null,
      action: "fiscal.issued",
      entityType: "Sale",
      entityId: sale.id,
      locationId: sale.locationId,
      after: { externalId: issued.externalId },
    });
    return "ISSUED";
  } catch (error) {
    await db.fiscalReceipt.updateMany({
      where: mine,
      data: {
        status: "FAILED",
        request: requestJson,
        error: (error instanceof Error ? error.message : "unknown error").slice(0, 500),
        claimedAt: null,
      },
    });
    return "FAILED";
  }
}

/**
 * Retry queue sweep: create missing fiscal receipts for committed sales (a
 * crash between commit and `after()`), then retry PENDING / FAILED ones and
 * ISSUING ones whose claim went stale. Safe to run concurrently with itself
 * and with checkout's post-commit step: every attempt goes through the claim
 * in `retryFiscalReceipt`. Meant for a cron / admin button. Returns how many
 * were attempted.
 */
export async function reconcileFiscalReceipts(limit = 50): Promise<number> {
  const missing = await db.sale.findMany({
    where: { fiscalReceipt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const sale of missing) await runPostSale(sale.id);
  const open = await db.fiscalReceipt.findMany({
    where: { OR: [{ status: { in: ["PENDING", "FAILED"] } }, staleClaim(new Date())] },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const receipt of open) await retryFiscalReceipt(receipt.id).catch(() => undefined);
  return missing.length + open.length;
}

const PHONE = /^[0-9+][0-9 ()-]{5,18}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;

/**
 * Queue a receipt message (SMS / e-mail) and send it through the messaging
 * adapter. `shareUrl` is the public receipt link (built by the caller from
 * Sale.publicToken). A failed send leaves a FAILED row, never an exception.
 */
export async function deliverReceipt(input: {
  saleId: string;
  channel: MessageChannel;
  destination: string;
  shareUrl: string;
}): Promise<{ id: string; status: "SENT" | "FAILED" }> {
  const destination = input.destination.trim();
  if (!(input.channel === "SMS" ? PHONE : EMAIL).test(destination)) {
    throw new ActionError("VALIDATION");
  }
  const sale = await db.sale.findUnique({
    where: { id: input.saleId },
    select: { number: true, totalAmount: true },
  });
  if (!sale) throw new ActionError("NOT_FOUND");
  const delivery = await db.receiptDelivery.create({
    data: { saleId: input.saleId, channel: input.channel, destination, status: "QUEUED" },
  });
  try {
    const sent = await getMessagingProvider().send({
      channel: input.channel,
      destination,
      subject: `Баримт ${sale.number}`,
      body: `Баримт ${sale.number}: ${input.shareUrl}`,
    });
    await db.receiptDelivery.update({
      where: { id: delivery.id },
      data: { status: "SENT", providerRef: sent.providerRef },
    });
    return { id: delivery.id, status: "SENT" };
  } catch (error) {
    await db.receiptDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "FAILED",
        error: (error instanceof Error ? error.message : "unknown error").slice(0, 500),
      },
    });
    return { id: delivery.id, status: "FAILED" };
  }
}

/** A receipt may be re-sent a few times (typo in the number), not used to spam a destination. */
const MAX_DELIVERIES_PER_SALE = 5;

/**
 * Send the receipt link of a committed sale to a customer. The sale must be
 * at a location the user may act in (anything else looks like a missing
 * sale). `baseUrl` is the app's public origin; the link is built here from
 * Sale.publicToken, never taken from the client.
 */
export async function sendSaleReceipt(
  input: { saleId: string; channel: MessageChannel; destination: string },
  user: Pick<CurrentUser, "role" | "locationIds">,
  baseUrl: string,
): Promise<{ id: string; status: "SENT" | "FAILED" }> {
  const sale = await db.sale.findUnique({
    where: { id: input.saleId },
    select: { locationId: true, publicToken: true },
  });
  if (!sale || !canAccessLocation(user, sale.locationId)) throw new ActionError("NOT_FOUND");
  const sent = await db.receiptDelivery.count({ where: { saleId: input.saleId } });
  if (sent >= MAX_DELIVERIES_PER_SALE) throw new ActionError("RATE_LIMITED");
  const origin = baseUrl.replace(/\/+$/, "");
  return deliverReceipt({
    saleId: input.saleId,
    channel: input.channel,
    destination: input.destination,
    shareUrl: `${origin}/r/${encodeURIComponent(sale.publicToken)}`,
  });
}
