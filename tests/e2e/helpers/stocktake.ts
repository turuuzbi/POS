import { randomBytes, randomInt } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { withE2eDb } from "../db";

/** Short random suffix that keeps this spec's data unique across repeated runs. */
export function newToken(): string {
  return randomBytes(3).toString("hex");
}

export interface Item {
  productId: string;
  variantId: string;
  name: string;
  sku: string;
  barcode: string;
  unit: "PIECE" | "KG";
  /** tögrög per whole unit (stored in möngö, x100) */
  cost: number;
}

export interface Fixture {
  token: string;
  locationId: string;
  category: { id: string; name: string };
  emptyCategory: { id: string; name: string };
  otherCategory: { id: string; name: string };
  /** In scope, piece items: opening stock 10 and 5. */
  pieceA: Item;
  pieceB: Item;
  /** In scope, weighed: opening stock 3.5 kg. */
  weighed: Item;
  /** Archived before any count: never part of a stocktake. */
  archived: Item;
  /** Active but in another category: not part of the scoped stocktake. */
  outside: Item;
}

function ean13(body12: string): string {
  let sum = 0;
  for (const [i, ch] of [...body12].entries()) sum += Number(ch) * (i % 2 === 0 ? 1 : 3);
  return body12 + String((10 - (sum % 10)) % 10);
}

/** A unique, non-scale (does not start with 2) EAN-13. */
function uniqueBarcode(): string {
  return ean13("98" + String(randomInt(0, 10 ** 10)).padStart(10, "0"));
}

export const OPENING = { pieceA: 10_000, pieceB: 5_000, weighed: 3_500, outside: 7_000 };
const COST = { pieceA: 1_000, pieceB: 2_000, weighed: 10_000, outside: 500 };

