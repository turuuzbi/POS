import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import {
  buildRefundReceiptModel,
  buildVoidReceiptModel,
  type CreditAudience,
  type RefundReceiptModel,
  type VoidReceiptModel,
} from "@/domain/receipt-credit";
import type { ReceiptSource } from "@/domain/receipt";
import { db } from "../db";
import { creditNoteToken, verifyCreditNoteToken, type CreditNoteKind } from "./credit-note-token";
import { isSaleId, loadBusiness } from "./receipts";

/**
 * Credit notes (refund receipts) and void slips as printable models. Like the
 * sale receipt, everything goes through one explicit `select`: no ids, costs,
 * staff PINs or the refund's internal note ever reach the model.
 */

const locationSelect = {
  select: { name: true, address: true, phone: true, timezone: true, receiptHeader: true },
} as const;

const lineSelect = {
  lineNo: true,
  name: true,
  sku: true,
  unit: true,
  unitPrice: true,
  taxTreatment: true,
  vatRateBps: true,
  cityTaxRateBps: true,
} as const;

const refundSelect = {
  id: true,
  number: true,
  locationId: true,
  occurredAt: true,
  reason: true,
  netAmount: true,
  vatAmount: true,
  cityTaxAmount: true,
  tipAmount: true,
  roundingAmount: true,
  totalAmount: true,
  processedBy: { select: { name: true } },
  approvedBy: { select: { name: true } },
  location: locationSelect,
  sale: { select: { number: true } },
  exchangeSale: { select: { number: true } },
  fiscalReceipt: { select: { status: true } },
  lines: {
    orderBy: { saleLine: { lineNo: "asc" } },
    select: {
      qtyMilli: true,
      restock: true,
      netAmount: true,
      vatAmount: true,
      cityTaxAmount: true,
      totalAmount: true,
      saleLine: { select: lineSelect },
    },
  },
  payments: {
    orderBy: { createdAt: "asc" },
    select: {
      method: true,
      amount: true,
      reference: true,
      originalPayment: { select: { cardBrand: true, cardLast4: true } },
    },
  },
} satisfies Prisma.RefundSelect;

const voidSelect = {
  id: true,
  number: true,
  locationId: true,
  occurredAt: true,
  netAmount: true,
  vatAmount: true,
  cityTaxAmount: true,
  totalAmount: true,
  cashier: { select: { name: true } },
  location: locationSelect,
  void: {
    select: {
      createdAt: true,
      reason: true,
      voidedBy: { select: { name: true } },
      approvedBy: { select: { name: true } },
    },
  },
  fiscalReceipt: { select: { status: true } },
  lines: {
    orderBy: { lineNo: "asc" },
    select: {
      ...lineSelect,
      qtyMilli: true,
      netAmount: true,
      vatAmount: true,
      cityTaxAmount: true,
      totalAmount: true,
    },
  },
  payments: {
    orderBy: { createdAt: "asc" },
    select: {
      method: true,
      amount: true,
      reference: true,
      cardBrand: true,
      cardLast4: true,
    },
  },
} satisfies Prisma.SaleSelect;

async function businessSource(): Promise<ReceiptSource["business"]> {
  const business = await loadBusiness();
  return (
    business && {
      name: business.businessName,
      legalName: business.legalName,
      taxId: business.taxId,
      phone: business.phone,
      email: business.email,
      address: business.address,
      header: business.receiptHeader,
      footer: business.receiptFooter,
    }
  );
}

const locationSource = (l: {
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  receiptHeader: string | null;
}): ReceiptSource["location"] => ({
  name: l.name,
  address: l.address,
  phone: l.phone,
  timezone: l.timezone,
  header: l.receiptHeader,
});

export type LocationGuard = (locationId: string) => boolean;

export interface RefundReceipt {
  model: RefundReceiptModel;
  /** Share token for `/r/refund/<token>` (derived, see credit-note-token.ts). */
  shareToken: string;
}

export interface VoidReceipt {
  model: VoidReceiptModel;
  shareToken: string;
}

