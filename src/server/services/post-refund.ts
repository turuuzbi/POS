import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { audit } from "../audit";
import { getFiscalProvider } from "../adapters/fiscal";
import { db } from "../db";
import { FISCAL_CLAIM_TIMEOUT_MS } from "./post-sale";

/**
 * Fiscal returns, AFTER the refund / void committed (the action schedules them
 * with `after()`), so a slow or failing eBarimt can neither delay nor undo a
 * refund. Same shape as post-sale.ts: a FiscalReceipt row claimed with an
 * atomic compare-and-set, FAILED rows retried by `reconcileFiscalReturns`.
 *
 *   - Refund: FiscalReceipt(refundId) PENDING|FAILED -> ISSUING -> ISSUED, calling
 *     `issueReturn` against the original sale's fiscal document. If the original
 *     was never issued the attempt FAILS (retried later, after the sale's
 *     own receipt went through).
 *   - Void: the sale's own FiscalReceipt. Never issued -> CANCELLED (nothing
 *     was reported); ISSUED -> `issueReturn` (idempotency key = sale id) and
 *     then CANCELLED, with the return kept in `response.return`.
 */

function staleBefore(now: Date): Date {
  return new Date(now.getTime() - FISCAL_CLAIM_TIMEOUT_MS);
}

const toJson = (value: unknown) =>
  JSON.parse(
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as Prisma.InputJsonValue;

/** Create (if needed) and attempt the fiscal return of a refund. Never throws. */
export async function runRefundFiscal(refundId: string): Promise<void> {
  try {
    let receipt = await db.fiscalReceipt.findUnique({ where: { refundId } });
    if (!receipt) {
      try {
        receipt = await db.fiscalReceipt.create({
          data: { provider: getFiscalProvider().name, refundId, status: "PENDING" },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
          throw error;
        }
        receipt = await db.fiscalReceipt.findUnique({ where: { refundId } });
      }
    }
    if (receipt && receipt.status !== "ISSUED" && receipt.status !== "CANCELLED") {
      await retryFiscalReturn(receipt.id);
    }
  } catch (error) {
    console.error("[post-refund] fiscal return failed", refundId, error);
  }
}

/** One attempt at a PENDING / FAILED (or stale ISSUING) refund receipt. Returns the status. */
export async function retryFiscalReturn(
  fiscalReceiptId: string,
  now: Date = new Date(),
): Promise<string> {
  const receipt = await db.fiscalReceipt.findUnique({
    where: { id: fiscalReceiptId },
    include: {
      refund: { include: { sale: { include: { fiscalReceipt: true } } } },
    },
  });
  if (!receipt?.refund) return receipt?.status ?? "FAILED";
  if (receipt.status === "ISSUED" || receipt.status === "CANCELLED") return receipt.status;

  const claim = await db.fiscalReceipt.updateMany({
    where: {
      id: receipt.id,
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        {
          status: "ISSUING",
          OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore(now) } }],
        },
      ],
    },
    data: { status: "ISSUING", claimedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count !== 1) {
    const current = await db.fiscalReceipt.findUnique({
      where: { id: receipt.id },
      select: { status: true },
    });
    return current?.status ?? "ISSUING";
  }
  const mine = { id: receipt.id, status: "ISSUING" as const, claimedAt: now };
  const refund = receipt.refund;
  const original = refund.sale.fiscalReceipt;
  const request = {
    refundId: refund.id,
    originalExternalId: original?.externalId ?? "",
    receiptNumber: refund.number,
    issuedAt: refund.occurredAt,
    total: refund.totalAmount,
  };
  try {
    if (!original || original.status !== "ISSUED" || !original.externalId) {
      throw new Error("the original sale has no issued fiscal receipt yet");
    }
    const issued = await getFiscalProvider().issueReturn(request);
    const done = await db.fiscalReceipt.updateMany({
      where: mine,
      data: {
        status: "ISSUED",
        externalId: issued.externalId,
        lotteryCode: issued.lotteryCode ?? null,
        qrData: issued.qrData ?? null,
        request: toJson(request),
        response: issued.raw as Prisma.InputJsonValue,
        error: null,
        claimedAt: null,
        issuedAt: new Date(),
      },
    });
    if (done.count !== 1) return "ISSUING";
    await audit(db, {
      actorId: null,
      action: "fiscal.return_issued",
      entityType: "Refund",
      entityId: refund.id,
      locationId: refund.locationId,
      after: { externalId: issued.externalId },
    });
    return "ISSUED";
  } catch (error) {
    await db.fiscalReceipt.updateMany({
      where: mine,
      data: {
        status: "FAILED",
        request: toJson(request),
        error: (error instanceof Error ? error.message : "unknown error").slice(0, 500),
        claimedAt: null,
      },
    });
    return "FAILED";
  }
}

