import { randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { withE2eDb } from "../db";
import type { RegisterSession } from "./register";

/**
 * Inserts finished sales straight into the e2e database for the Returns UI to
 * find (checkout is covered elsewhere and the refund SERVICE is not under test
 * here). Sales are append-only, so every call adds rows and nothing is ever
 * updated or removed; numbers are unique per call ("E2E-XXXXXX").
 *
 * Shape (money in möngö), the same as `makeSale` in src/lib/refunds/test-fixtures.ts:
 *   Сүү 1л  2 pcs   1 000 000   VAT 90 909   (tracked)
 *   Алим    1.5 kg    600 000   VAT 54 545   (weighed)
 *   Ном     1 pc      250 150   VAT exempt
 *   total 1 850 200 = items 1 850 150 + rounding 50; CARD 1 000 000 + CASH 850 200
 */
export interface E2eSale {
  id: string;
  number: string;
  shiftId: string;
  lineIds: { milk: string; apples: string; book: string };
  paymentIds: { card: string; cash: string };
}

export const SALE_TOTAL = 1_850_200n;

export async function openShiftId(registerId: string): Promise<string> {
  let id: string | undefined;
  await withE2eDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      `SELECT id FROM "Shift" WHERE "registerId" = $1 AND status = 'OPEN'`,
      [registerId],
    );
    id = rows[0]?.id;
  });
  if (!id) throw new Error("no open shift");
  return id;
}

export async function insertSale(
  session: RegisterSession,
  options: { shift: "open" | "closed"; occurredAt?: string } = { shift: "open" },
): Promise<E2eSale> {
  const sale: E2eSale = {
    id: uuidv7(),
    number: `E2E-${randomBytes(3).toString("hex").toUpperCase()}`,
    shiftId: "",
    lineIds: { milk: uuidv7(), apples: uuidv7(), book: uuidv7() },
    paymentIds: { card: uuidv7(), cash: uuidv7() },
  };
  await withE2eDb(async (db) => {
    const { rows } = await db.query<{ variantId: string; productId: string }>(
      `SELECT v.id AS "variantId", v."productId"
         FROM "ProductVariant" v JOIN "Product" p ON p.id = v."productId"
        WHERE p."trackStock" AND p."type" = 'STANDARD' ORDER BY v.id LIMIT 1`,
    );
    const ref = rows[0];
    if (!ref) throw new Error("e2e: seed data missing (run pnpm db:seed)");

    if (options.shift === "open") {
      const open = await db.query<{ id: string }>(
        `SELECT id FROM "Shift" WHERE "registerId" = $1 AND status = 'OPEN'`,
        [session.registerId],
      );
      sale.shiftId = open.rows[0]!.id;
    } else {
      sale.shiftId = uuidv7();
      await db.query(
        `INSERT INTO "Shift" (id, "registerId", "locationId", status, "openedById", "openingFloat",
                              "closedById", "closedAt", "expectedCash", "countedCash", "cashVariance")
         VALUES ($1, $2, $3, 'CLOSED', $4, 0, $4, now(), 0, 0, 0)`,
        [sale.shiftId, session.registerId, session.locationId, session.cashierId],
      );
    }

    await db.query(
      `INSERT INTO "Sale" (id, number, "locationId", "registerId", "shiftId", "cashierId", "occurredAt",
                           "netAmount", "vatAmount", "discountAmount", "itemsAmount", "roundingAmount",
                           "totalAmount", "publicToken")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1704696, 145454, 0, 1850150, 50, 1850200, $8)`,
      [
        sale.id,
        sale.number,
        session.locationId,
        session.registerId,
        sale.shiftId,
        session.cashierId,
        options.occurredAt ?? new Date(Date.now() - 60_000).toISOString(),
        randomBytes(32).toString("base64url"),
      ],
    );
    const lines: [
      number,
      string,
      string,
      string,
      number,
      number,
      number,
      number,
      string,
      number,
    ][] = [
      // lineNo, id, name, unit, qtyMilli, unitPrice, total, vat, treatment, net
      [1, sale.lineIds.milk, "Сүү 1л", "PIECE", 2000, 500000, 1000000, 90909, "STANDARD", 909091],
      [2, sale.lineIds.apples, "Алим", "KG", 1500, 400000, 600000, 54545, "STANDARD", 545455],
      [3, sale.lineIds.book, "Ном", "PIECE", 1000, 250150, 250150, 0, "EXEMPT", 250150],
    ];
    for (const [lineNo, id, name, unit, qty, price, total, vat, treatment, net] of lines) {
      await db.query(
        `INSERT INTO "SaleLine" (id, "saleId", "lineNo", "variantId", "productId", name, "productType",
                                 unit, "qtyMilli", "catalogUnitPrice", "unitPrice", "pricesIncludeTax",
                                 "taxTreatment", "vatRateBps", "grossAmount", "netAmount", "vatAmount",
                                 "totalAmount", "unitCost")
         VALUES ($1, $2, $3, $4, $5, $6, 'STANDARD', $7::"UnitOfMeasure", $8, $9, $9, true,
                 $10::"TaxTreatment", 1000, $11, $12, $13, $11, 0)`,
        [
          id,
          sale.id,
          lineNo,
          ref.variantId,
          ref.productId,
          name,
          unit,
          qty,
          price,
          treatment,
          total,
          net,
          vat,
        ],
      );
    }
    await db.query(
      `INSERT INTO "SalePayment" (id, "saleId", method, amount, change, "cardBrand", "cardLast4")
       VALUES ($1, $2, 'CARD', 1000000, 0, 'VISA', '4242')`,
      [sale.paymentIds.card, sale.id],
    );
    await db.query(
      `INSERT INTO "SalePayment" (id, "saleId", method, amount, tendered, change)
       VALUES ($1, $2, 'CASH', 850200, 1000000, 149800)`,
      [sale.paymentIds.cash, sale.id],
    );
  });
  return sale;
}

