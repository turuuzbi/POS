import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { computeTotals, type Cart, type CatalogVariant } from "../../src/domain/cart";
import { fromMajor } from "../../src/domain/money";
import { enterPin, mn, SEED, signOut } from "./fixtures";
import {
  addByCode,
  addWeighed,
  approveWithManagerPin,
  cartLines,
  chargeButton,
  completeSale,
  countSales,
  currentSaleId,
  endRegister,
  expectConsistent,
  ledgerSum,
  auditCount,
  expectFiscalIssued,
  lineDiscountPercent,
  minor,
  mnt,
  msg,
  openShiftWithFloat,
  payableTotal,
  payCard,
  payCash,
  product,
  receiptNumberOnScreen,
  retireCreated,
  saleFacts,
  setAllowNegativeStock,
  sql,
  startNewSale,
  startRegister,
  stockOnHand,
  successDialog,
  tenderDialog,
  type RegisterSession,
} from "./helpers/checkout";

/**
 * Phase 2 checkout, end to end in a real browser against a production build:
 * PIN sign-in, shift, cart, approvals, every tender, receipts, and the
 * failure paths (lost response, stock, stale prices, shift closed under the
 * cashier). Each test pairs its own tablet and creates its own products, so
 * runs never depend on each other or on the seed's stock.
 *
 * Expected money comes from the pure domain (the code the page itself runs),
 * stock/ledger/payment facts are read back from the database.
 */

const uniq = () => randomBytes(3).toString("hex");

/** The test products are plain tax-inclusive 10% VAT items (the first active tax class). */
const variant = (
  id: string,
  priceMajor: number,
  unit: "PIECE" | "KG" = "PIECE",
): CatalogVariant => ({
  variantId: id,
  unit,
  price: fromMajor(priceMajor),
  pricesIncludeTax: true,
  taxTreatment: "STANDARD",
  vatRateBps: 1000,
  cityTaxRateBps: 0,
});

function expectedTotals(cart: Cart, variants: CatalogVariant[]) {
  return computeTotals(
    cart,
    { variants: Object.fromEntries(variants.map((v) => [v.variantId, v])) },
    { totalRoundingUnit: 100n },
  );
}

async function saleSequence(locationCode = "UB1"): Promise<number> {
  const [row] = await sql<{ value: number }>(`SELECT value FROM "Sequence" WHERE key = $1`, [
    `sale:${locationCode}`,
  ]);
  return row?.value ?? 0;
}

const numberPart = (receiptNumber: string) => Number(receiptNumber.split("-")[1]);

let session: RegisterSession | undefined;
const restorers: (() => Promise<void>)[] = [];

test.afterEach(async () => {
  await endRegister(session);
  session = undefined;
  for (const restore of restorers.splice(0)) await restore();
});
test.afterAll(async () => {
  await retireCreated();
});

/** Pair a tablet, sign in as the cashier and (unless told otherwise) open the shift in the UI. */
async function registerWithShift(page: Page, float = 50_000) {
  session = await startRegister(page, { shift: false });
  await openShiftWithFloat(page, float);
  return session;
}

