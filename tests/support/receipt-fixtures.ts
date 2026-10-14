import { randomUUID } from "node:crypto";
import { randomToken } from "@/server/crypto";
import { db } from "@/server/db";
import { createLocation, createProduct, createUser } from "./fixtures";

/**
 * Sales are append-only (DB triggers), so a receipt fixture is written once,
 * complete, by direct inserts. The checkout service is built elsewhere; these
 * helpers deliberately do not use it.
 */

export interface FixtureLine {
  name: string;
  unit?: "PIECE" | "KG" | "LITER" | "METER";
  qtyMilli: number;
  unitPrice: bigint;
  /** Line total incl. tax. */
  total: bigint;
  vat: bigint;
  vatRateBps?: number;
  taxTreatment?: "STANDARD" | "ZERO_RATED" | "EXEMPT";
  /** Cost snapshot; must never appear on a receipt. */
  unitCost?: bigint;
  discount?: bigint;
}

export interface FixturePayment {
  method: "CASH" | "CARD" | "QPAY" | "BANK_TRANSFER";
  amount: bigint;
  tendered?: bigint;
  change?: bigint;
  cardBrand?: string;
  cardLast4?: string;
  reference?: string;
}

export const SPLIT_TENDER_LINES: FixtureLine[] = [
  { name: "Сүү 1л", qtyMilli: 2000, unitPrice: 500_000n, total: 1_000_000n, vat: 90_909n },
  {
    name: "Алим",
    unit: "KG",
    qtyMilli: 1500,
    unitPrice: 400_000n,
    total: 600_000n,
    vat: 54_545n,
    unitCost: 123_456n,
  },
  {
    name: "Ном",
    qtyMilli: 1000,
    unitPrice: 250_150n,
    total: 250_150n,
    vat: 0n,
    taxTreatment: "EXEMPT",
  },
];

export const SPLIT_TENDER_PAYMENTS: FixturePayment[] = [
  { method: "CARD", amount: 1_000_000n, cardBrand: "VISA", cardLast4: "4242" },
  { method: "CASH", amount: 850_200n, tendered: 1_000_000n, change: 149_800n },
];

export interface ReceiptSaleOptions {
  lines?: FixtureLine[];
  payments?: FixturePayment[];
  roundingAmount?: bigint;
  token?: string;
  number?: string;
  voided?: boolean;
  occurredAt?: Date;
  /** Reuse an existing location/shift/cashier (to make several sales). */
  context?: ReceiptContext;
}

export interface ReceiptContext {
  locationId: string;
  registerId: string;
  shiftId: string;
  cashierId: string;
  cashierName: string;
  variantId: string;
  productId: string;
}

export async function createReceiptContext(
  overrides: { locationName?: string } = {},
): Promise<ReceiptContext> {
  const { location, register } = await createLocation({ name: overrides.locationName });
  const cashier = await createUser({ role: "CASHIER", locationIds: [location.id] });
  const shift = await db.shift.create({
    data: {
      registerId: register.id,
      locationId: location.id,
      openedById: cashier.id,
      openingFloat: 0n,
    },
  });
  const { product, variant } = await createProduct({ trackStock: false });
  return {
    locationId: location.id,
    registerId: register.id,
    shiftId: shift.id,
    cashierId: cashier.id,
    cashierName: cashier.name,
    variantId: variant.id,
    productId: product.id,
  };
}

export async function createBusinessSettings(
  data: Partial<{
    businessName: string;
    taxId: string;
    phone: string;
    address: string;
    receiptFooter: string;
  }> = {},
) {
  return db.businessSettings.upsert({
    where: { id: 1 },
    update: data,
    create: { id: 1, businessName: data.businessName ?? "Номин Маркет", ...data },
  });
}

/** Inserts a complete sale (+ lines, discounts, payments, optional void) and returns its keys. */
export async function createReceiptSale(options: ReceiptSaleOptions = {}) {
  const context = options.context ?? (await createReceiptContext());
  const lines = options.lines ?? SPLIT_TENDER_LINES;
  const payments = options.payments ?? SPLIT_TENDER_PAYMENTS;
  const items = lines.reduce((s, l) => s + l.total, 0n);
  const vat = lines.reduce((s, l) => s + l.vat, 0n);
  const rounding = options.roundingAmount ?? 50n;
  const discount = lines.reduce((s, l) => s + (l.discount ?? 0n), 0n);
  const id = randomUUID();
  const token = options.token ?? randomToken(32);

  await db.sale.create({
    data: {
      id,
      number: options.number ?? `UB-${id.slice(0, 8)}`,
      locationId: context.locationId,
      registerId: context.registerId,
      shiftId: context.shiftId,
      cashierId: context.cashierId,
      occurredAt: options.occurredAt ?? new Date("2026-10-14T17:30:00Z"),
      netAmount: items - vat,
      vatAmount: vat,
      discountAmount: discount,
      itemsAmount: items,
      roundingAmount: rounding,
      totalAmount: items + rounding,
      publicToken: token,
      lines: {
        create: lines.map((line, index) => ({
          lineNo: index + 1,
          variantId: context.variantId,
          productId: context.productId,
          name: line.name,
          productType: "STANDARD" as const,
          unit: line.unit ?? "PIECE",
          qtyMilli: line.qtyMilli,
          catalogUnitPrice: line.unitPrice,
          unitPrice: line.unitPrice,
          pricesIncludeTax: true,
          taxTreatment: line.taxTreatment ?? "STANDARD",
          vatRateBps: line.vatRateBps ?? 1000,
          grossAmount: line.total + (line.discount ?? 0n),
          discountAmount: line.discount ?? 0n,
          netAmount: line.total - line.vat,
          vatAmount: line.vat,
          totalAmount: line.total,
          unitCost: line.unitCost ?? 0n,
        })),
      },
      payments: {
        create: payments.map((payment) => ({
          method: payment.method,
          amount: payment.amount,
          tendered: payment.tendered ?? null,
          change: payment.change ?? 0n,
          cardBrand: payment.cardBrand ?? null,
          cardLast4: payment.cardLast4 ?? null,
          reference: payment.reference ?? null,
        })),
      },
    },
  });

  const saleLines = await db.saleLine.findMany({
    where: { saleId: id },
    orderBy: { lineNo: "asc" },
  });
  for (const [index, line] of lines.entries()) {
    if (!line.discount) continue;
    await db.saleDiscount.create({
      data: {
        saleId: id,
        saleLineId: saleLines[index]!.id,
        scope: "LINE",
        source: "MANUAL",
        kind: "FIXED",
        fixedAmount: line.discount,
        amount: line.discount,
      },
    });
  }
  if (options.voided) {
    await db.saleVoid.create({
      data: {
        saleId: id,
        shiftId: context.shiftId,
        reason: "ENTRY_ERROR",
        voidedById: context.cashierId,
      },
    });
  }
  return { id, token, context };
}
