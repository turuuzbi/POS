import { randomBytes, randomInt } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { withE2eDb } from "../db";
import { enterPin, mn, SEED, signInWithPassword, signOut } from "../fixtures";

/** Short random token so every run creates its own, uniquely named data. */
export const token = () => randomBytes(4).toString("hex");

/** EAN-13 check digit of the first 12 digits. */
export function ean13CheckDigit(first12: string): number {
  const sum = [...first12].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return (10 - (sum % 10)) % 10;
}

/** A fresh, valid EAN-13 in the 865 (Mongolia) range: "865" + 9 random digits + check digit. */
export function freshEan13(): string {
  const body = "865" + String(randomInt(0, 1_000_000_000)).padStart(9, "0");
  return body + ean13CheckDigit(body);
}

/** An EAN-13 whose check digit is wrong. */
export function badEan13(): string {
  const good = freshEan13();
  return good.slice(0, 12) + String((Number(good[12]) + 1) % 10);
}

/** A unique SKU like "T-3fa9c2-1". */
export const sku = (tok: string, n: number | string = 1) => `T-${tok}-${n}`;

/** A random PLU (5,000,000+) that is unlikely to collide with other runs or specs. */
export const freshPlu = () => String(randomInt(5_000_000, 9_999_999));

// ── tiny valid images ────────────────────────────────────────────────────

export const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const JPEG_1X1 = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);

/** A JPEG padded with trailing bytes up to `bytes` (decoders ignore data after the end marker). */
export function paddedJpeg(bytes: number): Buffer {
  return Buffer.concat([JPEG_1X1, Buffer.alloc(Math.max(0, bytes - JPEG_1X1.length))]);
}

export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
);

// ── page health ──────────────────────────────────────────────────────────

/**
 * Collects console errors, uncaught page errors, failed requests and HTTP
 * errors for the lifetime of a page. Aborted requests (a navigation
 * cancelling a prefetch) are not failures.
 */
export function watchPage(page: Page) {
  const problems: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      problems.push(`console.error: ${msg.text()} (${msg.location().url})`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText ?? "";
    if (/ERR_ABORTED|aborted/i.test(reason)) return;
    problems.push(`requestfailed: ${request.method()} ${request.url()} ${reason}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      problems.push(`http ${response.status()}: ${response.request().method()} ${response.url()}`);
    }
  });
  return {
    problems,
    expectClean: () => expect(problems, problems.join("\n")).toEqual([]),
  };
}

/** No horizontal page scroll. */
export async function expectNoHorizontalOverflow(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, `page scrolls horizontally (${scroll} > ${client})`).toBeLessThanOrEqual(client);
}

// ── sessions ─────────────────────────────────────────────────────────────

export const signInAsOwner = (page: Page) => signInWithPassword(page, SEED.owner.email);

/** Pair this browser as a till (as the manager), then sign in as the seeded cashier by PIN. */
export async function signInAsCashier(page: Page) {
  await signInWithPassword(page, SEED.manager.email);
  await page.goto("/settings/devices");
  await page.getByLabel(mn.devices.name).fill(`E2E products ${token()}`);
  await page.getByRole("button", { name: mn.devices.pair }).click();
  await expect(page.getByText(mn.devices.paired)).toBeVisible();
  await signOut(page, SEED.manager.name, mn.auth.signOut);
  await enterPin(page, SEED.cashier.pin);
  await expect(page).toHaveURL(/\/register$/);
}

// ── database helpers (setup and read-back only) ──────────────────────────

export interface DbVariant {
  id: string;
  sku: string | null;
  pluCode: string | null;
  option1: string | null;
  option2: string | null;
  option3: string | null;
  price: string;
  cost: string;
  isActive: boolean;
  barcodes: string[];
}
export interface DbProduct {
  id: string;
  name: string;
  unit: string;
  type: string;
  isActive: boolean;
  trackStock: boolean;
  imageUrl: string | null;
  categoryName: string | null;
  options: { name: string; values: string[] }[];
  variants: DbVariant[];
}

export async function dbProducts(nameLike: string): Promise<DbProduct[]> {
  const out: DbProduct[] = [];
  await withE2eDb(async (db) => {
    const products = await db.query(
      `SELECT p.id, p.name, p.unit, p.type, p."isActive", p."trackStock", p."imageUrl", c.name AS "categoryName"
         FROM "Product" p LEFT JOIN "Category" c ON c.id = p."categoryId"
        WHERE p.name LIKE $1 ORDER BY p.name`,
      [nameLike],
    );
    for (const p of products.rows) {
      const options = await db.query(
        `SELECT name, "values" FROM "ProductOption" WHERE "productId" = $1 ORDER BY position`,
        [p.id],
      );
      const variants = await db.query(
        `SELECT id, sku, "pluCode", option1, option2, option3, price::text, cost::text, "isActive"
           FROM "ProductVariant" WHERE "productId" = $1 ORDER BY position`,
        [p.id],
      );
      const withCodes: DbVariant[] = [];
      for (const v of variants.rows) {
        const codes = await db.query(
          `SELECT code FROM "Barcode" WHERE "variantId" = $1 ORDER BY code`,
          [v.id],
        );
        withCodes.push({ ...v, barcodes: codes.rows.map((r) => r.code) });
      }
      out.push({ ...p, options: options.rows, variants: withCodes });
    }
  });
  return out;
}

export async function dbProduct(name: string): Promise<DbProduct | undefined> {
  return (await dbProducts(name))[0];
}

export async function dbAudit(entityId: string, action: string) {
  const rows: { before: unknown; after: unknown }[] = [];
  await withE2eDb(async (db) => {
    const result = await db.query(
      `SELECT "before", "after" FROM "AuditLog" WHERE "entityId" = $1 AND action = $2 ORDER BY "createdAt"`,
      [entityId, action],
    );
    rows.push(...result.rows);
  });
  return rows;
}

/** Insert `count` plain products "<prefix> 00".. with one variant each (list / pagination fixtures). */
export async function insertProducts(prefix: string, count: number) {
  await withE2eDb(async (db) => {
    const tax = await db.query(`SELECT id FROM "TaxClass" WHERE "isActive" ORDER BY id LIMIT 1`);
    for (let i = 0; i < count; i++) {
      const product = await db.query(
        `INSERT INTO "Product" (id, name, "taxClassId", "updatedAt")
         VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
        [`${prefix} ${String(i).padStart(2, "0")}`, tax.rows[0].id],
      );
      await db.query(
        `INSERT INTO "ProductVariant" (id, "productId", price, "updatedAt")
         VALUES (gen_random_uuid(), $1, 100000, now())`,
        [product.rows[0].id],
      );
    }
  });
}