/** A refund of one of the two milk bottles (what the service would have written). */
export async function insertMilkRefund(session: RegisterSession, sale: E2eSale) {
  await withE2eDb(async (db) => {
    const refundId = uuidv7();
    await db.query(
      `INSERT INTO "Refund" (id, number, "saleId", "locationId", "registerId", "shiftId", "processedById",
                             reason, "netAmount", "vatAmount", "cityTaxAmount", "tipAmount", "roundingAmount",
                             "totalAmount", "occurredAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'DEFECTIVE', 454545, 45455, 0, 0, 0, 500000, now())`,
      [
        refundId,
        `${sale.number}-R1`,
        sale.id,
        session.locationId,
        session.registerId,
        sale.shiftId,
        session.cashierId,
      ],
    );
    await db.query(
      `INSERT INTO "RefundLine" (id, "refundId", "saleLineId", "qtyMilli", restock, "netAmount",
                                 "vatAmount", "cityTaxAmount", "totalAmount", "unitCost")
       VALUES ($1, $2, $3, 1000, true, 454545, 45455, 0, 500000, 0)`,
      [uuidv7(), refundId, sale.lineIds.milk],
    );
    await db.query(
      `INSERT INTO "RefundPayment" (id, "refundId", method, amount, "originalPaymentId")
       VALUES ($1, $2, 'CARD', 500000, $3)`,
      [uuidv7(), refundId, sale.paymentIds.card],
    );
  });
}

/** Void a sale the way the service will write it (one SaleVoid row). */
export async function insertVoid(session: RegisterSession, sale: E2eSale) {
  await withE2eDb(async (db) => {
    await db.query(
      `INSERT INTO "SaleVoid" (id, "saleId", "shiftId", reason, "voidedById")
       VALUES ($1, $2, $3, 'ENTRY_ERROR', $4)`,
      [uuidv7(), sale.id, sale.shiftId, session.cashierId],
    );
  });
}
