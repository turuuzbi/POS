import { randomBytes, randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { Client } from "pg";
import { withE2eDb } from "../db";
import { mn, SEED } from "../fixtures";

/**
 * Helpers for the stock / adjustments / dashboard flow. Setup goes straight
 * to the database (products, locations, staff, opening balances); everything
 * the tests verify goes through the UI, with the ledger read back from the
 * database as the independent source of truth.
 */

export type Unit = "PIECE" | "KG";

export const token = () => randomBytes(3).toString("hex");

async function query<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  let out: T | undefined;
  let ran = false;
  await withE2eDb(async (db) => {
    out = await fn(db);
    ran = true;
  });
  if (!ran) throw new Error("stock e2e needs a database (DATABASE_URL / E2E_DATABASE_URL)");
  return out as T;
}

// -- registry: everything a test creates is retired afterwards ----------------

const created = {
  products: new Set<string>(),
  locations: new Set<string>(),
  users: new Set<string>(),
};

/** Archive what the tests created so the shared database stays tidy. */
export async function retireCreated() {
  await query(async (db) => {
    if (created.products.size)
      await db.query(`UPDATE "Product" SET "isActive" = false WHERE id = ANY($1::uuid[])`, [
        [...created.products],
      ]);
    if (created.locations.size)
      await db.query(`UPDATE "Location" SET "isActive" = false WHERE id = ANY($1::uuid[])`, [
        [...created.locations],
      ]);
    if (created.users.size)
      await db.query(`UPDATE "User" SET "isActive" = false WHERE id = ANY($1::uuid[])`, [
        [...created.users],
      ]);
  });
  created.products.clear();
  created.locations.clear();
  created.users.clear();
}

// -- setup -------------------------------------------------------------------

export async function mainLocation(): Promise<{ id: string; name: string }> {
  return query(async (db) => {
    const { rows } = await db.query(
      `SELECT id, name FROM "Location" WHERE code = 'UB1' AND "isActive"`,
    );
    return rows[0];
  });
}

export async function userId(email: string): Promise<string> {
  return query(async (db) => {
    const { rows } = await db.query(`SELECT id FROM "User" WHERE email = $1`, [email]);
    return rows[0].id;
  });
}

export async function createLocation(suffix: string): Promise<{ id: string; name: string }> {
  const id = randomUUID();
  // "Я" sorts after the seeded "Төв салбар", so the default location never changes.
  const name = `Я салбар ${suffix}`;
  await query((db) =>
    db.query(`INSERT INTO "Location" (id, code, name, "updatedAt") VALUES ($1, $2, $3, now())`, [
      id,
      `E2${suffix}`.toUpperCase().slice(0, 12),
      name,
    ]),
  );
  created.locations.add(id);
  return { id, name };
}

export interface StaffOptions {
  role: "MANAGER" | "CASHIER";
  locationIds: string[];
}

/** A staff member who signs in with the demo password (the seeded manager's hash). */
export async function createStaff(options: StaffOptions & { suffix: string }) {
  const id = randomUUID();
  const email = `e2e-${options.role.toLowerCase()}-${options.suffix}@pos.local`;
  const name = `E2E ${options.role} ${options.suffix}`;
  await query(async (db) => {
    await db.query(
      `INSERT INTO "User" (id, name, email, "passwordHash", role, "updatedAt")
       SELECT $1, $2, $3, "passwordHash", $4::"Role", now() FROM "User" WHERE email = $5`,
      [id, name, email, options.role, SEED.manager.email],
    );
    for (const locationId of options.locationIds) {
      await db.query(`INSERT INTO "UserLocation" ("userId", "locationId") VALUES ($1, $2)`, [
        id,
        locationId,
      ]);
    }
  });
  created.users.add(id);
  return { id, email, name };
}

export interface ProductOptions {
  name: string;
  sku?: string;
  unit?: Unit;
  price?: number;
  cost?: number;
  trackStock?: boolean;
  isActive?: boolean;
  /** Stock at `locationId`; written as an OPENING movement so the ledger is whole. */
  locationId?: string;
  onHandMilli?: number;
  reorderPointMilli?: number | null;
  /** Fixed variant id (sorts first among low-stock items when it starts with zeros). */
  variantId?: string;
}