test.describe("a complete cash sale", () => {
  test("PIN sign-in, shift with float, items, approved discount, change, receipt and share link", async ({
    page,
    context,
    browser,
    baseURL,
  }) => {
    const suffix = uniq();
    const reg = await startRegister(page, { shift: false });
    const wine = await product(reg.locationId, { label: "Item", price: 3_800, suffix });
    const beef = await product(reg.locationId, {
      label: "Kg",
      price: 12_000,
      unit: "KG",
      stock: 20,
      suffix,
    });

    // Open the shift in the UI with a counted float.
    await openShiftWithFloat(page, 50_000);
    const [shift] = await sql<{ status: string; openingFloat: string; openedById: string }>(
      `SELECT status::text, "openingFloat"::text, "openedById" FROM "Shift"
        WHERE "registerId" = $1 AND status = 'OPEN'`,
      [reg.registerId],
    );
    expect(shift).toMatchObject({ status: "OPEN", openingFloat: "5000000" });
    expect(shift!.openedById).toBe(reg.cashierId);

    // Scan one, bump it to two, weigh 1.250 kg of the other.
    await addByCode(page, wine.sku!);
    await expect(cartLines(page)).toHaveCount(1);
    await page
      .getByRole("button", { name: msg(mn.pos.cart.increase, { name: wine.name }) })
      .click();
    await addWeighed(page, beef.name, "1.25");
    await expect(cartLines(page)).toHaveCount(2);

    // A 15% discount is above the 10% policy: the manager's PIN approves it.
    await lineDiscountPercent(page, wine.name, 15);
    await approveWithManagerPin(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const totals = expectedTotals(
      {
        lines: [
          {
            lineId: "a",
            variantId: wine.variantId,
            qtyMilli: 2000,
            unitPrice: fromMajor(3_800),
            discounts: [{ kind: "PERCENT", percentBps: 1500 }],
          },
          {
            lineId: "b",
            variantId: beef.variantId,
            qtyMilli: 1250,
            unitPrice: fromMajor(12_000),
            discounts: [],
          },
        ],
        discounts: [],
      },
      [variant(wine.variantId, 3_800), variant(beef.variantId, 12_000, "KG")],
    );
    await expect(payableTotal(page)).toHaveText(mnt(totals.payable));

    // Cash: 50 000₮ handed over for a smaller bill; the change is shown first.
    const saleId = await currentSaleId(page);
    await chargeButton(page).click();
    await expect(tenderDialog(page).getByTestId("tender-payable")).toHaveText(mnt(totals.payable));
    const given = minor(50_000);
    await payCash(page, 50_000);
    await expect(tenderDialog(page).getByTestId("change-due")).toHaveText(
      mnt(given - totals.payable),
    );
    const seqBefore = await saleSequence();
    await completeSale(page);

    // Success screen: total, change and the receipt number.
    const number = await receiptNumberOnScreen(page);
    expect(number).toMatch(/^UB1-\d{6}$/);
    await expect(page.getByTestId("success-total")).toHaveText(mnt(totals.payable));
    await expect(page.getByTestId("success-change")).toHaveText(mnt(given - totals.payable));

    // Database: one sale, its lines, payment, discount and stock movements agree.
    const facts = (await saleFacts(saleId))!;
    expect(facts.sale).toMatchObject({
      number,
      registerId: reg.registerId,
      locationId: reg.locationId,
      cashierId: reg.cashierId,
      shiftId: expect.any(String),
      totalAmount: totals.payable.toString(),
    });
    expect(facts.sale.shiftId).toBe(
      (
        await sql<{ id: string }>(
          `SELECT id FROM "Shift" WHERE "registerId" = $1 AND status = 'OPEN'`,
          [reg.registerId],
        )
      )[0]!.id,
    );
    expect(numberPart(number)).toBe(seqBefore + 1);
    expect(await saleSequence()).toBe(numberPart(number));
    expectConsistent(facts);
    expect(facts.lines.map((l) => [l.variantId, l.qtyMilli])).toEqual([
      [wine.variantId, 2000],
      [beef.variantId, 1250],
    ]);
    expect(facts.payments).toEqual([
      expect.objectContaining({
        method: "CASH",
        amount: totals.payable.toString(),
        tendered: given.toString(),
        change: (given - totals.payable).toString(),
      }),
    ]);
    const [manager] = await sql<{ id: string }>(
      `SELECT id FROM "User" WHERE email = 'manager@pos.local'`,
    );
    expect(facts.discounts).toEqual([
      expect.objectContaining({ scope: "LINE", percentBps: 1500, approvedById: manager!.id }),
    ]);
    expect(facts.movements).toEqual([
      expect.objectContaining({ variantId: wine.variantId, type: "SALE", qtyDeltaMilli: -2000 }),
      expect.objectContaining({ variantId: beef.variantId, type: "SALE", qtyDeltaMilli: -1250 }),
    ]);
    expect(await stockOnHand(wine.variantId, reg.locationId)).toBe(100_000 - 2000);
    expect(await stockOnHand(beef.variantId, reg.locationId)).toBe(20_000 - 1250);
    for (const v of [wine, beef]) {
      expect(await ledgerSum(v.variantId, reg.locationId)).toBe(
        await stockOnHand(v.variantId, reg.locationId),
      );
    }

    // After-commit work: the audit trail and the fiscal receipt, once each.
    expect(await auditCount("sale.checkout", saleId)).toBe(1);
    await expectFiscalIssued(saleId);

    // Receipt page (opens in a new tab from the success screen).
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const [receiptTab] = await Promise.all([
      page.waitForEvent("popup"),
      successDialog(page).getByRole("link", { name: mn.pos.success.receipt }).click(),
    ]);
    await expect(receiptTab).toHaveURL(new RegExp(`/receipt/${saleId}$`));
    await expect(receiptTab.getByRole("heading", { level: 1 })).toContainText(number);
    const slip = receiptTab.locator("article.receipt-sheet");
    await expect(slip).toContainText(wine.name);
    await expect(slip).toContainText(beef.name);
    await expect(slip).toContainText(mnt(totals.payable));
    await expect(slip).toContainText(mnt(given - totals.payable));

    // Print view: only the slip remains.
    await receiptTab.emulateMedia({ media: "print" });
    await expect(receiptTab.getByRole("toolbar")).toBeHidden();
    await expect(slip).toBeVisible();
    await receiptTab.emulateMedia({ media: "screen" });

    // PDF download from the toolbar.
    const [download] = await Promise.all([
      receiptTab.waitForEvent("download"),
      receiptTab.getByRole("link", { name: mn.receipt.actions.downloadPdf }).click(),
    ]);
    const pdfPath = await download.path();
    expect(pdfPath).toBeTruthy();
    const { readFile } = await import("node:fs/promises");
    expect((await readFile(pdfPath)).subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // Share link: the copied URL opens WITHOUT a session and leaks nothing internal.
    await receiptTab.getByRole("button", { name: mn.receipt.actions.shareLink }).click();
    const shared = await receiptTab.evaluate(() => navigator.clipboard.readText());
    expect(shared).toBe(new URL(`/r/${facts.sale.publicToken}`, receiptTab.url()).toString());
    const anonymous = await browser.newContext({ baseURL, locale: "mn-MN" });
    try {
      const anonPage = await anonymous.newPage();
      const response = await anonPage.goto(shared);
      expect(response?.status()).toBe(200);
      await expect(anonPage).not.toHaveURL(/\/login/);
      await expect(anonPage.locator("article.receipt-sheet")).toContainText(number);
      const html = await anonPage.content();
      for (const secret of [
        facts.sale.id,
        facts.sale.shiftId,
        facts.sale.registerId,
        facts.sale.cashierId,
        facts.sale.locationId,
        wine.variantId,
        wine.productId,
        reg.deviceName,
      ]) {
        expect(html, `public receipt must not contain ${secret}`).not.toContain(secret);
      }
      const pdf = await anonymous.request.get(`/api/receipts/${facts.sale.publicToken}/pdf`);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()["content-type"]).toBe("application/pdf");
      expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    } finally {
      await anonymous.close();
    }
    await receiptTab.close();

    // Ready for the next customer.
    await startNewSale(page);
  });

  test("the receipt can be sent by e-mail and SMS from the success screen", async ({ page }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    const item = await product(reg.locationId, { label: "Item", price: 2_500, suffix });
    await addByCode(page, item.sku!);
    const saleId = await currentSaleId(page);
    await chargeButton(page).click();
    await payCash(page, 2_500);
    await completeSale(page);
    await receiptNumberOnScreen(page);

    const dialog = successDialog(page);
    const toastFor = (text: string) =>
      page.locator("[data-sonner-toast]").filter({ hasText: text });
    const sendEmail = dialog.getByRole("button", {
      name: `${mn.pos.success.send}: ${mn.pos.success.email}`,
    });
    const sendSms = dialog.getByRole("button", {
      name: `${mn.pos.success.send}: ${mn.pos.success.phone}`,
    });
    await expect(sendEmail).toBeDisabled();

    // A malformed address is refused by the server and nothing is recorded.
    await dialog.getByRole("textbox", { name: mn.pos.success.email }).fill("not-an-email");
    await sendEmail.click();
    await expect(dialog.getByRole("alert")).toHaveText(mn.errors.VALIDATION);
    expect(await sql(`SELECT 1 FROM "ReceiptDelivery" WHERE "saleId" = $1`, [saleId])).toHaveLength(
      0,
    );

    const email = `e2e-${suffix}@example.com`;
    await dialog.getByRole("textbox", { name: mn.pos.success.email }).fill(email);
    await sendEmail.click();
    await expect(toastFor(msg(mn.pos.success.sentTo, { destination: email }))).toBeVisible();

    const phone = "99112233";
    await dialog.getByRole("textbox", { name: mn.pos.success.phone }).fill(phone);
    await sendSms.click();
    await expect(toastFor(msg(mn.pos.success.sentTo, { destination: phone }))).toBeVisible();

    const deliveries = await sql<{ channel: string; destination: string; status: string }>(
      `SELECT channel::text, destination, status::text FROM "ReceiptDelivery"
        WHERE "saleId" = $1 ORDER BY "createdAt"`,
      [saleId],
    );
    expect(deliveries).toEqual([
      { channel: "EMAIL", destination: email, status: "SENT" },
      { channel: "SMS", destination: phone, status: "SENT" },
    ]);
  });
});

test.describe("other tenders", () => {
  test("split tender: card plus cash with change; receipt numbers are gap-free", async ({
    page,
  }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    const item = await product(reg.locationId, { label: "Item", price: 7_300, suffix });
    await addByCode(page, item.sku!);
    const saleId = await currentSaleId(page);
    const seqBefore = await saleSequence();

    await chargeButton(page).click();
    await payCard(page, 5_000);
    await expect(tenderDialog(page).getByTestId("tender-remaining")).toHaveText(mnt(minor(2_300)));
    await payCash(page, 5_000); // 2 300₮ due, 5 000₮ handed over: 2 700₮ change
    await expect(tenderDialog(page).getByTestId("change-due")).toHaveText(mnt(minor(2_700)));
    await completeSale(page);
    const number = await receiptNumberOnScreen(page);
    await expect(page.getByTestId("success-change")).toHaveText(mnt(minor(2_700)));

    const facts = (await saleFacts(saleId))!;
    expectConsistent(facts);
    expect(numberPart(number)).toBe(seqBefore + 1);
    expect(facts.payments.map((p) => [p.method, p.amount, p.change])).toEqual([
      ["CARD", minor(5_000).toString(), "0"],
      ["CASH", minor(2_300).toString(), minor(2_700).toString()],
    ]);
  });

  test("QPay: the invoice QR is shown, becomes PAID and the sale completes", async ({ page }) => {
    test.setTimeout(90_000);
    const suffix = uniq();
    const reg = await registerWithShift(page);
    const item = await product(reg.locationId, { label: "Item", price: 9_000, suffix });
    await addByCode(page, item.sku!);
    const saleId = await currentSaleId(page);

    await chargeButton(page).click();
    const dialog = tenderDialog(page);
    await payCash(page, 1_000); // partial cash first, QPay takes the rest
    await expect(dialog.getByTestId("tender-remaining")).toHaveText(mnt(minor(8_000)));
    await dialog.getByRole("radio", { name: mn.pos.tender.method.QPAY }).click();
    await dialog.getByRole("button", { name: /QR/ }).click();
    await expect(dialog.getByTestId("qpay-waiting")).toBeVisible();
    await expect(dialog.getByRole("img", { name: mn.pos.qpay.qrAlt })).toBeVisible();

    // The server marks the (mock) invoice paid after MOCK_QPAY_AUTOPAY_SECONDS and the poll sees it.
    await expect(dialog.getByRole("button", { name: mn.pos.tender.complete })).toBeVisible({
      timeout: 30_000,
    });
    await expect(dialog.getByTestId("tender-remaining")).toHaveText(mnt(0));
    await completeSale(page);
    await receiptNumberOnScreen(page);

    const facts = (await saleFacts(saleId))!;
    expectConsistent(facts);
    const qpay = facts.payments.find((p) => p.method === "QPAY");
    expect(qpay).toMatchObject({ amount: minor(8_000).toString() });
    expect(qpay!.paymentIntentId).toBeTruthy();
    const [intent] = await sql<{
      status: string;
      provider: string;
      amount: string;
      saleId: string;
    }>(`SELECT status::text, provider, amount::text, "saleId" FROM "PaymentIntent" WHERE id = $1`, [
      qpay!.paymentIntentId,
    ]);
    expect(intent).toEqual({
      status: "PAID",
      provider: "mock",
      amount: minor(8_000).toString(),
      saleId,
    });
  });
});

test.describe("carts and failures", () => {
  test("a held cart survives a reload, resumes and sells under its own sale id", async ({
    page,
  }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    const a = await product(reg.locationId, { label: "A", price: 1_500, suffix });
    const b = await product(reg.locationId, { label: "B", price: 2_200, suffix });
    await addByCode(page, a.sku!);
    await addByCode(page, b.sku!);
    const heldSaleId = await currentSaleId(page);

    await page.getByRole("button", { name: mn.pos.cart.hold, exact: true }).click();
    await expect(cartLines(page)).toHaveCount(0);
    await addByCode(page, a.sku!); // a different cart gets a different sale id
    const otherSaleId = await currentSaleId(page);
    expect(otherSaleId).not.toBe(heldSaleId);
    await page.getByRole("button", { name: mn.pos.cart.hold, exact: true }).click();

    await page.reload();
    await page.getByRole("button", { name: msg(mn.pos.cart.held, { count: 2 }) }).click();
    const held = page.getByRole("dialog", { name: mn.pos.held.title });
    const items = held.getByTestId("held-list").getByRole("listitem");
    await expect(items).toHaveCount(2);
    await items
      .filter({ hasText: mnt(minor(3_700)) })
      .getByRole("button", { name: mn.pos.held.resume })
      .click();
    await expect(cartLines(page)).toHaveCount(2);
    await expect(payableTotal(page)).toHaveText(mnt(minor(3_700)));
    expect(await currentSaleId(page)).toBe(heldSaleId);

    await chargeButton(page).click();
    await payCash(page, 3_700);
    await completeSale(page);
    await receiptNumberOnScreen(page);

    expect(await saleFacts(otherSaleId)).toBeNull();
    const facts = (await saleFacts(heldSaleId))!;
    expectConsistent(facts);
    expect(facts.sale.totalAmount).toBe(minor(3_700).toString());
    expect(facts.lines).toHaveLength(2);
  });

  test("a response lost after the server committed is retried into exactly one sale", async ({
    page,
  }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    const item = await product(reg.locationId, { label: "Item", price: 4_100, suffix });
    await addByCode(page, item.sku!);
    const saleId = await currentSaleId(page);
    const salesBefore = await countSales(reg);

    // Let the first charge reach the server and commit, then drop the answer on the floor.
    let charges = 0;
    await page.route("**/register", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"] && charges++ === 0) {
        await route.fetch();
        await route.abort("connectionreset");
        return;
      }
      await route.continue();
    });

    await chargeButton(page).click();
    await payCash(page, 5_000);
    await completeSale(page);
    // The register retries the SAME sale id on its own and lands on the success screen.
    await receiptNumberOnScreen(page);
    expect(charges).toBeGreaterThanOrEqual(2);

    expect(await countSales(reg)).toBe(salesBefore + 1);
    const facts = (await saleFacts(saleId))!;
    expectConsistent(facts);
    expect(facts.payments).toHaveLength(1);
    expect(facts.movements).toHaveLength(1);
    expect(await auditCount("sale.checkout", saleId)).toBe(1);
    await expectFiscalIssued(saleId);
    expect(await stockOnHand(item.variantId, reg.locationId)).toBe(100_000 - 1000);
    expect(await ledgerSum(item.variantId, reg.locationId)).toBe(100_000 - 1000);
    await expect(page.getByTestId("success-change")).toHaveText(mnt(minor(900)));
  });

  test("insufficient stock blocks the sale when negative stock is not allowed", async ({
    page,
  }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    restorers.push(await setAllowNegativeStock(false));
    const scarce = await product(reg.locationId, {
      label: "Scarce",
      price: 1_000,
      stock: 2,
      suffix,
    });
    await addByCode(page, scarce.sku!);
    await page
      .getByRole("button", { name: msg(mn.pos.cart.increase, { name: scarce.name }) })
      .click();
    await page
      .getByRole("button", { name: msg(mn.pos.cart.increase, { name: scarce.name }) })
      .click();
    const saleId = await currentSaleId(page);
    const salesBefore = await countSales(reg);

    await chargeButton(page).click();
    await payCash(page, 3_000);
    await completeSale(page);
    await expect(tenderDialog(page).getByRole("alert")).toHaveText(
      mn.checkout.errors.INSUFFICIENT_STOCK,
    );
    expect(await countSales(reg)).toBe(salesBefore);
    expect(await saleFacts(saleId)).toBeNull();
    expect(await stockOnHand(scarce.variantId, reg.locationId)).toBe(2_000);

    // Back to what is on the shelf: the same cart then sells.
    await tenderDialog(page).getByRole("button", { name: mn.pos.tender.back }).click();
    await page
      .getByRole("button", { name: msg(mn.pos.cart.decrease, { name: scarce.name }) })
      .click();
    await chargeButton(page).click();
    await payCash(page, 2_000);
    await completeSale(page);
    await receiptNumberOnScreen(page);
    expect(await stockOnHand(scarce.variantId, reg.locationId)).toBe(0);
    expectConsistent((await saleFacts(saleId))!);
  });

  test("with negative stock allowed the sale goes through and the ledger records the shortfall", async ({
    page,
  }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    restorers.push(await setAllowNegativeStock(true));
    const scarce = await product(reg.locationId, {
      label: "Scarce",
      price: 1_000,
      stock: 1,
      suffix,
    });
    await addByCode(page, scarce.sku!);
    await page
      .getByRole("button", { name: msg(mn.pos.cart.increase, { name: scarce.name }) })
      .click();
    const saleId = await currentSaleId(page);
    await chargeButton(page).click();
    await payCash(page, 2_000);
    await completeSale(page);
    await receiptNumberOnScreen(page);

    const facts = (await saleFacts(saleId))!;
    expectConsistent(facts);
    expect(facts.movements).toEqual([
      expect.objectContaining({ qtyDeltaMilli: -2000, balanceAfterMilli: -1000 }),
    ]);
    expect(await stockOnHand(scarce.variantId, reg.locationId)).toBe(-1000);
    expect(await ledgerSum(scarce.variantId, reg.locationId)).toBe(-1000);
  });

  test("a price changed in the back office is refreshed instead of being charged stale", async ({
    page,
  }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    const item = await product(reg.locationId, { label: "Item", price: 5_000, suffix });
    await addByCode(page, item.sku!);
    await expect(payableTotal(page)).toHaveText(mnt(minor(5_000)));
    const saleId = await currentSaleId(page);

    await sql(`UPDATE "ProductVariant" SET price = $2 WHERE id = $1`, [
      item.variantId,
      minor(5_500).toString(),
    ]);
    await chargeButton(page).click();
    await payCash(page, 5_000);
    await completeSale(page);

    // Nothing was sold; the cart now shows the new price and says so.
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: mn.pos.pending.pricesUpdated }),
    ).toBeVisible();
    await expect(payableTotal(page)).toHaveText(mnt(minor(5_500)));
    expect(await saleFacts(saleId)).toBeNull();

    await chargeButton(page).click();
    await payCash(page, 6_000);
    await completeSale(page);
    await receiptNumberOnScreen(page);
    const facts = (await saleFacts(saleId))!;
    expectConsistent(facts);
    expect(facts.sale.totalAmount).toBe(minor(5_500).toString());
    expect(facts.lines[0]!.unitPrice).toBe(minor(5_500).toString());
  });

  test("a shift closed under the cashier returns to the open-shift screen without selling", async ({
    page,
  }) => {
    const suffix = uniq();
    const reg = await registerWithShift(page);
    const item = await product(reg.locationId, { label: "Item", price: 1_200, suffix });
    await addByCode(page, item.sku!);
    const saleId = await currentSaleId(page);
    await sql(
      `UPDATE "Shift" SET status = 'CLOSED', "closedAt" = now() WHERE "registerId" = $1 AND status = 'OPEN'`,
      [reg.registerId],
    );

    await chargeButton(page).click();
    await payCash(page, 1_200);
    await completeSale(page);
    await expect(page.getByTestId("open-shift")).toBeVisible();
    expect(await saleFacts(saleId)).toBeNull();

    // Opening a new shift gets the cashier selling again.
    await openShiftWithFloat(page, 10_000);
    await expect(page.getByRole("combobox", { name: mn.pos.search.label })).toBeVisible();
  });
});