async function loadRefund(refundId: string, audience: CreditAudience) {
  const row = await db.refund.findUnique({ where: { id: refundId }, select: refundSelect });
  if (!row) return null;
  const model = buildRefundReceiptModel(
    {
      business: await businessSource(),
      location: locationSource(row.location),
      refund: {
        number: row.number,
        occurredAt: row.occurredAt,
        processedByName: row.processedBy.name,
        approvedByName: row.approvedBy?.name,
        reason: row.reason,
        netAmount: row.netAmount,
        vatAmount: row.vatAmount,
        cityTaxAmount: row.cityTaxAmount,
        tipAmount: row.tipAmount,
        roundingAmount: row.roundingAmount,
        totalAmount: row.totalAmount,
      },
      originalSale: { number: row.sale.number },
      exchangeSale: row.exchangeSale,
      lines: row.lines.map((l) => ({
        ...l.saleLine,
        qtyMilli: l.qtyMilli,
        restock: l.restock,
        netAmount: l.netAmount,
        vatAmount: l.vatAmount,
        cityTaxAmount: l.cityTaxAmount,
        totalAmount: l.totalAmount,
      })),
      payments: row.payments.map((p) => ({
        method: p.method,
        amount: p.amount,
        reference: p.reference,
        cardBrand: p.originalPayment?.cardBrand,
        cardLast4: p.originalPayment?.cardLast4,
      })),
      fiscal: row.fiscalReceipt,
    },
    audience,
  );
  return { model, locationId: row.locationId, id: row.id };
}

/** Refund receipt for staff by refund id; outside the user's locations looks like missing. */
export async function getRefundReceiptForStaff(
  refundId: string,
  canAccessLocation: LocationGuard,
): Promise<RefundReceipt | null> {
  if (!isSaleId(refundId)) return null;
  const loaded = await loadRefund(refundId, "staff");
  if (!loaded || !canAccessLocation(loaded.locationId)) return null;
  const shareToken = creditNoteToken("refund", loaded.id);
  return shareToken ? { model: loaded.model, shareToken } : null;
}

/** Refund receipt for a public share token (the token is the only credential). */
export async function getRefundReceiptByToken(token: string): Promise<RefundReceipt | null> {
  const id = verifyCreditNoteToken("refund", token);
  if (!id) return null;
  const loaded = await loadRefund(id, "public");
  return loaded ? { model: loaded.model, shareToken: token } : null;
}

async function loadVoid(saleId: string, audience: CreditAudience) {
  const row = await db.sale.findUnique({ where: { id: saleId }, select: voidSelect });
  if (!row?.void) return null;
  const model = buildVoidReceiptModel(
    {
      business: await businessSource(),
      location: locationSource(row.location),
      sale: {
        number: row.number,
        occurredAt: row.occurredAt,
        cashierName: row.cashier.name,
        totalAmount: row.totalAmount,
        netAmount: row.netAmount,
        vatAmount: row.vatAmount,
        cityTaxAmount: row.cityTaxAmount,
      },
      void: {
        occurredAt: row.void.createdAt,
        reason: row.void.reason,
        voidedByName: row.void.voidedBy.name,
        approvedByName: row.void.approvedBy?.name,
      },
      lines: row.lines,
      payments: row.payments,
      fiscal: row.fiscalReceipt,
    },
    audience,
  );
  return { model, locationId: row.locationId, id: row.id };
}

/** Void slip for staff by SALE id; null when the sale is not voided or out of scope. */
export async function getVoidReceiptForStaff(
  saleId: string,
  canAccessLocation: LocationGuard,
): Promise<VoidReceipt | null> {
  if (!isSaleId(saleId)) return null;
  const loaded = await loadVoid(saleId, "staff");
  if (!loaded || !canAccessLocation(loaded.locationId)) return null;
  const shareToken = creditNoteToken("void", loaded.id);
  return shareToken ? { model: loaded.model, shareToken } : null;
}

export async function getVoidReceiptByToken(token: string): Promise<VoidReceipt | null> {
  const id = verifyCreditNoteToken("void", token);
  if (!id) return null;
  const loaded = await loadVoid(id, "public");
  return loaded ? { model: loaded.model, shareToken: token } : null;
}

export type { CreditNoteKind };