export interface TestProduct {
  productId: string;
  variantId: string;
  name: string;
  sku: string | null;
}

export async function createProduct(options: ProductOptions): Promise<TestProduct> {
  const productId = randomUUID();
  const variantId = options.variantId ?? randomUUID();
  const sku = options.sku ?? null;
  await query(async (db) => {
    const { rows } = await db.query(
      `SELECT id FROM "TaxClass" WHERE "isActive" ORDER BY "createdAt" LIMIT 1`,
    );
    await db.query(
      `INSERT INTO "Product" (id, name, unit, "taxClassId", "trackStock", "isActive", "updatedAt")
       VALUES ($1, $2, $3::"UnitOfMeasure", $4, $5, $6, now())`,
      [
        productId,
        options.name,
        options.unit ?? "PIECE",
        rows[0].id,
        options.trackStock ?? true,
        options.isActive ?? true,
      ],
    );
    await db.query(
      `INSERT INTO "ProductVariant" (id, "productId", sku, price, cost, "updatedAt")
       VALUES ($1, $2, $3, $4, $5, now())`,
      [variantId, productId, sku, options.price ?? 1000, options.cost ?? 500],
    );
  });
  created.products.add(productId);
  if (options.locationId) {
    await setStock(variantId, options.locationId, options.onHandMilli ?? 0, {
      reorderPointMilli: options.reorderPointMilli ?? null,
    });
  }
  return { productId, variantId, name: options.name, sku };
}

/** Put a variant at a balance via one OPENING movement (balance is always opening-consistent). */
export async function setStock(
  variantId: string,
  locationId: string,
  onHandMilli: number,
  { reorderPointMilli = null }: { reorderPointMilli?: number | null } = {},
) {
  await query(async (db) => {
    const owner = await db.query(`SELECT id FROM "User" WHERE email = $1`, [SEED.owner.email]);
    await db.query(
      `INSERT INTO "StockLevel" ("variantId", "locationId", "onHandMilli", "reorderPointMilli", "updatedAt")
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT ("variantId", "locationId")
       DO UPDATE SET "onHandMilli" = EXCLUDED."onHandMilli", "reorderPointMilli" = EXCLUDED."reorderPointMilli"`,
      [variantId, locationId, onHandMilli, reorderPointMilli],
    );
    if (onHandMilli !== 0) {
      await db.query(
        `INSERT INTO "StockMovement" (id, "variantId", "locationId", type, "qtyDeltaMilli", "balanceAfterMilli", "unitCost", "createdById", note)
         VALUES ($1, $2, $3, 'OPENING', $4, $4, 500, $5, 'opening')`,
        [randomUUID(), variantId, locationId, onHandMilli, owner.rows[0].id],
      );
    }
  });
}

/** Append `count` plain movements (+1 / −1 alternating) to build a long ledger. */
export async function appendMovements(
  variantId: string,
  locationId: string,
  count: number,
  startBalanceMilli: number,
) {
  await query(async (db) => {
    const owner = await db.query(`SELECT id FROM "User" WHERE email = $1`, [SEED.owner.email]);
    let balance = startBalanceMilli;
    for (let i = 1; i <= count; i++) {
      const delta = i % 2 === 0 ? -1000 : 2000;
      balance += delta;
      await db.query(
        `INSERT INTO "StockMovement" (id, "variantId", "locationId", type, "qtyDeltaMilli", "balanceAfterMilli", "unitCost", "createdById", note)
         VALUES ($1, $2, $3, 'ADJUSTMENT', $4, $5, 500, $6, $7)`,
        [randomUUID(), variantId, locationId, delta, balance, owner.rows[0].id, `bulk ${i}`],
      );
    }
    await db.query(
      `UPDATE "StockLevel" SET "onHandMilli" = $3 WHERE "variantId" = $1 AND "locationId" = $2`,
      [variantId, locationId, balance],
    );
  });
}

