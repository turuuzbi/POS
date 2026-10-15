import {
  expect,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import { mn, SEED, signInWithPassword } from "../fixtures";
import {
  addByName,
  addWeighed,
  approveWithManagerPin,
  chargeButton,
  completeSale,
  currentSaleId,
  MANAGER_PIN,
  msg,
  openShiftWithFloat,
  payCard,
  payCash,
  receiptNumberOnScreen,
  sql,
  startNewSale,
  startRegister,
  tenderDialog,
  type RegisterSession,
} from "./checkout";

/**
 * Helpers for the Phase 3 specs: every sale is rung up through the real
 * register (so shifts, stock and payments are written by the services under
 * test), every return goes through the Returns screen; the database is only
 * read back for assertions.
 */

export interface Till {
  session: RegisterSession;
  shiftId: string;
}

/** A paired tablet, the seed cashier signed in, a real shift opened with a counted float. */
export async function bootTill(page: Page, floatMajor = 50_000): Promise<Till> {
  const session = await startRegister(page, { shift: false });
  await openShiftWithFloat(page, floatMajor);
  return { session, shiftId: await currentShiftId(session.registerId) };
}

export async function currentShiftId(registerId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `SELECT id FROM "Shift" WHERE "registerId" = $1 AND status = 'OPEN'`,
    [registerId],
  );
  if (!row) throw new Error("no open shift");
  return row.id;
}

export interface CartItem {
  name: string;
  /** Pieces (default 1). */
  qty?: number;
  /** Weighed items: kilograms typed in the weight dialog. */
  kg?: string;
}

export async function fillCart(page: Page, items: CartItem[]) {
  for (const item of items) {
    if (item.kg) {
      await addWeighed(page, item.name, item.kg);
    } else {
      await addByName(page, item.name);
      for (let i = 1; i < (item.qty ?? 1); i++) {
        await page
          .getByRole("button", { name: msg(mn.pos.cart.increase, { name: item.name }) })
          .click();
      }
    }
  }
}

export type Pay = { cash: number } | { card: number } | { qpay: true };

/** QPay takes the rest of the balance: show the QR and wait for the (mock) provider to mark it paid. */
export async function payQpay(page: Page) {
  const dialog = tenderDialog(page);
  await dialog.getByRole("radio", { name: mn.pos.tender.method.QPAY }).click();
  await dialog.getByRole("button", { name: /QR/ }).click();
  await expect(dialog.getByRole("button", { name: mn.pos.tender.complete })).toBeVisible({
    timeout: 30_000,
  });
}

/** Ring up the items and pay (whole tögrög). Returns the committed sale. */
export async function ring(
  page: Page,
  items: CartItem[],
  pay: Pay[],
): Promise<{ saleId: string; number: string }> {
  await fillCart(page, items);
  const saleId = await currentSaleId(page);
  await chargeButton(page).click();
  await expect(tenderDialog(page)).toBeVisible();
  for (const tender of pay) {
    if ("card" in tender) await payCard(page, tender.card);
    else if ("qpay" in tender) await payQpay(page);
    else await payCash(page, tender.cash);
  }
  await completeSale(page);
  const number = await receiptNumberOnScreen(page);
  await startNewSale(page);
  return { saleId, number };
}

// -- returns screen ---------------------------------------------------------------------

export async function openReturns(page: Page) {
  await page.getByTestId("open-returns").click();
  await expect(page.getByRole("dialog", { name: mn.refunds.title })).toBeVisible();
}

export async function findSale(page: Page, number: string) {
  // The screen may still be open on its search step (after "back").
  if (!(await page.getByRole("dialog", { name: mn.refunds.title }).isVisible())) {
    await openReturns(page);
  }
  const input = page.getByTestId("receipt-input");
  await input.fill(number);
  await input.press("Enter");
  await expect(page.getByTestId("return-sale-number")).toHaveText(number);
}

export const returnAll = (page: Page, name: string) =>
  page.getByRole("button", { name: msg(mn.refunds.line.returnAll, { name }) }).click();

export async function returnPieces(page: Page, name: string, count: number) {
  for (let i = 0; i < count; i++) {
    await page.getByRole("button", { name: msg(mn.refunds.line.increase, { name }) }).click();
  }
}

export async function returnKg(page: Page, name: string, kg: string) {
  await page.getByRole("button", { name: msg(mn.refunds.line.editQty, { name }) }).click();
  const qty = page.getByRole("dialog", { name });
  await qty.getByLabel(msg(mn.refunds.qty.label, { unit: mn.units.KG })).fill(kg);
  await qty.getByRole("button", { name: mn.refunds.qty.apply }).click();
  await expect(qty).toHaveCount(0);
}

export async function chooseReason(page: Page, reason = "DEFECTIVE") {
  await page.getByLabel(mn.refunds.panel.reason).selectOption(reason);
}

