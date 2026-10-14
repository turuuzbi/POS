import { randomInt } from "node:crypto";
import { expect, type Locator, type Page } from "@playwright/test";
import { withE2eDb } from "../db";
import { mn } from "../fixtures";

export const t = mn.purchasing;

/** Short random suffix so every run creates its own, uniquely named data. */
export const token = () => Math.random().toString(36).slice(2, 8);

/** Digits-only code, unique enough for a shared database. */
export const barcode = () => `88${randomInt(10_000_000_000)}`.padEnd(12, "0");

export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  let rows: T[] = [];
  await withE2eDb(async (db) => {
    rows = (await db.query(sql, params)).rows as T[];
  });
  return rows;
}

export interface TestProduct {
  variantId: string;
  name: string;
  sku: string;
  barcode: string;
}

/**
 * A stock-tracked product with one variant and a barcode, created straight in
 * the database (the catalog UI is another flow's concern). It starts with no
 * stock and a zero cost, so the first receipt defines the average cost.
 */
export async function createProduct(label = "Бараа"): Promise<TestProduct> {
  const suffix = token();
  const name = `E2E ${label} ${suffix}`;
  const sku = `E2E-${suffix.toUpperCase()}`;
  const code = barcode();
  const rows = await query<{ id: string }>(
    `WITH p AS (
       INSERT INTO "Product" ("id", "name", "taxClassId", "updatedAt")
       SELECT gen_random_uuid(), $1, "id", now() FROM "TaxClass" ORDER BY "name" LIMIT 1
       RETURNING "id"
     ), v AS (
       INSERT INTO "ProductVariant" ("id", "productId", "sku", "price", "updatedAt")
       SELECT gen_random_uuid(), p."id", $2, 5000, now() FROM p
       RETURNING "id"
     ), b AS (
       INSERT INTO "Barcode" ("id", "code", "variantId")
       SELECT gen_random_uuid(), $3, v."id" FROM v
       RETURNING "id"
     )
     SELECT v."id" FROM v, b`,
    [name, sku, code],
  );
  return { variantId: rows[0]!.id, name, sku, barcode: code };
}

export interface StockState {
  onHandMilli: number;
  cost: bigint;
  movements: number;
}

/** Current on-hand quantity, moving-average cost and ledger length at the only location. */
export async function stockState(variantId: string): Promise<StockState> {
  const [level] = await query<{ onHandMilli: number }>(
    `SELECT "onHandMilli" FROM "StockLevel" WHERE "variantId" = $1`,
    [variantId],
  );
  const [variant] = await query<{ cost: string }>(
    `SELECT "cost" FROM "ProductVariant" WHERE "id" = $1`,
    [variantId],
  );
  const [count] = await query<{ n: string }>(
    `SELECT count(*) AS n FROM "StockMovement" WHERE "variantId" = $1`,
    [variantId],
  );
  return {
    onHandMilli: level?.onHandMilli ?? 0,
    cost: BigInt(variant!.cost),
    movements: Number(count!.n),
  };
}

export async function count(
  table: "PurchaseOrder" | "GoodsReceipt" | "Supplier",
  where: string,
  params: unknown[],
) {
  const [row] = await query<{ n: string }>(
    `SELECT count(*) AS n FROM "${table}" WHERE ${where}`,
    params,
  );
  return Number(row!.n);
}

/** Console errors, uncaught exceptions, failed requests and 4xx/5xx responses on this page. */
export function watchIssues(page: Page): string[] {
  const issues: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") issues.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => issues.push(`pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    // Next aborts superseded prefetches/navigations; that is not a failure.
    const reason = request.failure()?.errorText ?? "";
    if (!/ERR_ABORTED/.test(reason)) issues.push(`requestfailed: ${request.url()} ${reason}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) issues.push(`http ${response.status()}: ${response.url()}`);
  });
  return issues;
}

export async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth, `${page.url()} overflows horizontally`).toBeLessThanOrEqual(clientWidth);
}

export const main = (page: Page) => page.getByRole("main");

/** Click a confirm-dialog button (trigger, then the same-named action in the dialog). */
export async function confirmAction(page: Page, label: string, scope?: Locator) {
  await (scope ?? main(page)).getByRole("button", { name: label, exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toBeHidden();
}

export function toast(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
}

export async function createSupplier(page: Page, name: string, fields: { phone?: string } = {}) {
  await page.goto("/purchasing/suppliers");
  await main(page).getByRole("button", { name: t.suppliers.new }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(t.suppliers.name, { exact: true }).fill(name);
  if (fields.phone) await dialog.getByLabel(t.suppliers.phone, { exact: true }).fill(fields.phone);
  await dialog.getByRole("button", { name: mn.common.save }).click();
  await expect(dialog).toBeHidden();
  await expect(main(page).getByRole("link", { name })).toBeVisible();
}

/** Scan (type + Enter) a barcode into the product picker named `label`. */
export async function scan(page: Page, label: string, code: string) {
  const picker = main(page).getByRole("combobox", { name: label });
  await picker.fill(code);
  await picker.press("Enter");
}

export interface OrderLineSpec {
  product: TestProduct;
  qty: string;
  cost: string;
}

/** Create a draft purchase order through the form; resolves with its id and number. */
export async function createDraftOrder(
  page: Page,
  options: { supplier: string; lines: OrderLineSpec[]; note?: string },
): Promise<{ id: string; number: string }> {
  await page.goto("/purchasing/orders/new");
  await main(page)
    .getByLabel(mn.purchasing.orders.supplier)
    .selectOption({ label: options.supplier });
  for (const line of options.lines) {
    await scan(page, t.lines.addProduct, line.product.barcode);
    const row = main(page).getByRole("listitem").filter({ hasText: line.product.name });
    await expect(row).toBeVisible();
    await row.getByLabel(t.lines.qty).fill(line.qty);
    await row.getByLabel(t.lines.unitCost).fill(line.cost);
  }
  if (options.note) await main(page).getByLabel(t.orders.note, { exact: true }).fill(options.note);
  await main(page).getByRole("button", { name: t.orders.saveDraft }).click();
  await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
  const id = page.url().split("/").pop()!;
  const number = (await main(page).getByRole("heading", { level: 1 }).textContent())!.trim();
  return { id, number };
}

/** Regex for a ₮ amount that tolerates the locale's digit grouping, e.g. 1,300₮. */
export function money(amount: number): RegExp {
  const digits = String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, "[,\\s\\u00a0\\u202f.]?");
  return new RegExp(`(^|\\D)${digits}(\\.\\d+)?₮`);
}

/** The status badge showing exactly `text` (column headers share some of the words). */
export function badge(page: Page, text: string): Locator {
  return main(page)
    .locator('[data-slot="badge"]')
    .filter({ hasText: new RegExp(`^${text}$`) });
}
