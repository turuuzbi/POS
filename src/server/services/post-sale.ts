import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "../audit";
import { getFiscalProvider } from "../adapters/fiscal";
import type { FiscalSaleRequest } from "../adapters/fiscal/types";
import { getMessagingProvider } from "../adapters/messaging";
import type { MessageChannel } from "../adapters/messaging";
import { db } from "../db";
import { ActionError } from "../errors";

/**
 * Work that happens AFTER a sale committed, as retryable records so a slow or
 * failing provider never blocks or undoes a sale:
 *   - FiscalReceipt (eBarimt adapter): PENDING -> ISSUED, or FAILED with the
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

/** One attempt at issuing a PENDING / FAILED fiscal receipt. Returns the resulting status. */
export async function retryFiscalReceipt(fiscalReceiptId: string): Promise<string> {
  const receipt = await db.fiscalReceipt.findUnique({
    where: { id: fiscalReceiptId },
    include: { sale: { include: { lines: { orderBy: { lineNo: "asc" } }, payments: true } } },
  });
  if (!receipt || !receipt.sale) throw new ActionError("NOT_FOUND");
  if (receipt.status === "ISSUED" || receipt.status === "CANCELLED") return receipt.status;
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
    await db.fiscalReceipt.update({
      where: { id: receipt.id },
      data: {
        status: "ISSUED",
        externalId: issued.externalId,
        lotteryCode: issued.lotteryCode ?? null,
        qrData: issued.qrData ?? null,
        request: requestJson,
        response: issued.raw as Prisma.InputJsonValue,
        error: null,
        attempts: { increment: 1 },
        issuedAt: new Date(),
      },
    });
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
    await db.fiscalReceipt.update({
      where: { id: receipt.id },
      data: {
        status: "FAILED",
        request: requestJson,
        error: (error instanceof Error ? error.message : "unknown error").slice(0, 500),
        attempts: { increment: 1 },
      },
    });
    return "FAILED";
  }
}

/**
 * Retry queue sweep: create missing fiscal receipts for committed sales (a
 * crash between commit and `after()`), then retry PENDING / FAILED ones.
 * Meant for a cron / admin button. Returns how many were attempted.
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
    where: { status: { in: ["PENDING", "FAILED"] } },
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
