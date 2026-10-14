import { randomBytes } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import { addQuickKeys, scaleLabel } from "./helpers/register";
import { mn } from "./fixtures";
import {
  addByCode,
  approveWithManagerPin,
  cartLines,
  chargeButton,
  completeSale,
  currentSaleId,
  endRegister,
  expectConsistent,
  lineDiscountPercent,
  minor,
  mnt,
  msg,
  openShiftWithFloat,
  payableTotal,
  payCash,
  product,
  receiptNumberOnScreen,
  retireCreated,
  saleFacts,
  sql,
  startNewSale,
  startRegister,
  tenderDialog,
  type RegisterSession,
} from "./helpers/checkout";

/**
 * Regressions found by the Phase 2 review of the register client: scale-label
 * quantity edits, quick keys after a sale, QPay money that must survive the
 * tender dialog, the unconfirmed-charge lock, zero-value sales, resumed-cart
 * prices, price validation and the quantity-prefix search. Real checkout
 * service, real database.
 */

const uniq = () => randomBytes(3).toString("hex");

let session: RegisterSession | undefined;
test.afterEach(async () => {
  await endRegister(session);
  session = undefined;
});
test.afterAll(async () => {
  await retireCreated();
});

async function registerWithShift(page: Page) {
  session = await startRegister(page, { shift: false });
  await openShiftWithFloat(page, 50_000);
  return session;
}

const qtyButton = (page: Page, name: string) =>
  page.getByRole("button", { name: new RegExp(`${name}: тоо хэмжээ`) });

test("editing the quantity of a scale-label line sells exactly the edited quantity", async ({
  page,
}) => {
  const suffix = uniq();
  const reg = await registerWithShift(page);
  const beef = await product(reg.locationId, { label: "Kg", price: 10_000, unit: "KG", suffix });
  const plu = `9${Math.floor(Math.random() * 9000 + 1000)}`;
  await sql(`UPDATE "ProductVariant" SET "pluCode" = $1 WHERE id = $2`, [plu, beef.variantId]);

  await addByCode(page, scaleLabel(plu, 1250)); // 1.250 kg
  await expect(cartLines(page)).toHaveCount(1);
  await expect(payableTotal(page)).toHaveText(mnt(minor(12_500)));
  const saleId = await currentSaleId(page);

  await qtyButton(page, beef.name).click();
  const qty = page.getByRole("dialog", { name: beef.name });
  await qty.getByLabel(msg(mn.pos.qty.labelWeighed, { unit: mn.units.KG })).fill("3");
  await qty.getByRole("button", { name: mn.pos.qty.apply }).click();
  await expect(payableTotal(page)).toHaveText(mnt(minor(30_000)));

  await chargeButton(page).click();
  await payCash(page, 30_000);
  await completeSale(page);
  await receiptNumberOnScreen(page);

  const facts = (await saleFacts(saleId))!;
  expectConsistent(facts);
  expect(facts.lines).toHaveLength(1);
  expect(facts.lines[0]).toMatchObject({ qtyMilli: 3000, totalAmount: minor(30_000).toString() });
});

test("quick-key tiles stay after a sale, a hold and a resume", async ({ page }) => {
  const suffix = uniq();
  const reg = await registerWithShift(page);
  const item = await product(reg.locationId, { label: "Tile", price: 1_500, suffix });
  const cleanup = await addQuickKeys([{ name: item.name }]);
  try {
    await page.reload();
    const tile = () => page.getByRole("tabpanel").getByRole("button", { name: /E2E Tile/ });
    await expect(tile().first()).toBeVisible();

    await tile().first().click();
    await expect(cartLines(page)).toHaveCount(1);
    await chargeButton(page).click();
    await payCash(page, 1_500);
    await completeSale(page);
    await receiptNumberOnScreen(page);
    await startNewSale(page);
    await expect(tile().first()).toBeVisible(); // after the first sale

    await tile().first().click();
    await page.getByRole("button", { name: mn.pos.cart.hold, exact: true }).click();
    await expect(cartLines(page)).toHaveCount(0);
    await expect(tile().first()).toBeVisible(); // after hold

    await page.getByRole("button", { name: msg(mn.pos.cart.held, { count: 1 }) }).click();
    await page
      .getByRole("dialog", { name: mn.pos.held.title })
      .getByRole("button", { name: mn.pos.held.resume })
      .click();
    await expect(cartLines(page)).toHaveCount(1);
    await expect(tile().first()).toBeVisible(); // after resume
  } finally {
    await cleanup();
  }
});