test.describe("access", () => {
  test("without a shift there is only the open-shift screen", async ({ page }) => {
    session = await startRegister(page, { shift: false });
    await expect(page.getByTestId("open-shift")).toBeVisible();
    await expect(page.getByRole("combobox", { name: mn.pos.search.label })).toHaveCount(0);
    await expect(chargeButton(page)).toHaveCount(0);
  });

  test("a cashier cannot reach the back office", async ({ page }) => {
    session = await startRegister(page, { shift: true });
    // Pages that need a permission a cashier lacks end on the "forbidden" page.
    for (const path of [
      "/catalog/quick-keys",
      "/catalog/import-export",
      "/catalog/products/new",
      "/inventory/adjustments",
      "/inventory/stocktakes",
      "/purchasing/orders",
      "/purchasing/receipts",
      "/purchasing/suppliers",
      "/settings/devices",
      "/settings/tax-classes",
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/forbidden$/);
    }
    await expect(page.getByRole("heading", { name: mn.states.forbiddenTitle })).toBeVisible();

    // Back at the register there is no way into the back office, and locking returns to the PIN pad.
    await page.goto("/register");
    await expect(page.getByRole("link", { name: mn.pos.backOffice })).toHaveCount(0);
    await signOut(page, SEED.cashier.name, mn.auth.lock);
    await expect(page).toHaveURL(/\/pin$/);
    await enterPin(page, SEED.cashier.pin);
    await expect(page).toHaveURL(/\/register$/);
  });
});