/** Submit the return form; a cashier is asked for (and given) a manager's PIN. */
export async function submitReturn(page: Page, { approve = true } = {}) {
  await page.getByTestId("refund-submit").click();
  if (approve) await approveWithManagerPin(page);
}

export async function expectRefundDone(page: Page) {
  const done = page.getByTestId("refund-done");
  await expect(done).toBeVisible({ timeout: 20_000 });
  return done;
}

/** Dismiss the done screen. */
export async function closeDone(page: Page) {
  await page.getByRole("button", { name: mn.refunds.done.done }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

// -- database facts ---------------------------------------------------------------------

export interface RefundRow {
  id: string;
  number: string;
  saleId: string;
  shiftId: string;
  registerId: string;
  total: bigint;
  net: bigint;
  vat: bigint;
  rounding: bigint;
  tip: bigint;
  exchangeSaleId: string | null;
  approvedById: string | null;
  processedById: string;
}

export async function refundsOf(saleId: string): Promise<RefundRow[]> {
  const rows = await sql<Record<string, string | null>>(
    `SELECT id, number, "saleId", "shiftId", "registerId", "totalAmount"::text AS total,
            "netAmount"::text AS net, "vatAmount"::text AS vat, "roundingAmount"::text AS rounding,
            "tipAmount"::text AS tip, "exchangeSaleId", "approvedById", "processedById"
       FROM "Refund" WHERE "saleId" = $1 ORDER BY "createdAt", id`,
    [saleId],
  );
  return rows.map((r) => ({
    id: r.id!,
    number: r.number!,
    saleId: r.saleId!,
    shiftId: r.shiftId!,
    registerId: r.registerId!,
    total: BigInt(r.total!),
    net: BigInt(r.net!),
    vat: BigInt(r.vat!),
    rounding: BigInt(r.rounding!),
    tip: BigInt(r.tip!),
    exchangeSaleId: r.exchangeSaleId ?? null,
    approvedById: r.approvedById ?? null,
    processedById: r.processedById!,
  }));
}

export async function refundPayments(refundId: string) {
  const rows = await sql<{ method: string; amount: string; originalPaymentId: string | null }>(
    `SELECT method::text, amount::text, "originalPaymentId" FROM "RefundPayment"
      WHERE "refundId" = $1 ORDER BY method::text, id`,
    [refundId],
  );
  return rows.map((r) => ({ ...r, amount: BigInt(r.amount) }));
}

export async function salePayments(saleId: string) {
  const rows = await sql<{ id: string; method: string; amount: string }>(
    `SELECT id, method::text, amount::text FROM "SalePayment" WHERE "saleId" = $1 ORDER BY method::text, id`,
    [saleId],
  );
  return rows.map((r) => ({ ...r, amount: BigInt(r.amount) }));
}

export async function saleTotal(saleId: string): Promise<bigint> {
  const [row] = await sql<{ t: string }>(
    `SELECT "totalAmount"::text AS t FROM "Sale" WHERE id = $1`,
    [saleId],
  );
  return BigInt(row!.t);
}

export async function movementsOf(variantId: string, locationId: string) {
  return sql<{
    type: string;
    qtyDeltaMilli: number;
    refundId: string | null;
    saleId: string | null;
  }>(
    `SELECT type::text, "qtyDeltaMilli", "refundId", "saleId" FROM "StockMovement"
      WHERE "variantId" = $1 AND "locationId" = $2 ORDER BY seq`,
    [variantId, locationId],
  );
}

/**
 * Σ per sale line of the refund lines equals the sale line (net, vat, total),
 * and the refunds sum to the sale total: the exactness check after a sale is
 * returned completely in several steps.
 */
export async function expectFullyRefundedExactly(saleId: string) {
  const lines = await sql<{
    id: string;
    total: string;
    net: string;
    vat: string;
    refunded: string;
    rnet: string;
    rvat: string;
  }>(
    `SELECT l.id, l."totalAmount"::text AS total, l."netAmount"::text AS net, l."vatAmount"::text AS vat,
            COALESCE(sum(rl."totalAmount"), 0)::text AS refunded,
            COALESCE(sum(rl."netAmount"), 0)::text AS rnet,
            COALESCE(sum(rl."vatAmount"), 0)::text AS rvat
       FROM "SaleLine" l LEFT JOIN "RefundLine" rl ON rl."saleLineId" = l.id
      WHERE l."saleId" = $1 GROUP BY l.id`,
    [saleId],
  );
  for (const l of lines) {
    expect(l.refunded, `line ${l.id} total`).toBe(l.total);
    expect(l.rnet, `line ${l.id} net`).toBe(l.net);
    expect(l.rvat, `line ${l.id} vat`).toBe(l.vat);
  }
  const refunds = await refundsOf(saleId);
  expect(
    refunds.reduce((acc, r) => acc + r.total, 0n),
    "Σ refunds = sale total",
  ).toBe(await saleTotal(saleId));
  for (const r of refunds) {
    const pays = await refundPayments(r.id);
    expect(
      pays.reduce((acc, p) => acc + p.amount, 0n),
      `refund ${r.number} payments`,
    ).toBe(r.total);
  }
}

// -- back office ------------------------------------------------------------------------

/** A second browser context signed in as the owner (back office), closed by the caller. */
export async function adminPage(browser: Browser) {
  const context = await browser.newContext({ locale: "mn-MN", timezoneId: "Asia/Ulaanbaatar" });
  const page = await context.newPage();
  await signInWithPassword(page, SEED.owner.email);
  return { page, context };
}

/** An anonymous API client: no cookies, as the customer behind a share link. */
export async function anonymous(browser: Browser): Promise<{
  request: APIRequestContext;
  close: () => Promise<void>;
}> {
  const context = await browser.newContext();
  return { request: context.request, close: () => context.close() };
}

// -- exchange -----------------------------------------------------------------------------

/** Start an exchange from the Returns screen: the chosen pieces become the credit. */
export async function startExchange(
  page: Page,
  number: string,
  returned: { name: string; pieces: number },
  reason = "WRONG_ITEM",
) {
  await findSale(page, number);
  await page.getByTestId("mode-EXCHANGE").click();
  await returnPieces(page, returned.name, returned.pieces);
  await chooseReason(page, reason);
  await page.getByTestId("refund-submit").click();
  await expect(page.getByTestId("exchange-bar")).toBeVisible();
}

/** Finish dialog: continue, give the manager's PIN when asked. */
export async function continueExchange(page: Page) {
  await page.getByTestId("exchange-finish").click();
  await expect(page.getByTestId("exchange-finish-dialog")).toBeVisible();
  await page.getByTestId("exchange-continue").click();
  await approveWithManagerPin(page);
}

// -- shifts ---------------------------------------------------------------------------------

export async function openShiftMenu(page: Page, item: string) {
  const trigger = page.getByTestId("shift-menu");
  const entry = page.getByRole("menuitem", { name: item });
  // A dialog that just closed hands focus back to the trigger a tick later, which closes a
  // menu opened in between: open it again until the entry is there.
  await expect(async () => {
    if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
    await expect(entry).toBeVisible({ timeout: 1_000 });
  }).toPass();
  await entry.click();
}

/** Cash in / out at the till; a cashier is asked for a manager's PIN and gives it. */
export async function moveCash(
  page: Page,
  options: { type: "in" | "out"; amountMajor: number; reason: string },
) {
  await openShiftMenu(page, mn.shifts.menu.cash);
  const dialog = page.getByRole("dialog", { name: mn.shifts.cash.title });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: mn.shifts.cash[options.type] }).click();
  await dialog.getByLabel(mn.shifts.cash.amount).fill(String(options.amountMajor));
  await dialog.getByLabel(mn.shifts.cash.reason).fill(options.reason);
  await dialog.getByRole("button", { name: mn.shifts.cash.submit }).click();
  const approval = page.getByTestId("cash-approval");
  await expect(approval).toBeVisible();
  await approval.getByLabel(mn.shifts.cash.pin).fill(MANAGER_PIN);
  await approval.getByRole("button", { name: mn.shifts.cash.approve }).click();
  await expect(page.getByText(mn.shifts.cash.recorded)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/** Open the blind-close dialog and enter the counted notes and coins (denomination -> count). */
export async function countDrawer(page: Page, counts: Record<number, number>) {
  await openShiftMenu(page, mn.shifts.menu.close);
  const dialog = page.getByRole("dialog", { name: mn.shifts.close.title });
  await expect(dialog.getByTestId("close-count")).toBeVisible();
  for (const [denomination, count] of Object.entries(counts)) {
    await dialog
      .getByTestId(`denomination-${denomination}`)
      .getByRole("textbox")
      .fill(String(count));
  }
  return dialog;
}

export async function reviewAndConfirmClose(dialog: Locator) {
  await dialog.getByRole("button", { name: mn.shifts.close.review }).click();
  await dialog.getByRole("button", { name: mn.shifts.close.confirm }).click();
}

// -- phone width and console ---------------------------------------------------------------

/** Collects console errors and uncaught exceptions of a page. */
export function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/** The page and the open dialog (if any) do not scroll sideways. */
export async function expectNoOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dialog: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
    };
  });
  expect(overflow.page, `${label}: page overflows`).toBeLessThanOrEqual(0);
  expect(overflow.dialog, `${label}: dialog overflows`).toBeLessThanOrEqual(0);
}
