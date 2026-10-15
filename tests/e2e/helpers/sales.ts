import { randomBytes, randomUUID } from "node:crypto";
import { withE2eDb } from "../db";

export interface E2eSale {
  id: string;
  number: string;
  token: string;
  refundIds: string[];
}

export interface E2eSalesSet {
  tag: string;
  completed: E2eSale;
  voided: E2eSale;
  partial: E2eSale;
  refunded: E2eSale;
  formula: E2eSale;
  /** Free text written into the partial refund's internal note; must never be public. */
  internalNote: string;
  /** Calendar day (Ulaanbaatar) all the sales fall on. */
  day: string;
}

/**
 * Inserts five finished sales straight into the e2e database (sales are
 * append-only, so every call adds new rows with a fresh tag and nothing is
 * ever updated). Statuses: completed, voided, partially refunded (QPay),
 * fully refunded (two refunds), and a completed sale whose receipt number
 * starts with "=" to exercise CSV formula safety.
 */
export async function insertE2eSalesSet(): Promise<E2eSalesSet> {
  const tag = randomBytes(3).toString("hex").toUpperCase();
  const internalNote = `INTERNAL-NOTE-${tag}`;
  const sales = {} as Record<string, E2eSale>;

  await withE2eDb(async (db) => {
    const { rows } = await db.query<{
      locationId: string;
      registerId: string;
      userId: string;
      managerId: string;
      variantId: string;
      productId: string;
    }>(
      `SELECT r."locationId", r.id AS "registerId", u.id AS "userId",
              (SELECT id FROM "User" WHERE role = 'MANAGER' AND email = 'manager@pos.local') AS "managerId",
              v.id AS "variantId", v."productId"
         FROM "Register" r, "User" u, "ProductVariant" v
        WHERE u."role" = 'CASHIER' AND u."name" = 'Болор' LIMIT 1`,
    );
    const found = rows[0];
    if (!found) throw new Error("e2e: seed data missing (run pnpm db:seed)");
    const ref = found;
    const shiftId = randomUUID();
    await db.query(
      `INSERT INTO "Shift" (id, "registerId", "locationId", status, "openedById", "openingFloat",
                            "closedById", "closedAt", "expectedCash", "countedCash", "cashVariance")
       VALUES ($1, $2, $3, 'CLOSED', $4, 0, $4, now(), 0, 0, 0)`,
      [shiftId, ref.registerId, ref.locationId, ref.userId],
    );

    // Two lines of 600 ₮ + 400 ₮ (60 000 + 40 000 möngö), VAT 10 % included.
    const LINES = [
      { no: 1, name: "Сүү", total: 60_000, vat: 5_455 },
      { no: 2, name: "Талх", total: 40_000, vat: 3_636 },
    ];

    async function insertSale(
      key: string,
      number: string,
      method: "CASH" | "CARD" | "QPAY",
      at: string,
    ): Promise<{ sale: E2eSale; lineIds: string[] }> {
      const id = randomUUID();
      const token = randomBytes(32).toString("base64url");
      await db.query(
        `INSERT INTO "Sale" (id, number, "locationId", "registerId", "shiftId", "cashierId", "occurredAt",
                             "netAmount", "vatAmount", "discountAmount", "itemsAmount", "roundingAmount",
                             "totalAmount", "publicToken")
         VALUES ($1, $2, $3, $4, $5, $6, $7, 90909, 9091, 0, 100000, 0, 100000, $8)`,
        [id, number, ref.locationId, ref.registerId, shiftId, ref.userId, at, token],
      );
      const lineIds: string[] = [];
      for (const line of LINES) {
        const lineId = randomUUID();
        lineIds.push(lineId);
        await db.query(
          `INSERT INTO "SaleLine" (id, "saleId", "lineNo", "variantId", "productId", name, "productType",
                                   unit, "qtyMilli", "catalogUnitPrice", "unitPrice", "pricesIncludeTax",
                                   "taxTreatment", "vatRateBps", "grossAmount", "netAmount", "vatAmount",
                                   "totalAmount", "unitCost")
           VALUES ($1, $2, $3, $4, $5, $6, 'STANDARD', 'PIECE', 1000, $7, $7, true,
                   'STANDARD', 1000, $7, $8, $9, $7, 0)`,
          [
            lineId,
            id,
            line.no,
            ref.variantId,
            ref.productId,
            `${line.name} ${tag}`,
            line.total,
            line.total - line.vat,
            line.vat,
          ],
        );
      }
      await db.query(
        `INSERT INTO "SalePayment" (id, "saleId", method, amount, change)
         VALUES ($1, $2, $3::"PaymentMethod", 100000, 0)`,
        [randomUUID(), id, method],
      );
      const sale: E2eSale = { id, number, token, refundIds: [] };
      sales[key] = sale;
      return { sale, lineIds };
    }

    async function insertRefund(
      sale: E2eSale,
      lineIds: string[],
      lineNos: number[],
      number: string,
      options: { note?: string; method?: "CASH" | "QPAY"; approved?: boolean } = {},
    ) {
      const chosen = LINES.filter((l) => lineNos.includes(l.no));
      const total = chosen.reduce((s, l) => s + l.total, 0);
      const vat = chosen.reduce((s, l) => s + l.vat, 0);
      const id = randomUUID();
      await db.query(
        `INSERT INTO "Refund" (id, number, "saleId", "locationId", "registerId", "shiftId", "processedById",
                               "approvedById", reason, note, "netAmount", "vatAmount", "totalAmount", "occurredAt")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'DAMAGED', $9, $10, $11, $12, '2026-10-14T11:00:00Z')`,
        [
          id,
          number,
          sale.id,
          ref.locationId,
          ref.registerId,
          shiftId,
          ref.userId,
          options.approved === false ? null : ref.managerId,
          options.note ?? null,
          total - vat,
          vat,
          total,
        ],
      );
      for (const line of chosen) {
        await db.query(
          `INSERT INTO "RefundLine" (id, "refundId", "saleLineId", "qtyMilli", restock, "netAmount",
                                     "vatAmount", "totalAmount", "unitCost")
           VALUES ($1, $2, $3, 1000, true, $4, $5, $6, 0)`,
          [randomUUID(), id, lineIds[line.no - 1], line.total - line.vat, line.vat, line.total],
        );
      }
      await db.query(
        `INSERT INTO "RefundPayment" (id, "refundId", method, amount)
         VALUES ($1, $2, $3::"PaymentMethod", $4)`,
        [randomUUID(), id, options.method ?? "CASH", total],
      );
      sale.refundIds.push(id);
    }

    const AT = "2026-10-14T10:00:00Z"; // 18:00 on the 14th in Ulaanbaatar
    await insertSale("completed", `OK-${tag}`, "CASH", AT);

    const voided = await insertSale("voided", `VD-${tag}`, "CARD", AT);
    await db.query(
      `INSERT INTO "SaleVoid" (id, "saleId", "shiftId", reason, "voidedById", "approvedById")
       VALUES ($1, $2, $3, 'ENTRY_ERROR', $4, $5)`,
      [randomUUID(), voided.sale.id, shiftId, ref.userId, ref.managerId],
    );

    const partial = await insertSale("partial", `PR-${tag}`, "QPAY", AT);
    await insertRefund(partial.sale, partial.lineIds, [1], `PR-R-${tag}`, {
      note: internalNote,
      method: "QPAY",
    });

    const refunded = await insertSale("refunded", `FR-${tag}`, "CASH", AT);
    await insertRefund(refunded.sale, refunded.lineIds, [1], `FR-R1-${tag}`);
    await insertRefund(refunded.sale, refunded.lineIds, [2], `FR-R2-${tag}`, { approved: false });

    await insertSale("formula", `=1+1-${tag}`, "CASH", AT);
  });

  return {
    tag,
    internalNote,
    day: "2026-10-14",
    completed: sales.completed!,
    voided: sales.voided!,
    partial: sales.partial!,
    refunded: sales.refunded!,
    formula: sales.formula!,
  };
}
