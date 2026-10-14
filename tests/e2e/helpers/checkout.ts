import { expect, type Locator, type Page } from "@playwright/test";
import { formatMoney } from "../../../src/domain/money";
import { withE2eDb } from "../db";
import { mn } from "../fixtures";
import { createProduct, retireCreated, type TestProduct } from "./stock";
import { cartLines } from "./register";

export { addByCode, cartLines, endRegister, msg, startRegister } from "./register";
export type { RegisterSession } from "./register";
export { retireCreated };

/** Manager PIN used to approve discounts at the register (prisma/seed.ts). */
export const MANAGER_PIN = "583920";

/** Money in möngö (bigint/number/string) as the UI prints it. */
export const mnt = (minor: bigint | number | string) =>
  formatMoney(BigInt(minor), { locale: "mn" });

/** Whole tögrög to möngö. */
export const minor = (major: number) => BigInt(major) * 100n;

// -- database -------------------------------------------------------------------

export async function sql<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  let rows: T[] | undefined;
  await withE2eDb(async (db) => {
    rows = (await db.query(text, params)).rows as T[];
  });
  if (!rows) throw new Error("checkout e2e needs a database (DATABASE_URL / E2E_DATABASE_URL)");
  return rows;
}

/** A tracked item with stock at `locationId`; `price` is whole tögrög. */
export async function product(
  locationId: string,
  options: {
    label: string;
    price: number;
    stock?: number;
    unit?: "PIECE" | "KG";
    suffix: string;
  },
): Promise<TestProduct & { price: bigint }> {
  const name = `E2E ${options.label} ${options.suffix}`;
  const created = await createProduct({
    name,
    sku: `CK-${options.suffix}-${options.label.slice(0, 3)}`.toUpperCase(),
    unit: options.unit ?? "PIECE",
    price: Number(minor(options.price)),
    cost: Number(minor(Math.floor(options.price / 2))),
    locationId,
    onHandMilli: Math.round((options.stock ?? 100) * 1000),
  });
  return { ...created, price: minor(options.price) };
}

export interface SaleFacts {
  sale: {
    id: string;
    number: string;
    shiftId: string;
    registerId: string;
    locationId: string;
    cashierId: string;
    netAmount: string;
    vatAmount: string;
    discountAmount: string;
    itemsAmount: string;
    roundingAmount: string;
    totalAmount: string;
    publicToken: string;
    requiresReview: boolean;
  };
  lines: {
    lineNo: number;
    variantId: string;
    name: string;
    qtyMilli: number;
    unitPrice: string;
    grossAmount: string;
    discountAmount: string;
    totalAmount: string;
    netAmount: string;
    vatAmount: string;
  }[];
  payments: {
    method: string;
    amount: string;
    tendered: string | null;
    change: string;
    paymentIntentId: string | null;
    reference: string | null;
  }[];
  discounts: {
    scope: string;
    amount: string;
    approvedById: string | null;
    percentBps: number | null;
  }[];
  movements: {
    variantId: string;
    type: string;
    qtyDeltaMilli: number;
    balanceAfterMilli: number;
  }[];
}

/** Everything the database holds about one sale, as strings (bigint-safe). */
export async function saleFacts(saleId: string): Promise<SaleFacts | null> {
  const [sale] = await sql<SaleFacts["sale"]>(
    `SELECT id, number, "shiftId", "registerId", "locationId", "cashierId", "netAmount"::text,
            "vatAmount"::text, "discountAmount"::text, "itemsAmount"::text, "roundingAmount"::text,
            "totalAmount"::text, "publicToken", "requiresReview"
       FROM "Sale" WHERE id = $1`,
    [saleId],
  );
  if (!sale) return null;
  const lines = await sql<SaleFacts["lines"][number]>(
    `SELECT "lineNo", "variantId", name, "qtyMilli", "unitPrice"::text, "grossAmount"::text,
            "discountAmount"::text, "totalAmount"::text, "netAmount"::text, "vatAmount"::text
       FROM "SaleLine" WHERE "saleId" = $1 ORDER BY "lineNo"`,
    [saleId],
  );
  const payments = await sql<SaleFacts["payments"][number]>(
    `SELECT method::text, amount::text, tendered::text, change::text, "paymentIntentId", reference
       FROM "SalePayment" WHERE "saleId" = $1 ORDER BY "createdAt", id`,
    [saleId],
  );
  const discounts = await sql<SaleFacts["discounts"][number]>(
    `SELECT scope::text, amount::text, "approvedById", "percentBps" FROM "SaleDiscount" WHERE "saleId" = $1`,
    [saleId],
  );
  const movements = await sql<SaleFacts["movements"][number]>(
    `SELECT "variantId", type::text, "qtyDeltaMilli", "balanceAfterMilli"
       FROM "StockMovement" WHERE "saleId" = $1 ORDER BY seq`,
    [saleId],
  );
  return { sale, lines, payments, discounts, movements };
}