test("QPay money survives Back and a reload and the sale completes with the paid intent", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const suffix = uniq();
  const reg = await registerWithShift(page);
  const item = await product(reg.locationId, { label: "Item", price: 9_000, suffix });
  await addByCode(page, item.sku!);
  const saleId = await currentSaleId(page);

  await chargeButton(page).click();
  const dialog = tenderDialog(page);
  await dialog.getByRole("radio", { name: mn.pos.tender.method.QPAY }).click();
  await dialog.getByRole("button", { name: /QR/ }).click();
  await expect(dialog.getByTestId("qpay-waiting")).toBeVisible();
  // While the invoice is open the customer may be paying: no way out of it.
  await expect(dialog.getByRole("button", { name: mn.pos.tender.back })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: mn.pos.tender.method.CASH })).toBeDisabled();

  // The mock provider pays by itself; the poll sees it.
  await expect(dialog.getByRole("button", { name: mn.pos.tender.complete })).toBeVisible({
    timeout: 30_000,
  });
  await dialog.getByRole("button", { name: mn.pos.tender.back }).click();
  await expect(dialog).toHaveCount(0);

  // The paid intent is kept: the cart is locked and payment can be continued, also after a reload.
  await expect(page.getByText(mn.pos.pending.paymentBanner)).toBeVisible();
  await qtyButton(page, item.name).click();
  await expect(page.getByText(mn.pos.pending.locked)).toBeVisible();
  await page.reload();
  await expect(page.getByText(mn.pos.pending.paymentBanner)).toBeVisible();
  await page.getByRole("button", { name: mn.pos.pending.paymentResume }).click();
  await expect(dialog.getByTestId("tender-remaining")).toHaveText(mnt(0));
  await completeSale(page);
  await receiptNumberOnScreen(page);

  const facts = (await saleFacts(saleId))!;
  expectConsistent(facts);
  expect(facts.payments).toHaveLength(1);
  expect(facts.payments[0]).toMatchObject({ method: "QPAY", amount: minor(9_000).toString() });
  const [intent] = await sql<{ status: string; saleId: string }>(
    `SELECT status::text, "saleId" FROM "PaymentIntent" WHERE id = $1`,
    [facts.payments[0]!.paymentIntentId],
  );
  expect(intent).toEqual({ status: "PAID", saleId });
  // and there is exactly one intent: nobody was asked to pay twice
  const [count] = await sql<{ n: string }>(
    `SELECT count(*) AS n FROM "PaymentIntent" WHERE "saleId" = $1`,
    [saleId],
  );
  expect(Number(count!.n)).toBe(1);
});

test("an unconfirmed charge locks hold and resume, then retries itself into one sale", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const suffix = uniq();
  const reg = await registerWithShift(page);
  const item = await product(reg.locationId, { label: "Item", price: 4_100, suffix });
  await addByCode(page, item.sku!);
  const saleId = await currentSaleId(page);

  // No answer ever reaches the register (the request never leaves it).
  const blocked = (route: Route) => {
    const request = route.request();
    return request.method() === "POST" && request.headers()["next-action"]
      ? route.abort("connectionreset")
      : route.continue();
  };
  await page.route("**/register", blocked);
  await chargeButton(page).click();
  await payCash(page, 5_000);
  await completeSale(page);
  const dialog = tenderDialog(page);
  await expect(dialog.getByText(mn.pos.tender.unknownTitle)).toBeVisible({ timeout: 30_000 });
  await dialog.getByRole("button", { name: mn.pos.tender.back }).click();
  await expect(page.getByText(mn.pos.pending.banner)).toBeVisible();

  // Held (F4) and Hold must not park the cart and drop the pending charge.
  await page.keyboard.press("F4");
  await expect(page.getByText(mn.pos.pending.locked)).toBeVisible();
  await expect(page.getByRole("dialog", { name: mn.pos.held.title })).toHaveCount(0);
  await page.getByRole("button", { name: mn.pos.cart.hold, exact: true }).click();
  await expect(cartLines(page)).toHaveCount(1);
  expect(await currentSaleId(page)).toBe(saleId);

  // The answer path comes back: the same sale id is asked again by itself.
  await page.unroute("**/register", blocked);
  await page.getByRole("button", { name: mn.pos.pending.retry }).click();
  await receiptNumberOnScreen(page);
  const [sales] = await sql<{ n: string }>(`SELECT count(*) AS n FROM "Sale" WHERE id = $1`, [
    saleId,
  ]);
  expect(Number(sales!.n)).toBe(1);
  expectConsistent((await saleFacts(saleId))!);
});

