import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { buildReceiptModel, type ReceiptModel, type ReceiptSource } from "@/domain/receipt";
import { randomToken, safeEqual } from "../crypto";
import { db } from "../db";

/**
 * Loads sales as printable receipt models. Everything is read through one
 * explicit `select`, so internal ids, costs and staff data never reach a
 * receipt (and so never reach the public share page or the PDF).
 */

/** Share tokens are `randomToken()` output: base64url, 256 bits = 43 chars. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A new unguessable receipt share token (stored as `Sale.publicToken`). */
export function newReceiptToken(): string {
  return randomToken(32);
}

/** Cheap shape check done before touching the database (keeps junk probes off it). */
export function isPlausibleReceiptToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function isSaleId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

const receiptSelect = {
  number: true,
  publicToken: true,
  locationId: true,
  occurredAt: true,
  netAmount: true,
  vatAmount: true,
  cityTaxAmount: true,
  discountAmount: true,
  itemsAmount: true,
  tipAmount: true,
  roundingAmount: true,
  totalAmount: true,
  buyerTaxId: true,
  note: true,
  cashier: { select: { name: true } },
  location: {
    select: { name: true, address: true, phone: true, timezone: true, receiptHeader: true },
  },
  void: { select: { saleId: true } },
  refunds: {
    orderBy: { occurredAt: "asc" },
    select: { number: true, occurredAt: true, totalAmount: true },
  },
  fiscalReceipt: { select: { status: true, lotteryCode: true, qrData: true } },
  lines: {
    orderBy: { lineNo: "asc" },
    select: {
      lineNo: true,
      name: true,
      sku: true,
      unit: true,
      qtyMilli: true,
      unitPrice: true,
      taxTreatment: true,
      vatRateBps: true,
      cityTaxRateBps: true,
      netAmount: true,
      vatAmount: true,
      cityTaxAmount: true,
      totalAmount: true,
      note: true,
      modifiers: { select: { name: true, priceDelta: true } },
    },
  },
  discounts: {
    select: { amount: true, reason: true, saleLine: { select: { lineNo: true } } },
  },
  payments: {
    orderBy: { createdAt: "asc" },
    select: {
      method: true,
      amount: true,
      tendered: true,
      change: true,
      reference: true,
      cardBrand: true,
      cardLast4: true,
    },
  },
} satisfies Prisma.SaleSelect;

type ReceiptRow = Prisma.SaleGetPayload<{ select: typeof receiptSelect }>;

export async function loadBusiness() {
  return db.businessSettings.findUnique({
    where: { id: 1 },
    select: {
      businessName: true,
      legalName: true,
      taxId: true,
      phone: true,
      email: true,
      address: true,
      receiptHeader: true,
      receiptFooter: true,
    },
  });
}

async function toModel(row: ReceiptRow): Promise<ReceiptModel> {
  const business = await loadBusiness();
  const source: ReceiptSource = {
    business: business && {
      name: business.businessName,
      legalName: business.legalName,
      taxId: business.taxId,
      phone: business.phone,
      email: business.email,
      address: business.address,
      header: business.receiptHeader,
      footer: business.receiptFooter,
    },
    location: {
      name: row.location.name,
      address: row.location.address,
      phone: row.location.phone,
      timezone: row.location.timezone,
      header: row.location.receiptHeader,
    },
    sale: {
      number: row.number,
      occurredAt: row.occurredAt,
      cashierName: row.cashier.name,
      netAmount: row.netAmount,
      vatAmount: row.vatAmount,
      cityTaxAmount: row.cityTaxAmount,
      discountAmount: row.discountAmount,
      itemsAmount: row.itemsAmount,
      tipAmount: row.tipAmount,
      roundingAmount: row.roundingAmount,
      totalAmount: row.totalAmount,
      buyerTaxId: row.buyerTaxId,
      note: row.note,
      voided: row.void !== null,
    },
    lines: row.lines,
    discounts: row.discounts.map((d) => ({
      saleLineNo: d.saleLine?.lineNo ?? null,
      amount: d.amount,
      reason: d.reason,
    })),
    payments: row.payments,
    fiscal: row.fiscalReceipt,
    refunds: row.refunds,
  };
  return buildReceiptModel(source);
}

/**
 * Receipt for a public share token, or null. The token is the only
 * credential: shape-checked first, looked up through the unique index, then
 * compared in constant time before anything is returned.
 */
export async function getReceiptByToken(token: string): Promise<{ model: ReceiptModel } | null> {
  if (!isPlausibleReceiptToken(token)) return null;
  const row = await db.sale.findUnique({ where: { publicToken: token }, select: receiptSelect });
  if (!row || !safeEqual(row.publicToken, token)) return null;
  return { model: await toModel(row) };
}

export interface StaffReceipt {
  model: ReceiptModel;
  shareToken: string;
}

/**
 * Receipt for staff by sale id. `canAccessLocation` is the caller's
 * location-scope check; a sale outside the user's locations looks exactly
 * like a missing one.
 */
export async function getReceiptForStaff(
  saleId: string,
  canAccessLocation: (locationId: string) => boolean,
): Promise<StaffReceipt | null> {
  if (!isSaleId(saleId)) return null;
  const row = await db.sale.findUnique({ where: { id: saleId }, select: receiptSelect });
  if (!row || !canAccessLocation(row.locationId)) return null;
  return { model: await toModel(row), shareToken: row.publicToken };
}