/** The money and ledger invariants every committed sale must satisfy. */
export function expectConsistent(facts: SaleFacts) {
  const { sale, lines, payments } = facts;
  const sum = (values: string[]) => values.reduce((acc, v) => acc + BigInt(v), 0n);
  expect(sum(lines.map((l) => l.totalAmount)), "Σ line totals = itemsAmount").toBe(
    BigInt(sale.itemsAmount),
  );
  expect(BigInt(sale.itemsAmount) + BigInt(sale.roundingAmount), "items + rounding = total").toBe(
    BigInt(sale.totalAmount),
  );
  expect(sum(payments.map((p) => p.amount)), "Σ applied payments = total").toBe(
    BigInt(sale.totalAmount),
  );
  for (const line of lines) {
    expect(BigInt(line.netAmount) + BigInt(line.vatAmount), `line ${line.lineNo} net+vat`).toBe(
      BigInt(line.totalAmount),
    );
  }
  for (const payment of payments) {
    if (payment.method !== "CASH") expect(BigInt(payment.change)).toBe(0n);
    else if (payment.tendered !== null) {
      expect(BigInt(payment.tendered) - BigInt(payment.amount)).toBe(BigInt(payment.change));
    }
  }
  expect(facts.sale.requiresReview).toBe(false);
}

export async function stockOnHand(variantId: string, locationId: string): Promise<number> {
  const [row] = await sql<{ onHandMilli: number }>(
    `SELECT "onHandMilli" FROM "StockLevel" WHERE "variantId" = $1 AND "locationId" = $2`,
    [variantId, locationId],
  );
  return row?.onHandMilli ?? 0;
}

/** Σ of the append-only ledger for a variant at a location (must equal the cached level). */
export async function ledgerSum(variantId: string, locationId: string): Promise<number> {
  const [row] = await sql<{ total: string | null }>(
    `SELECT COALESCE(sum("qtyDeltaMilli"), 0)::text AS total FROM "StockMovement"
      WHERE "variantId" = $1 AND "locationId" = $2`,
    [variantId, locationId],
  );
  return Number(row?.total ?? 0);
}