/**
 * The fiscal side of a void. Safe to run repeatedly and concurrently; returns
 * the resulting status ("CANCELLED", or the status it had when it could not
 * act: "ISSUING" while another runner is issuing, "ISSUED" after a failed
 * return, which `reconcileFiscalReturns` retries).
 */
export async function runVoidFiscal(saleId: string, now: Date = new Date()): Promise<string> {
  try {
    const sale = await db.sale.findUnique({
      where: { id: saleId },
      include: { fiscalReceipt: true },
    });
    if (!sale) return "FAILED";
    const receipt = sale.fiscalReceipt;
    if (!receipt) {
      try {
        await db.fiscalReceipt.create({
          data: { provider: getFiscalProvider().name, saleId, status: "CANCELLED" },
        });
      } catch (error) {
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
          throw error;
        }
      }
      return "CANCELLED";
    }
    if (receipt.status === "CANCELLED") return "CANCELLED";
    if (receipt.status === "ISSUING") {
      const stale = receipt.claimedAt === null || receipt.claimedAt < staleBefore(now);
      if (!stale) return "ISSUING";
    }
    if (receipt.externalId === null) {
      // Nothing was ever reported to the tax authority.
      const done = await db.fiscalReceipt.updateMany({
        where: {
          id: receipt.id,
          externalId: null,
          status: { in: ["PENDING", "FAILED", "ISSUING"] },
        },
        data: { status: "CANCELLED", claimedAt: null, error: null },
      });
      return done.count === 1 ? "CANCELLED" : "ISSUING";
    }

    // Issued: report the return. A claim on `claimedAt` keeps runners apart.
    const claim = await db.fiscalReceipt.updateMany({
      where: {
        id: receipt.id,
        status: { in: ["ISSUED", "ISSUING"] },
        externalId: { not: null },
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore(now) } }],
      },
      data: { claimedAt: now, attempts: { increment: 1 } },
    });
    if (claim.count !== 1) return receipt.status;
    const request = {
      refundId: saleId, // the provider idempotency key of a void is the sale id
      originalExternalId: receipt.externalId,
      receiptNumber: sale.number,
      issuedAt: now,
      total: sale.totalAmount,
    };
    try {
      const returned = await getFiscalProvider().issueReturn(request);
      await db.fiscalReceipt.updateMany({
        where: { id: receipt.id, claimedAt: now },
        data: {
          status: "CANCELLED",
          claimedAt: null,
          error: null,
          response: toJson({ issue: receipt.response, return: returned.raw }),
        },
      });
      await audit(db, {
        actorId: null,
        action: "fiscal.void_return_issued",
        entityType: "Sale",
        entityId: saleId,
        locationId: sale.locationId,
        after: { externalId: returned.externalId },
      });
      return "CANCELLED";
    } catch (error) {
      await db.fiscalReceipt.updateMany({
        where: { id: receipt.id, claimedAt: now },
        data: {
          claimedAt: null,
          error: (error instanceof Error ? error.message : "unknown error").slice(0, 500),
        },
      });
      return "ISSUED";
    }
  } catch (error) {
    console.error("[post-refund] void fiscal failed", saleId, error);
    return "FAILED";
  }
}

/**
 * Retry sweep (cron / admin button): refunds without a fiscal row, PENDING /
 * FAILED / stale refund receipts, and voided sales whose fiscal document is
 * still open. Returns how many were attempted.
 */
export async function reconcileFiscalReturns(limit = 50): Promise<number> {
  let attempted = 0;
  const refunds = await db.refund.findMany({
    where: { fiscalReceipt: null },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const refund of refunds) {
    await runRefundFiscal(refund.id);
    attempted++;
  }
  const open = await db.fiscalReceipt.findMany({
    where: {
      refundId: { not: null },
      OR: [
        { status: { in: ["PENDING", "FAILED"] } },
        { status: "ISSUING", claimedAt: { lt: staleBefore(new Date()) } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const receipt of open) {
    await retryFiscalReturn(receipt.id).catch(() => undefined);
    attempted++;
  }
  const voided = await db.sale.findMany({
    where: {
      void: { isNot: null },
      fiscalReceipt: { is: { status: { not: "CANCELLED" } } },
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const sale of voided) {
    await runVoidFiscal(sale.id);
    attempted++;
  }
  return attempted;
}