test("a sale with nothing to pay (100% discount) can be completed without tenders", async ({
  page,
}) => {
  const suffix = uniq();
  const reg = await registerWithShift(page);
  const item = await product(reg.locationId, { label: "Free", price: 2_000, suffix });
  await addByCode(page, item.sku!);
  const saleId = await currentSaleId(page);
  await lineDiscountPercent(page, item.name, 100);
  await approveWithManagerPin(page);
  await expect(payableTotal(page)).toHaveText(mnt(0));

  await chargeButton(page).click();
  await expect(
    tenderDialog(page).getByRole("button", { name: mn.pos.tender.complete }),
  ).toBeVisible();
  await completeSale(page);
  await receiptNumberOnScreen(page);
  const facts = (await saleFacts(saleId))!;
  expect(facts.sale.totalAmount).toBe("0");
  expect(facts.payments).toHaveLength(0);
});

test("resuming a held cart takes the current prices of that cart", async ({ page }) => {
  const suffix = uniq();
  const reg = await registerWithShift(page);
  const item = await product(reg.locationId, { label: "Moved", price: 5_000, suffix });
  await addByCode(page, item.sku!);
  await page.getByRole("button", { name: mn.pos.cart.hold, exact: true }).click();
  await expect(cartLines(page)).toHaveCount(0);

  await sql(`UPDATE "ProductVariant" SET price = $1 WHERE id = $2`, [
    minor(6_000).toString(),
    item.variantId,
  ]);
  await page.getByRole("button", { name: msg(mn.pos.cart.held, { count: 1 }) }).click();
  await page
    .getByRole("dialog", { name: mn.pos.held.title })
    .getByRole("button", { name: mn.pos.held.resume })
    .click();
  await expect(payableTotal(page)).toHaveText(mnt(minor(6_000)));
  await expect(page.getByText(mn.pos.held.pricesChanged)).toBeVisible();
});

test("a price above the limit is refused in the dialog; a SKU that looks like a quantity prefix is found as itself", async ({
  page,
}) => {
  const suffix = uniq();
  const reg = await registerWithShift(page);
  const board = await product(reg.locationId, { label: "Board", price: 7_000, suffix });
  const sku = `2X4-BOARD-${suffix}`.toUpperCase();
  await sql(`UPDATE "ProductVariant" SET sku = $1 WHERE id = $2`, [sku, board.variantId]);

  await addByCode(page, sku);
  await expect(cartLines(page)).toHaveCount(1);
  await expect(payableTotal(page)).toHaveText(mnt(minor(7_000))); // one board, not two of "4-BOARD"

  await page
    .getByRole("button", { name: msg(mn.pos.cart.lineActions, { name: board.name }) })
    .click();
  await page.getByRole("menuitem", { name: mn.pos.cart.changePrice }).click();
  const dialog = page.getByRole("dialog", { name: board.name });
  await dialog.getByLabel(mn.pos.price.label).fill("999999999999");
  await expect(dialog.getByRole("alert")).toHaveText(mn.pos.price.invalid);
  await expect(dialog.getByRole("button", { name: mn.pos.price.apply })).toBeDisabled();
});