/** Give a variant stock history (an ADJUSTMENT movement), so its product can no longer be deleted. */
export async function addStockHistory(variantId: string) {
  await withE2eDb(async (db) => {
    const location = await db.query(
      `SELECT id FROM "Location" WHERE "isActive" ORDER BY id LIMIT 1`,
    );
    const owner = await db.query(`SELECT id FROM "User" WHERE email = $1`, [SEED.owner.email]);
    await db.query(
      `INSERT INTO "StockMovement" (id, "variantId", "locationId", type, "qtyDeltaMilli", "balanceAfterMilli", note, "createdById")
       VALUES (gen_random_uuid(), $1, $2, 'ADJUSTMENT', 1000, 1000, 'e2e history', $3)`,
      [variantId, location.rows[0].id, owner.rows[0].id],
    );
    await db.query(
      `INSERT INTO "StockLevel" ("variantId", "locationId", "onHandMilli", "updatedAt")
       VALUES ($1, $2, 1000, now()) ON CONFLICT ("variantId", "locationId") DO UPDATE SET "onHandMilli" = 1000`,
      [variantId, location.rows[0].id],
    );
  });
}

export async function insertCategory(name: string, parentId: string | null = null) {
  let id = "";
  await withE2eDb(async (db) => {
    const result = await db.query(
      `INSERT INTO "Category" (id, name, "parentId", "updatedAt")
       VALUES (gen_random_uuid(), $1, $2, now()) RETURNING id`,
      [name, parentId],
    );
    id = result.rows[0].id;
  });
  return id;
}

export async function setProductActiveDb(name: string, isActive: boolean) {
  await withE2eDb((db) =>
    db.query(`UPDATE "Product" SET "isActive" = $2 WHERE name = $1`, [name, isActive]),
  );
}

export async function dbCategory(name: string) {
  let row: { id: string; parentId: string | null; isActive: boolean } | undefined;
  await withE2eDb(async (db) => {
    const result = await db.query(
      `SELECT id, "parentId", "isActive" FROM "Category" WHERE name = $1`,
      [name],
    );
    row = result.rows[0];
  });
  return row;
}