/** A goods receipt + a stocktake that moved stock, so the ledger has linkable references. */
export async function addReferencedMovements(
  variantId: string,
  locationId: string,
  suffix: string,
  startBalanceMilli: number,
) {
  return query(async (db) => {
    const owner = (await db.query(`SELECT id FROM "User" WHERE email = $1`, [SEED.owner.email]))
      .rows[0].id;
    const receiptId = randomUUID();
    const stocktakeId = randomUUID();
    const receiptNumber = `GR-E2E-${suffix}`;
    const stocktakeNumber = `ST-E2E-${suffix}`;
    await db.query(
      `INSERT INTO "GoodsReceipt" (id, number, "locationId", "receivedById") VALUES ($1, $2, $3, $4)`,
      [receiptId, receiptNumber, locationId, owner],
    );
    await db.query(
      `INSERT INTO "Stocktake" (id, number, "locationId", status, "startedById", "completedById", "completedAt")
       VALUES ($1, $2, $3, 'COMPLETED', $4, $4, now())`,
      [stocktakeId, stocktakeNumber, locationId, owner],
    );
    const receiptBalance = startBalanceMilli + 4000;
    const stocktakeBalance = receiptBalance - 1000;
    await db.query(
      `INSERT INTO "StockMovement" (id, "variantId", "locationId", type, "qtyDeltaMilli", "balanceAfterMilli", "unitCost", "goodsReceiptId", "createdById")
       VALUES ($1, $2, $3, 'PURCHASE_RECEIPT', 4000, $4, 500, $5, $6)`,
      [randomUUID(), variantId, locationId, receiptBalance, receiptId, owner],
    );
    await db.query(
      `INSERT INTO "StockMovement" (id, "variantId", "locationId", type, "qtyDeltaMilli", "balanceAfterMilli", "unitCost", "stocktakeId", "createdById")
       VALUES ($1, $2, $3, 'STOCKTAKE', -1000, $4, 500, $5, $6)`,
      [randomUUID(), variantId, locationId, stocktakeBalance, stocktakeId, owner],
    );
    await db.query(
      `UPDATE "StockLevel" SET "onHandMilli" = $3 WHERE "variantId" = $1 AND "locationId" = $2`,
      [variantId, locationId, stocktakeBalance],
    );
    return {
      receiptId,
      receiptNumber,
      stocktakeId,
      stocktakeNumber,
      balanceMilli: stocktakeBalance,
    };
  });
}

// -- reading back (independent of the UI) ----------------------------------------

export interface LedgerEntry {
  type: string;
  delta: number;
  balance: number;
  adjustmentId: string | null;
  note: string | null;
}

export async function ledger(variantId: string, locationId: string): Promise<LedgerEntry[]> {
  return query(async (db) => {
    const { rows } = await db.query(
      `SELECT type, "qtyDeltaMilli" AS delta, "balanceAfterMilli" AS balance,
              "adjustmentId", note
       FROM "StockMovement" WHERE "variantId" = $1 AND "locationId" = $2 ORDER BY seq`,
      [variantId, locationId],
    );
    return rows;
  });
}

export async function onHand(variantId: string, locationId: string): Promise<number> {
  return query(async (db) => {
    const { rows } = await db.query(
      `SELECT "onHandMilli" FROM "StockLevel" WHERE "variantId" = $1 AND "locationId" = $2`,
      [variantId, locationId],
    );
    return rows[0]?.onHandMilli ?? 0;
  });
}