/** Create this run's own catalog slice and stock it (opening movements, like the seed). */
export async function createFixture(token: string): Promise<Fixture> {
  let fixture!: Fixture;
  await withE2eDb(async (db) => {
    await db.query("BEGIN");
    try {
      const loc = (
        await db.query(`SELECT id FROM "Location" WHERE "isActive" ORDER BY "createdAt" LIMIT 1`)
      ).rows[0].id as string;
      const taxClassId = (await db.query(`SELECT id FROM "TaxClass" ORDER BY "createdAt" LIMIT 1`))
        .rows[0].id as string;
      const ownerId = (await db.query(`SELECT id FROM "User" WHERE "email" = 'owner@pos.local'`))
        .rows[0].id as string;

      const category = async (name: string) => {
        const r = await db.query(
          `INSERT INTO "Category" ("id","name","updatedAt") VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
          [name],
        );
        return { id: r.rows[0].id as string, name };
      };
      const item = async (
        key: string,
        label: string,
        unit: "PIECE" | "KG",
        categoryId: string,
        cost: number,
        opening: number | null,
        active = true,
      ): Promise<Item> => {
        const name = `Тест ${label} ${token}`;
        const sku = `E2E-ST-${key}-${token}`.toUpperCase();
        const barcode = uniqueBarcode();
        const p = await db.query(
          `INSERT INTO "Product" ("id","name","unit","categoryId","taxClassId","isActive","updatedAt")
           VALUES (gen_random_uuid(), $1, $2::"UnitOfMeasure", $3, $4, $5, now()) RETURNING id`,
          [name, unit, categoryId, taxClassId, active],
        );
        const productId = p.rows[0].id as string;
        const v = await db.query(
          `INSERT INTO "ProductVariant" ("id","productId","sku","price","cost","updatedAt")
           VALUES (gen_random_uuid(), $1, $2, $3, $4, now()) RETURNING id`,
          [productId, sku, cost * 200, cost * 100],
        );
        const variantId = v.rows[0].id as string;
        await db.query(
          `INSERT INTO "Barcode" ("id","code","variantId") VALUES (gen_random_uuid(), $1, $2)`,
          [barcode, variantId],
        );
        if (opening !== null) {
          await db.query(
            `INSERT INTO "StockLevel" ("variantId","locationId","onHandMilli","updatedAt") VALUES ($1,$2,$3,now())`,
            [variantId, loc, opening],
          );
          await db.query(
            `INSERT INTO "StockMovement" ("id","variantId","locationId","type","qtyDeltaMilli","balanceAfterMilli","unitCost","createdById")
             VALUES (gen_random_uuid(), $1, $2, 'OPENING', $3, $3, $4, $5)`,
            [variantId, loc, opening, cost * 100, ownerId],
          );
        }
        return { productId, variantId, name, sku, barcode, unit, cost };
      };

      const cat = await category(`Тест ангилал ${token}`);
      const empty = await category(`Тест хоосон ${token}`);
      const other = await category(`Тест өөр ${token}`);
      fixture = {
        token,
        locationId: loc,
        category: cat,
        emptyCategory: empty,
        otherCategory: other,
        pieceA: await item("a", "талх А", "PIECE", cat.id, COST.pieceA, OPENING.pieceA),
        pieceB: await item("b", "талх Б", "PIECE", cat.id, COST.pieceB, OPENING.pieceB),
        weighed: await item("w", "мах", "KG", cat.id, COST.weighed, OPENING.weighed),
        archived: await item("x", "архивласан", "PIECE", cat.id, 100, 4_000, false),
        outside: await item("o", "гадна", "PIECE", other.id, COST.outside, OPENING.outside),
      };
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  });
  return fixture;
}

/** Archive everything this run made so later full counts (and other specs) are unaffected. */
export async function retireFixture(token: string): Promise<void> {
  await withE2eDb(async (db) => {
    await db.query(`UPDATE "Product" SET "isActive" = false WHERE "name" LIKE $1`, [
      `Тест % ${token}`,
    ]);
    await db.query(`UPDATE "Category" SET "isActive" = false WHERE "name" LIKE $1`, [
      `Тест % ${token}`,
    ]);
  });
}

export async function onHand(variantId: string): Promise<number> {
  let value = 0;
  await withE2eDb(async (db) => {
    const r = await db.query(
      `SELECT COALESCE(SUM("onHandMilli"),0)::int AS q FROM "StockLevel" WHERE "variantId" = $1`,
      [variantId],
    );
    value = r.rows[0].q;
  });
  return value;
}

export interface MovementRow {
  type: string;
  qtyDeltaMilli: number;
  balanceAfterMilli: number;
  stocktakeId: string | null;
}

export async function movements(variantId: string): Promise<MovementRow[]> {
  let rows: MovementRow[] = [];
  await withE2eDb(async (db) => {
    const r = await db.query(
      `SELECT "type"::text AS type, "qtyDeltaMilli", "balanceAfterMilli", "stocktakeId"
       FROM "StockMovement" WHERE "variantId" = $1 ORDER BY "seq"`,
      [variantId],
    );
    rows = r.rows;
  });
  return rows;
}

/**
 * Another till / back-office user changing stock while a count is open:
 * a sale-like movement written through the ledger rules (level + movement,
 * one transaction, balance computed under the row lock).
 */
export async function externalMovement(
  variantId: string,
  locationId: string,
  deltaMilli: number,
  type: "SALE" | "PURCHASE_RECEIPT" | "ADJUSTMENT" = "SALE",
): Promise<void> {
  await withE2eDb(async (db) => {
    await db.query("BEGIN");
    try {
      const level = await db.query(
        `UPDATE "StockLevel" SET "onHandMilli" = "onHandMilli" + $3, "updatedAt" = now()
         WHERE "variantId" = $1 AND "locationId" = $2 RETURNING "onHandMilli"`,
        [variantId, locationId, deltaMilli],
      );
      const ownerId = (await db.query(`SELECT id FROM "User" WHERE "email" = 'owner@pos.local'`))
        .rows[0].id as string;
      await db.query(
        `INSERT INTO "StockMovement" ("id","variantId","locationId","type","qtyDeltaMilli","balanceAfterMilli","createdById")
         VALUES (gen_random_uuid(), $1, $2, $5::"StockMovementType", $3, $4, $6)`,
        [variantId, locationId, deltaMilli, level.rows[0].onHandMilli, type, ownerId],
      );
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  });
}

export interface StocktakeRow {
  id: string;
  number: string;
  status: string;
  categoryId: string | null;
  lines: {
    variantId: string;
    countedMilli: number | null;
    expectedMilli: number | null;
    varianceMilli: number | null;
  }[];
}

export async function stocktakesByNote(note: string): Promise<StocktakeRow[]> {
  const out: StocktakeRow[] = [];
  await withE2eDb(async (db) => {
    const r = await db.query(
      `SELECT "id","number","status"::text AS status,"categoryId" FROM "Stocktake" WHERE "note" = $1 ORDER BY "startedAt"`,
      [note],
    );
    for (const row of r.rows) {
      const lines = await db.query(
        `SELECT "variantId","countedMilli","expectedMilli","varianceMilli" FROM "StocktakeLine" WHERE "stocktakeId" = $1`,
        [row.id],
      );
      out.push({ ...row, lines: lines.rows });
    }
  });
  return out;
}

export async function stocktakeById(id: string): Promise<StocktakeRow> {
  let row!: StocktakeRow;
  await withE2eDb(async (db) => {
    const r = await db.query(
      `SELECT "id","number","status"::text AS status,"categoryId" FROM "Stocktake" WHERE "id" = $1`,
      [id],
    );
    const lines = await db.query(
      `SELECT "variantId","countedMilli","expectedMilli","varianceMilli" FROM "StocktakeLine" WHERE "stocktakeId" = $1`,
      [id],
    );
    row = { ...r.rows[0], lines: lines.rows };
  });
  return row;
}

export async function stocktakeMovementCount(id: string): Promise<number> {
  let count = 0;
  await withE2eDb(async (db) => {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM "StockMovement" WHERE "stocktakeId" = $1`,
      [id],
    );
    count = r.rows[0].n;
  });
  return count;
}

/** Collects console errors, page errors and failed/erroring requests during a flow. */
export function watchPage(page: Page, { ignore = [] as RegExp[] } = {}) {
  const problems: string[] = [];
  const skip = (text: string) => ignore.some((re) => re.test(text));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !skip(msg.text())) problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    // Navigations and RSC prefetches cancel each other; that is not a failure.
    if (request.failure()?.errorText === "net::ERR_ABORTED") return;
    problems.push(
      `requestfailed: ${request.method()} ${request.url()} ${request.failure()?.errorText}`,
    );
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !skip(response.url())) {
      problems.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  return {
    problems,
    expectNone: () => expect(problems, "console errors / failed requests").toEqual([]),
  };
}

/** No horizontal page overflow at the current viewport. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    overflow.scroll,
    `scrollWidth ${overflow.scroll} > clientWidth ${overflow.client}`,
  ).toBeLessThanOrEqual(overflow.client);
}

/** Fill a "{placeholder}" message from the Mongolian catalog. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(vars[key] ?? `{${key}}`));
}

export interface Started {
  id: string;
  number: string;
  url: string;
}
