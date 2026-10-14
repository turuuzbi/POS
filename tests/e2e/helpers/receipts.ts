import { randomBytes, randomUUID } from "node:crypto";
import { withE2eDb } from "../db";

export interface E2eReceipt {
  saleId: string;
  token: string;
  number: string;
}

/**
 * Inserts one finished split-tender sale straight into the e2e database (the
 * checkout flow is covered elsewhere). Sales are append-only, so every call
 * adds a new sale and a new closed shift; nothing is ever updated.
 * Uses the seeded location, register, cashier and catalog.
 */
export async function insertE2eReceipt(): Promise<E2eReceipt> {
  const saleId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const number = `E2E-${randomBytes(3).toString("hex").toUpperCase()}`;
  await withE2eDb(async (db) => {
    const { rows } = await db.query<{
      locationId: string;
      registerId: string;
      userId: string;
      variantId: string;
      productId: string;
    }>(
      `SELECT r."locationId", r.id AS "registerId", u.id AS "userId",
              v.id AS "variantId", v."productId"
         FROM "Register" r, "User" u, "ProductVariant" v
        WHERE u."role" = 'CASHIER' LIMIT 1`,
    );
    const ref = rows[0];
    if (!ref) throw new Error("e2e: seed data missing (run pnpm db:seed)");
    const shiftId = randomUUID();
    await db.query(
      `INSERT INTO "Shift" (id, "registerId", "locationId", status, "openedById", "openingFloat",
                            "closedById", "closedAt", "expectedCash", "countedCash", "cashVariance")
       VALUES ($1, $2, $3, 'CLOSED', $4, 0, $4, now(), 0, 0, 0)`,
      [shiftId, ref.registerId, ref.locationId, ref.userId],
    );
    await db.query(
      `INSERT INTO "Sale" (id, number, "locationId", "registerId", "shiftId", "cashierId", "occurredAt",
                           "netAmount", "vatAmount", "discountAmount", "itemsAmount", "roundingAmount",
                           "totalAmount", "publicToken")
       VALUES ($1, $2, $3, $4, $5, $6, '2026-10-14T17:30:00Z', 1704696, 145454, 0, 1850150, 50, 1850200, $7)`,
      [saleId, number, ref.locationId, ref.registerId, shiftId, ref.userId, token],
    );
    const lines: [number, string, string, number, number, number, number, string, number][] = [
      // lineNo, name, unit, qtyMilli, unitPrice, total, vat, treatment, net
      [1, "Сүү 1л", "PIECE", 2000, 500000, 1000000, 90909, "STANDARD", 909091],
      [2, "Алим", "KG", 1500, 400000, 600000, 54545, "STANDARD", 545455],
      [3, "Ном", "PIECE", 1000, 250150, 250150, 0, "EXEMPT", 250150],
    ];
    for (const [lineNo, name, unit, qty, price, total, vat, treatment, net] of lines) {
      await db.query(
        `INSERT INTO "SaleLine" (id, "saleId", "lineNo", "variantId", "productId", name, "productType",
                                 unit, "qtyMilli", "catalogUnitPrice", "unitPrice", "pricesIncludeTax",
                                 "taxTreatment", "vatRateBps", "grossAmount", "netAmount", "vatAmount",
                                 "totalAmount", "unitCost")
         VALUES ($1, $2, $3, $4, $5, $6, 'STANDARD', $7::"UnitOfMeasure", $8, $9, $9, true,
                 $10::"TaxTreatment", 1000, $11, $12, $13, $11, 0)`,
        [
          randomUUID(),
          saleId,
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
      [randomUUID(), saleId],
    );
    await db.query(
      `INSERT INTO "SalePayment" (id, "saleId", method, amount, tendered, change)
       VALUES ($1, $2, 'CASH', 850200, 1000000, 149800)`,
      [randomUUID(), saleId],
    );
  });
  return { saleId, token, number };
}