export async function adjustmentCount(locationId: string): Promise<number> {
  return query(async (db) => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM "StockAdjustment" WHERE "locationId" = $1`,
      [locationId],
    );
    return rows[0].n;
  });
}

/** The cache must always equal the ledger: Σ deltas = last balance = StockLevel. */
export async function expectLedgerConsistent(variantId: string, locationId: string) {
  const entries = await ledger(variantId, locationId);
  let running = 0;
  for (const entry of entries) {
    running += entry.delta;
    expect(entry.balance, "balanceAfter follows the running sum").toBe(running);
  }
  expect(await onHand(variantId, locationId)).toBe(running);
}

// -- formatting and message helpers (mn strings, never literals) -----------------

const MN_NUMBER = new Intl.NumberFormat("mn", { maximumFractionDigits: 3 });
export const num = (milli: number) => MN_NUMBER.format(milli / 1000);
export const signed = (milli: number) => `${milli > 0 ? "+" : ""}${num(milli)}`;
export const unitLabel = (unit: Unit) => mn.units[unit];
export const qtyText = (milli: number, unit: Unit = "PIECE") => `${num(milli)} ${unitLabel(unit)}`;

/** Fill `{name}` placeholders of a message. */
export function msg(template: string, values: Record<string, string | number>) {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => String(values[key]));
}

/** The `other {…}` branch of a simple ICU plural, with `#` replaced. */
export function plural(template: string, count: number) {
  const exact = new RegExp(`=${count} \\{([^}]*)\\}`).exec(template);
  const other = /other \{([^}]*)\}/.exec(template);
  return (exact?.[1] ?? other![1]!).replace("#", String(count));
}

export const shortId = (id: string) => id.slice(-8).toUpperCase();

// -- browser helpers ---------------------------------------------------------------

/** Collects console errors, page errors and failed/4xx-5xx requests. */
export function watchHealth(page: Page) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    // Next aborts superseded RSC prefetches; that is not a failure.
    if (r.failure()?.errorText === "net::ERR_ABORTED") return;
    problems.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) problems.push(`http ${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  return {
    problems,
    expectClean: () => expect(problems, "no console errors or failed requests").toEqual([]),
  };
}

/** No horizontal page overflow at the current viewport. */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "page must not scroll sideways").toBeLessThanOrEqual(client);
}

export const PHONE = { width: 390, height: 844 };

/** Search the stock page for a token and wait for the filtered table. */
export async function searchStock(page: Page, q: string, { low = false } = {}) {
  const search = page.getByLabel(mn.inventory.search);
  await search.fill(q);
  const lowBox = page.getByLabel(mn.inventory.lowOnly);
  if (low) await lowBox.check();
  else await lowBox.uncheck();
  await page.getByRole("button", { name: mn.inventory.apply }).click();
  await expect(page).toHaveURL(/q=/);
}

/** Add a product to the adjustment form through the picker. */
export async function pickProduct(page: Page, product: TestProduct) {
  const picker = page.getByRole("combobox", { name: mn.adjustments.form.find });
  await picker.fill(product.sku ?? product.name);
  await page.getByRole("option", { name: product.name }).first().click();
  await expect(page.getByText(product.name, { exact: true }).first()).toBeVisible();
}

export const qtyInput = (page: Page, unit: Unit = "PIECE") =>
  page.getByLabel(`${mn.adjustments.form.qtyDelta} (${unitLabel(unit)})`, { exact: true });
export const setInput = (page: Page, unit: Unit = "PIECE") =>
  page.getByLabel(`${mn.adjustments.form.qtySet} (${unitLabel(unit)})`, { exact: true });

export async function chooseReason(page: Page, reason: keyof typeof mn.adjustments.reasons) {
  await page.getByLabel(mn.adjustments.reason, { exact: true }).selectOption({
    label: mn.adjustments.reasons[reason],
  });
}

export async function submitAdjustment(page: Page) {
  await page.getByRole("button", { name: mn.adjustments.form.submit }).click();
}

/** Fill and submit a one-line adjustment; resolves with the new adjustment's id. */
export async function adjust(
  page: Page,
  product: TestProduct,
  options: {
    reason: keyof typeof mn.adjustments.reasons;
    qty: string;
    note?: string;
    mode?: "delta" | "set";
    unit?: Unit;
  },
): Promise<string> {
  await page.goto("/inventory/adjustments/new");
  await chooseReason(page, options.reason);
  if (options.note !== undefined) await page.getByLabel(mn.adjustments.note).fill(options.note);
  await pickProduct(page, product);
  if (options.mode === "set") {
    await page
      .getByLabel(mn.adjustments.form.mode, { exact: true })
      .selectOption({ label: mn.adjustments.form.modeSet });
    await setInput(page, options.unit).fill(options.qty);
  } else {
    await qtyInput(page, options.unit).fill(options.qty);
  }
  await submitAdjustment(page);
  await page.waitForURL(/\/inventory\/adjustments\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname.split("/").pop()!;
}