export async function countSales(shiftOrRegisterId: { registerId: string }): Promise<number> {
  const [row] = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM "Sale" WHERE "registerId" = $1`,
    [shiftOrRegisterId.registerId],
  );
  return Number(row!.n);
}

/** Flip BusinessSettings.allowNegativeStock; returns a function that restores the old value. */
export async function setAllowNegativeStock(value: boolean): Promise<() => Promise<void>> {
  const [before] = await sql<{ allowNegativeStock: boolean }>(
    `SELECT "allowNegativeStock" FROM "BusinessSettings" WHERE id = 1`,
  );
  await sql(`UPDATE "BusinessSettings" SET "allowNegativeStock" = $1 WHERE id = 1`, [value]);
  const previous = before?.allowNegativeStock ?? true;
  return async () => {
    await sql(`UPDATE "BusinessSettings" SET "allowNegativeStock" = $1 WHERE id = 1`, [previous]);
  };
}

// -- register UI ----------------------------------------------------------------

export const payableTotal = (page: Page) => page.getByTestId("total-payable");

/** The sale id of the cart in progress (the register persists its draft once it has lines). */
export async function currentSaleId(page: Page): Promise<string> {
  let id: string | null = null;
  await expect
    .poll(async () => {
      id = await page.evaluate(() => {
        const key = Object.keys(localStorage).find((k) => k.startsWith("pos:draft:"));
        return key ? (JSON.parse(localStorage.getItem(key)!).saleId as string) : null;
      });
      return id;
    })
    .not.toBeNull();
  return id!;
}

/** Open the shift on the "open shift" screen with a counted float (whole tögrög). */
export async function openShiftWithFloat(page: Page, floatMajor: number) {
  const screen = page.getByTestId("open-shift");
  await expect(screen).toBeVisible();
  await screen.getByLabel(mn.pos.shift.openingFloat).fill(String(floatMajor));
  await screen.getByRole("button", { name: mn.pos.shift.open }).click();
  await expect(page.getByRole("combobox", { name: mn.pos.search.label })).toBeVisible();
}

export function chargeButton(page: Page): Locator {
  return page.getByRole("button", { name: new RegExp(`^${mn.pos.cart.charge}`) });
}

export function tenderDialog(page: Page): Locator {
  return page.getByRole("dialog", { name: mn.pos.tender.title });
}

/** Pick a product by typing its name and clicking the first matching option. */
export async function addByName(page: Page, name: string) {
  const search = page.getByRole("combobox", { name: mn.pos.search.label });
  await search.fill(name);
  await page
    .getByRole("option", { name: new RegExp(name) })
    .first()
    .click();
}

/** Weigh a KG product: pick it by name, type the weight in the quantity dialog. */
export async function addWeighed(page: Page, name: string, kg: string) {
  await addByName(page, name);
  const qty = page.getByRole("dialog", { name });
  await qty.getByLabel(mn.pos.qty.labelWeighed.replace("{unit}", mn.units.KG)).fill(kg);
  await qty.getByRole("button", { name: mn.pos.qty.apply }).click();
  await expect(qty).toHaveCount(0);
}

/** Give a manager's PIN in the approval dialog. */
export async function approveWithManagerPin(page: Page) {
  const approval = page.getByRole("dialog", { name: mn.pos.approval.title });
  await expect(approval).toBeVisible();
  await approval.getByLabel(mn.pos.approval.pinLabel).fill(MANAGER_PIN);
  await approval.getByRole("button", { name: mn.pos.approval.approve }).click();
}

export async function lineDiscountPercent(page: Page, lineName: string, percent: number) {
  await page
    .getByRole("button", { name: mn.pos.cart.lineActions.replace("{name}", lineName) })
    .click();
  await page.getByRole("menuitem", { name: mn.pos.cart.discount }).click();
  const dialog = page.getByRole("dialog", { name: lineName });
  await dialog.getByLabel(mn.pos.discount.percentLabel).fill(String(percent));
  await dialog.getByRole("button", { name: mn.pos.discount.apply }).click();
}

/** Tender: cash given (whole tögrög) against the remaining balance. */
export async function payCash(page: Page, givenMajor: number) {
  const dialog = tenderDialog(page);
  await dialog.getByRole("radio", { name: mn.pos.tender.method.CASH }).click();
  await dialog.getByLabel(mn.pos.tender.cashGiven).fill(String(givenMajor));
  await dialog
    .getByRole("button", {
      name: new RegExp(`^(${mn.pos.tender.addCash}|${mn.pos.tender.addPartial})$`),
    })
    .click();
}

export async function payCard(page: Page, amountMajor: number) {
  const dialog = tenderDialog(page);
  await dialog.getByRole("radio", { name: mn.pos.tender.method.CARD }).click();
  await dialog.getByLabel(mn.pos.tender.amount).fill(String(amountMajor));
  await dialog.getByRole("button", { name: mn.pos.tender.addPayment }).click();
}

export async function completeSale(page: Page) {
  await tenderDialog(page).getByRole("button", { name: mn.pos.tender.complete }).click();
}

export const successDialog = (page: Page) =>
  page.getByRole("dialog", { name: mn.pos.success.title });

/** Wait for the success screen and read the receipt number off it. */
export async function receiptNumberOnScreen(page: Page): Promise<string> {
  const dialog = successDialog(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const text = (await dialog.textContent()) ?? "";
  const match = /([A-Z0-9]+-\d{6})/.exec(text);
  if (!match) throw new Error(`no receipt number on the success screen: ${text}`);
  return match[1]!;
}

export async function startNewSale(page: Page) {
  await successDialog(page).getByRole("button", { name: mn.pos.success.newSale }).click();
  await expect(successDialog(page)).toHaveCount(0);
  await expect(cartLines(page)).toHaveCount(0);
}

/** Audit rows of one action for an entity. */
export async function auditCount(action: string, entityId: string): Promise<number> {
  const [row] = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM "AuditLog" WHERE action = $1 AND "entityId" = $2`,
    [action, entityId],
  );
  return Number(row!.n);
}

/** The fiscal (eBarimt) receipt is created after the sale committed; wait for it to settle. */
export async function expectFiscalIssued(saleId: string) {
  await expect
    .poll(
      async () =>
        (
          await sql<{ status: string }>(
            `SELECT status::text FROM "FiscalReceipt" WHERE "saleId" = $1`,
            [saleId],
          )
        )
          .map((r) => r.status)
          .join(","),
      { message: "one ISSUED fiscal receipt" },
    )
    .toBe("ISSUED");
}
