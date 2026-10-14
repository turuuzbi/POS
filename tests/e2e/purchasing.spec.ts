import { expect, test, type Page } from "@playwright/test";
import { mn, SEED, signInWithPassword, signOut } from "./fixtures";
import {
  badge,
  confirmAction,
  count,
  createDraftOrder,
  createProduct,
  createSupplier,
  expectNoHorizontalOverflow,
  main,
  money,
  query,
  scan,
  stockState,
  t,
  token,
  toast,
  watchIssues,
} from "./helpers/purchasing";

const PIECE = mn.units.PIECE;

async function signInOwner(page: Page) {
  await signInWithPassword(page, SEED.owner.email);
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** The stock-list row of a product, as the owner sees it. */
async function stockRow(page: Page, name: string) {
  await page.goto(`/inventory/stock?q=${encodeURIComponent(name)}`);
  const row = main(page).getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  return row;
}

async function expectStock(page: Page, name: string, qty: string, avgCost: number) {
  const row = await stockRow(page, name);
  const cells = row.getByRole("cell");
  await expect(cells.nth(1)).toHaveText(`${qty} ${PIECE}`);
  await expect(cells.nth(3)).toHaveText(money(avgCost));
  await expect(cells.nth(4)).toHaveText(money(avgCost * Number(qty)));
}

/** DRAFT -> ORDERED through the confirm dialog. */
async function markOrdered(page: Page) {
  await confirmAction(page, t.orders.markOrdered);
  await expect(badge(page, t.status.ORDERED)).toBeVisible();
}

test.describe("suppliers", () => {
  test("create with validation, link a product, archive, restore, delete", async ({ page }) => {
    const issues = watchIssues(page);
    await signInOwner(page);
    const product = await createProduct("Нийлүүлэгчийн бараа");
    const name = `E2E Нийлүүлэгч ${token()}`;

    await page.goto("/purchasing/suppliers");
    await expect(
      main(page).getByRole("heading", { level: 1, name: t.suppliers.title }),
    ).toBeVisible();

    // Validation: blank name and malformed e-mail, shown next to the field in Mongolian.
    await main(page).getByRole("button", { name: t.suppliers.new }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: t.suppliers.createTitle })).toBeVisible();
    await dialog.getByLabel(t.suppliers.email, { exact: true }).fill("not-an-email");
    await dialog.getByRole("button", { name: mn.common.save }).click();
    const nameField = dialog.getByLabel(t.suppliers.name, { exact: true });
    await expect(nameField).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.locator("#supplier-name-error")).toHaveText(mn.validation.required);
    await expect(dialog.locator("#supplier-email-error")).toHaveText(mn.validation.invalid);

    // Fixing the fields and submitting twice quickly creates exactly one supplier.
    await nameField.fill(name);
    await dialog.getByLabel(t.suppliers.email, { exact: true }).fill("ner@example.mn");
    await dialog.getByLabel(t.suppliers.phone, { exact: true }).fill("99112233");
    await dialog.getByRole("button", { name: mn.common.save }).dblclick();
    await expect(dialog).toBeHidden();
    const row = main(page).getByRole("row").filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText("99112233");
    expect(await count("Supplier", `"name" = $1`, [name])).toBe(1);

    // Edit keeps the data and shows the stored values.
    await row.getByRole("button", { name: mn.common.edit }).click();
    await expect(
      page.getByRole("dialog").getByLabel(t.suppliers.name, { exact: true }),
    ).toHaveValue(name);
    await page.getByRole("dialog").getByRole("button", { name: mn.common.cancel }).click();

    // Supplier detail: link a product by scanning it.
    await row.getByRole("link", { name }).click();
    await expect(main(page).getByRole("heading", { level: 1, name })).toBeVisible();
    await expect(main(page).getByText(t.supplierItems.empty)).toBeVisible();
    await scan(page, t.supplierItems.add, product.barcode);
    await expect(main(page).getByText(product.name, { exact: true })).toBeVisible();
    await main(page).getByLabel(t.supplierItems.supplierSku).fill(`SUP-${product.sku}`);
    await main(page).getByLabel(t.supplierItems.cost).fill("12 abc");
    await main(page).getByRole("button", { name: mn.common.save, exact: true }).click();
    await expect(main(page).locator("#item-cost-error")).toHaveText(mn.validation.invalidMoney);
    await main(page).getByLabel(t.supplierItems.cost).fill("900");
    await main(page).getByLabel(t.supplierItems.preferred).check();
    await main(page).getByRole("button", { name: mn.common.save, exact: true }).click();
    await expect(toast(page, mn.common.saved)).toBeVisible();
    const item = main(page).getByRole("listitem").filter({ hasText: product.name });
    await expect(item).toContainText(
      t.supplierItems.supplierSkuValue.replace("{sku}", `SUP-${product.sku}`),
    );
    await expect(item).toContainText(t.supplierItems.lastCost.replace("{cost}", "900₮"));
    await expect(item).toContainText(t.supplierItems.preferredBadge);

    // Archive: marked archived and no longer offered on a new order.
    await page.goto("/purchasing/suppliers");
    await confirmAction(page, mn.common.archive, row);
    await expect(row.getByText(mn.common.archived)).toBeVisible();
    await page.goto("/purchasing/orders/new");
    await expect(
      main(page).getByLabel(t.orders.supplier).locator("option", { hasText: name }),
    ).toHaveCount(0);

    // Restore: offered again.
    await page.goto("/purchasing/suppliers");
    await confirmAction(page, mn.common.restore, row);
    await expect(row.getByText(mn.common.archived)).toBeHidden();
    await page.goto("/purchasing/orders/new");
    await expect(
      main(page).getByLabel(t.orders.supplier).locator("option", { hasText: name }),
    ).toHaveCount(1);

    // A supplier with documents cannot be deleted; an unused one can.
    const used = `E2E Ашигласан ${token()}`;
    await createSupplier(page, used);
    await createDraftOrder(page, {
      supplier: used,
      lines: [{ product, qty: "1", cost: "100" }],
    });
    await page.goto("/purchasing/suppliers");
    await expect(
      main(page)
        .getByRole("row")
        .filter({ hasText: used })
        .getByRole("button", { name: mn.common.delete }),
    ).toHaveCount(0);
    await confirmAction(page, mn.common.delete, row); // no documents yet
    await expect(toast(page, mn.common.deleted)).toBeVisible();
    await expect(main(page).getByRole("link", { name, exact: true })).toHaveCount(0);

    expect(issues).toEqual([]);
  });
});

test.describe("purchase order and receiving", () => {
  test("draft -> edit -> ordered -> partial receipt -> rest -> received, with stock and cost", async ({
    page,
  }) => {
    const issues = watchIssues(page);
    await signInOwner(page);
    const product = await createProduct("Захиалгын бараа");
    const supplier = `E2E Нийлүүлэгч ${token()}`;
    await createSupplier(page, supplier);

    // Empty form: the lines hint is shown, and a missing supplier is flagged on the field.
    await page.goto("/purchasing/orders/new");
    await expect(main(page).getByText(t.lines.empty)).toBeVisible();
    await main(page).getByRole("button", { name: t.orders.saveDraft }).click();
    await expect(main(page).locator("#po-supplier-error")).toHaveText(mn.validation.invalid);
    await expect(main(page).getByLabel(t.orders.supplier)).toHaveAttribute("aria-invalid", "true");

    // A scanned barcode adds the line; scanning it again does not duplicate it.
    await main(page).getByLabel(t.orders.supplier).selectOption({ label: supplier });
    await scan(page, t.lines.addProduct, product.barcode);
    const row = main(page).getByRole("listitem").filter({ hasText: product.name });
    await expect(row).toBeVisible();
    await expect(row.getByLabel(t.lines.qty)).toHaveValue("1");
    await scan(page, t.lines.addProduct, product.barcode);
    await expect(row).toHaveCount(1);
    await expect(main(page).getByRole("listitem").filter({ hasText: product.name })).toHaveCount(1);

    // Blank cost (the product has none) and a bad quantity are rejected next to their fields.
    await expect(row.getByLabel(t.lines.unitCost)).toHaveValue("");
    await row.getByLabel(t.lines.qty).fill("0");
    await main(page).getByRole("button", { name: t.orders.saveDraft }).click();
    await expect(row.locator('[id^="qty-"][id$="-error"]')).toHaveText(mn.validation.invalidQty);
    await expect(row.locator('[id^="cost-"][id$="-error"]')).toHaveText(mn.validation.invalidMoney);
    expect(
      await count(
        "PurchaseOrder",
        `"supplierId" IN (SELECT "id" FROM "Supplier" WHERE "name" = $1)`,
        [supplier],
      ),
    ).toBe(0);

    // Valid draft; a double click still creates a single order.
    await row.getByLabel(t.lines.qty).fill("8");
    await row.getByLabel(t.lines.unitCost).fill("1000");
    await expect(main(page).locator("p").filter({ hasText: t.orders.total })).toContainText(
      money(8000),
    );
    await main(page).getByLabel(t.orders.note, { exact: true }).fill("E2E ноорог");
    await main(page).getByRole("button", { name: t.orders.saveDraft }).dblclick();
    await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
    const orderUrl = page.url();
    const number = (await main(page).getByRole("heading", { level: 1 }).textContent())!.trim();
    expect(number).toMatch(/\S/);
    expect(
      await count(
        "PurchaseOrder",
        `"supplierId" IN (SELECT "id" FROM "Supplier" WHERE "name" = $1)`,
        [supplier],
      ),
    ).toBe(1);
    await expect(badge(page, t.status.DRAFT)).toBeVisible();
    await expect(main(page).getByText("E2E ноорог")).toBeVisible();
    // Draft: nothing to receive yet.
    await expect(main(page).getByRole("link", { name: t.orders.receive })).toHaveCount(0);

    // Edit while draft: the form comes back filled; raise the quantity.
    await main(page).getByRole("link", { name: mn.common.edit }).click();
    await expect(main(page).getByRole("heading", { level: 1 })).toContainText(number);
    const editRow = main(page).getByRole("listitem").filter({ hasText: product.name });
    await expect(editRow.getByLabel(t.lines.qty)).toHaveValue("8");
    await expect(editRow.getByLabel(t.lines.unitCost)).toHaveValue("1,000");
    await editRow.getByLabel(t.lines.qty).fill("10");
    await main(page).getByRole("button", { name: t.orders.saveDraft }).click();
    await expect(page).toHaveURL(orderUrl);
    const lineRow = main(page).getByRole("row").filter({ hasText: product.name });
    await expect(lineRow.getByRole("cell").nth(1)).toHaveText("10");
    await expect(main(page).getByRole("row").filter({ hasText: t.orders.total })).toContainText(
      money(10000),
    );

    // Ordering locks the lines: no edit link, and the edit URL bounces back.
    await markOrdered(page);
    await expect(main(page).getByRole("link", { name: mn.common.edit })).toHaveCount(0);
    await page.goto(`${orderUrl}/edit`);
    await expect(page).toHaveURL(orderUrl);

    // Over-receipt is refused (10 ordered, 11 typed); nothing is booked.
    await main(page).getByRole("link", { name: t.orders.receive }).click();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/new\?order=/);
    const receiveUrl = page.url();
    const qty = main(page).getByLabel(t.receipts.qtyReceiving);
    await expect(qty).toHaveValue("10");
    await expect(main(page).getByLabel(t.lines.unitCost)).toHaveValue("1,000");
    await expect(
      main(page).getByText(
        t.receipts.orderedReceived.replace("{ordered}", "10").replace("{received}", "0"),
        { exact: false },
      ),
    ).toBeVisible();
    await qty.fill("11");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(
      main(page).getByRole("alert").filter({ hasText: t.lines.overReceipt }),
    ).toBeVisible();
    expect(await stockState(product.variantId)).toMatchObject({ onHandMilli: 0, movements: 0 });

    // Nothing typed, and a blank cost, are both refused with Mongolian messages.
    await qty.fill("");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(
      main(page).getByRole("alert").filter({ hasText: t.receipts.nothingToReceive }),
    ).toBeVisible();
    await qty.fill("4");
    await main(page).getByLabel(t.lines.unitCost).fill("");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(main(page).locator('[id^="recv-cost-"][id$="-error"]')).toHaveText(
      mn.validation.invalidMoney,
    );
    expect(await stockState(product.variantId)).toMatchObject({ onHandMilli: 0, movements: 0 });

    // Partial receipt of 4 @ 1,000 (double click: one receipt).
    await main(page).getByLabel(t.lines.unitCost).fill("1000");
    await main(page).getByRole("button", { name: t.receipts.submit }).dblclick();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    const receipt1 = (await main(page).getByRole("heading", { level: 1 }).textContent())!.trim();
    await expect(main(page).getByText(t.receipts.againstOrderNumber)).toBeVisible();
    const receiptRow = main(page).getByRole("row").filter({ hasText: product.name });
    await expect(receiptRow.getByRole("cell").nth(1)).toHaveText("4");
    await expect(receiptRow.getByRole("cell").nth(2)).toHaveText(money(1000));
    await expect(
      main(page).getByRole("row").filter({ hasText: mn.purchasing.lines.total }),
    ).toContainText(money(4000));
    expect(await stockState(product.variantId)).toMatchObject({
      onHandMilli: 4000,
      cost: 100_000n,
      movements: 1,
    });

    // The order is now partially received and lists the receipt.
    await page.goto(orderUrl);
    await expect(badge(page, t.status.PARTIALLY_RECEIVED)).toBeVisible();
    await expect(
      main(page).getByRole("row").filter({ hasText: product.name }).getByRole("cell").nth(2),
    ).toHaveText("4");
    await expect(main(page).getByRole("link", { name: receipt1 })).toBeVisible();
    await expect(
      main(page).getByRole("button", { name: t.orders.cancelOrder, exact: true }),
    ).toHaveCount(0);

    // Stock page: quantity, average cost and value; ledger has the receipt row.
    await expectStock(page, product.name, "4", 1000);
    await main(page).getByRole("link", { name: product.name }).click();
    await expect(main(page).getByRole("heading", { level: 1 })).toContainText(product.name);
    const ledgerRow = main(page)
      .getByRole("row")
      .filter({ hasText: mn.inventory.types.PURCHASE_RECEIPT });
    await expect(ledgerRow).toHaveCount(1);
    await expect(ledgerRow).toContainText("+4");
    await expect(ledgerRow.getByRole("cell").nth(4)).toHaveText(money(1000));
    await expect(
      ledgerRow.getByRole("link", {
        name: mn.inventory.ref.goodsReceipt.replace("{number}", receipt1),
      }),
    ).toBeVisible();

    // Receive the rest at a new price: 6 @ 1,500 -> average (4x1000 + 6x1500) / 10 = 1,300.
    await page.goto(receiveUrl);
    await expect(main(page).getByLabel(t.receipts.qtyReceiving)).toHaveValue("6");
    await main(page).getByLabel(t.lines.unitCost).fill("1500");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    expect(await stockState(product.variantId)).toMatchObject({
      onHandMilli: 10_000,
      cost: 130_000n,
      movements: 2,
    });

    await page.goto(orderUrl);
    await expect(badge(page, t.status.RECEIVED)).toBeVisible();
    await expect(main(page).getByRole("link", { name: t.orders.receive })).toHaveCount(0);
    await expect(
      main(page).locator("#po-receipts").locator("..").getByRole("listitem"),
    ).toHaveCount(2);
    // A closed order no longer takes receipts: the receive URL bounces back to it.
    await page.goto(receiveUrl);
    await expect(page).toHaveURL(orderUrl);

    await expectStock(page, product.name, "10", 1300);
    await main(page).getByRole("link", { name: product.name }).click();
    await expect(
      main(page).getByRole("row").filter({ hasText: mn.inventory.types.PURCHASE_RECEIPT }),
    ).toHaveCount(2);

    // Supplier item now carries the latest cost.
    await page.goto("/purchasing/suppliers");
    await main(page).getByRole("link", { name: supplier }).click();
    await expect(main(page).getByRole("listitem").filter({ hasText: product.name })).toContainText(
      t.supplierItems.lastCost.replace("{cost}", "1,500₮"),
    );

    // The list shows the order as received with its total; back/forward keep working.
    await page.goto("/purchasing/orders");
    const listRow = main(page).getByRole("row").filter({ hasText: number });
    await expect(listRow).toContainText(t.status.RECEIVED);
    await expect(listRow.getByRole("cell").last()).toHaveText(money(10000));
    await listRow.getByRole("link", { name: number }).click();
    await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
    await page.goBack();
    await expect(main(page).getByRole("heading", { level: 1, name: t.orders.title })).toBeVisible();
    await page.goForward();
    await expect(main(page).getByRole("heading", { level: 1, name: number })).toBeVisible();

    expect(issues).toEqual([]);
  });

  test("ad-hoc receipt without an order: blank cost rejected, average cost across receipts", async ({
    page,
  }) => {
    const issues = watchIssues(page);
    await signInOwner(page);
    const product = await createProduct("Захиалгагүй бараа");
    const supplier = `E2E Нийлүүлэгч ${token()}`;
    await createSupplier(page, supplier);

    await page.goto("/purchasing/receipts/new");
    await expect(
      main(page).getByRole("heading", { level: 1, name: t.receipts.newTitle }),
    ).toBeVisible();
    // Nothing added yet.
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(
      main(page).getByRole("alert").filter({ hasText: t.receipts.nothingToReceive }),
    ).toBeVisible();

    await main(page)
      .getByLabel(t.receipts.supplier, { exact: true })
      .selectOption({ label: supplier });
    await scan(page, t.lines.addProduct, product.barcode);
    const row = main(page).getByRole("listitem").filter({ hasText: product.name });
    await expect(row).toBeVisible();
    await row.getByLabel(t.lines.qty).fill("5");
    // Blank unit cost is refused (it is not "free"), and stock stays put.
    await expect(row.getByLabel(t.lines.unitCost)).toHaveValue("");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(row.locator('[id^="cost-"][id$="-error"]')).toHaveText(mn.validation.invalidMoney);
    expect(await stockState(product.variantId)).toMatchObject({ onHandMilli: 0, movements: 0 });

    await row.getByLabel(t.lines.unitCost).fill("2000");
    await main(page).getByLabel(t.receipts.note, { exact: true }).fill("E2E захиалгагүй");
    await main(page).getByRole("button", { name: t.receipts.submit }).dblclick();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    const number1 = (await main(page).getByRole("heading", { level: 1 }).textContent())!.trim();
    await expect(main(page).getByText(t.receipts.adHocShort, { exact: true })).toBeVisible();
    await expect(main(page).getByText(supplier)).toBeVisible();
    await expect(main(page).getByText("E2E захиалгагүй", { exact: true })).toBeVisible();
    expect(await stockState(product.variantId)).toMatchObject({
      onHandMilli: 5000,
      cost: 200_000n,
      movements: 1,
    });

    // Second receipt 5 @ 3,000 -> average 2,500, on hand 10.
    await page.goto("/purchasing/receipts/new");
    await main(page)
      .getByLabel(t.receipts.supplier, { exact: true })
      .selectOption({ label: supplier });
    await scan(page, t.lines.addProduct, product.barcode);
    const row2 = main(page).getByRole("listitem").filter({ hasText: product.name });
    // The variant's moving-average cost is pre-filled now.
    await expect(row2.getByLabel(t.lines.unitCost)).toHaveValue("2,000");
    await row2.getByLabel(t.lines.qty).fill("5");
    await row2.getByLabel(t.lines.unitCost).fill("3000");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    expect(await stockState(product.variantId)).toMatchObject({
      onHandMilli: 10_000,
      cost: 250_000n,
      movements: 2,
    });

    await expectStock(page, product.name, "10", 2500);

    // Both receipts are listed, flagged as having no order.
    await page.goto("/purchasing/receipts");
    const listed = main(page).getByRole("row").filter({ hasText: t.receipts.adHocShort });
    await expect(listed.first()).toBeVisible();
    await expect(main(page).getByRole("link", { name: number1 })).toBeVisible();

    // The supplier is linked to the product with its latest cost.
    await page.goto("/purchasing/suppliers");
    await main(page).getByRole("link", { name: supplier }).click();
    await expect(main(page).getByRole("listitem").filter({ hasText: product.name })).toContainText(
      t.supplierItems.lastCost.replace("{cost}", "3,000₮"),
    );
    expect(issues).toEqual([]);
  });

  test("cancel, close short, and stale buttons", async ({ page, context }) => {
    const issues = watchIssues(page);
    await signInOwner(page);
    const product = await createProduct("Цуцлалтын бараа");
    const supplier = `E2E Нийлүүлэгч ${token()}`;
    await createSupplier(page, supplier);
    const lines = [{ product, qty: "5", cost: "700" }];

    // An empty draft cannot be sent to the supplier.
    await page.goto("/purchasing/orders/new");
    await main(page).getByLabel(t.orders.supplier).selectOption({ label: supplier });
    await main(page).getByRole("button", { name: t.orders.saveDraft }).click();
    await expect(page).toHaveURL(/\/purchasing\/orders\/[0-9a-f-]{36}$/);
    await expect(main(page).getByText(t.orders.noLines)).toBeVisible();
    await confirmAction(page, t.orders.markOrdered);
    await expect(toast(page, mn.errors.VALIDATION)).toBeVisible();
    await expect(badge(page, t.status.DRAFT)).toBeVisible();

    // Cancel a draft.
    const draft = await createDraftOrder(page, { supplier, lines });
    await confirmAction(page, t.orders.cancelOrder);
    await expect(toast(page, t.orders.cancelled)).toBeVisible();
    await expect(badge(page, t.status.CANCELLED)).toBeVisible();
    for (const name of [mn.common.edit, t.orders.receive]) {
      await expect(main(page).getByRole("link", { name })).toHaveCount(0);
    }
    for (const name of [t.orders.markOrdered, t.orders.cancelOrder, t.orders.closeShort]) {
      await expect(main(page).getByRole("button", { name, exact: true })).toHaveCount(0);
    }
    await page.goto(`/purchasing/orders/${draft.id}/edit`);
    await expect(page).toHaveURL(`/purchasing/orders/${draft.id}`);
    await page.goto(`/purchasing/receipts/new?order=${draft.id}`);
    await expect(page).toHaveURL(`/purchasing/orders/${draft.id}`);
    // It shows under the cancelled filter and not under the draft filter.
    await page.goto("/purchasing/orders?status=CANCELLED");
    await expect(main(page).getByRole("link", { name: draft.number })).toBeVisible();
    await page.goto("/purchasing/orders?status=DRAFT");
    await expect(main(page).getByRole("link", { name: draft.number })).toHaveCount(0);

    // Cancel an ordered (untouched) order from a second tab that still shows "mark ordered".
    const sent = await createDraftOrder(page, { supplier, lines });
    const stale = await context.newPage();
    await stale.goto(`/purchasing/orders/${sent.id}`);
    await expect(
      stale.getByRole("main").getByRole("button", { name: t.orders.markOrdered, exact: true }),
    ).toBeVisible();
    await markOrdered(page);
    await confirmAction(page, t.orders.cancelOrder);
    await expect(badge(page, t.status.CANCELLED)).toBeVisible();
    await confirmAction(stale, t.orders.markOrdered);
    await expect(toast(stale, mn.errors.INVALID_STATE)).toBeVisible();
    await stale.close();

    // Partial receipt -> cancel is gone, "close without remainder" finishes it.
    const closing = await createDraftOrder(page, { supplier, lines });
    await markOrdered(page);
    await main(page).getByRole("link", { name: t.orders.receive }).click();
    await main(page).getByLabel(t.receipts.qtyReceiving).fill("2");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    await page.goto(`/purchasing/orders/${closing.id}`);
    await expect(badge(page, t.status.PARTIALLY_RECEIVED)).toBeVisible();
    await expect(
      main(page).getByRole("button", { name: t.orders.cancelOrder, exact: true }),
    ).toHaveCount(0);
    await confirmAction(page, t.orders.closeShort);
    await expect(badge(page, t.status.RECEIVED)).toBeVisible();
    await expect(
      main(page).getByRole("row").filter({ hasText: product.name }).getByRole("cell").nth(2),
    ).toHaveText("2");
    // Only what arrived is in stock, at the order's cost.
    expect(await stockState(product.variantId)).toMatchObject({ onHandMilli: 2000, cost: 70_000n });
    await page.goto(`/purchasing/receipts/new?order=${closing.id}`);
    await expect(page).toHaveURL(`/purchasing/orders/${closing.id}`);

    expect(issues).toEqual([]);
  });
});

test.describe("documents", () => {
  test("print buttons and print layout", async ({ page }) => {
    const issues = watchIssues(page);
    await page.addInitScript(() => {
      (window as unknown as { __prints: number }).__prints = 0;
      window.print = () => {
        (window as unknown as { __prints: number }).__prints++;
      };
    });
    await signInOwner(page);
    const product = await createProduct("Хэвлэх бараа");
    const supplier = `E2E Нийлүүлэгч ${token()}`;
    await createSupplier(page, supplier);
    const order = await createDraftOrder(page, {
      supplier,
      lines: [{ product, qty: "3", cost: "500" }],
    });
    const prints = () => page.evaluate(() => (window as unknown as { __prints: number }).__prints);

    await main(page).getByRole("button", { name: t.orders.print }).click();
    await expect.poll(prints).toBe(1);
    // Printing hides the app shell and the action buttons.
    await expect(page.locator("aside")).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("aside")).toBeHidden();
    await expect(page.locator("header").first()).toBeHidden();
    await expect(main(page).getByRole("button", { name: t.orders.print })).toBeHidden();
    await expect(main(page).getByRole("heading", { level: 1, name: order.number })).toBeVisible();
    await expect(main(page).getByRole("row").filter({ hasText: product.name })).toBeVisible();
    await page.emulateMedia({ media: "screen" });

    await markOrdered(page);
    await main(page).getByRole("link", { name: t.orders.receive }).click();
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    await main(page).getByRole("button", { name: t.receipts.print }).click();
    await expect.poll(prints).toBe(2); // same document: the counter carries over
    await page.emulateMedia({ media: "print" });
    await expect(page.locator("aside")).toBeHidden();
    await expect(main(page).getByRole("row").filter({ hasText: product.name })).toBeVisible();
    expect(issues).toEqual([]);
  });
});

test.describe("permissions", () => {
  test("cashiers cannot open any purchasing page", async ({ page }) => {
    await signInWithPassword(page, SEED.manager.email);
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("/settings/devices");
    await page.getByLabel(mn.devices.name).fill(`E2E purchasing ${token()}`);
    await page.getByRole("button", { name: mn.devices.pair }).click();
    await expect(page.getByText(mn.devices.paired)).toBeVisible();
    await signOut(page, SEED.manager.name, mn.auth.signOut);

    await page.getByRole("button", { name: "4", exact: true }).click();
    for (const digit of "82109") {
      await page.getByRole("button", { name: digit, exact: true }).click();
    }
    await page.getByRole("button", { name: mn.auth.submit }).click();
    await expect(page).toHaveURL(/\/register$/);

    const id = "01a13a2e-cc50-747d-adc9-25cbdc5c3eff";
    for (const path of [
      "/purchasing/suppliers",
      `/purchasing/suppliers/${id}`,
      "/purchasing/orders",
      "/purchasing/orders/new",
      `/purchasing/orders/${id}`,
      `/purchasing/orders/${id}/edit`,
      "/purchasing/receipts",
      "/purchasing/receipts/new",
      `/purchasing/receipts/new?order=${id}`,
      `/purchasing/receipts/${id}`,
    ]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/forbidden$/);
      await expect(page.getByRole("heading", { name: mn.states.forbiddenTitle })).toBeVisible();
    }
  });

  test("manager runs the whole flow and sees costs", async ({ page }) => {
    const issues = watchIssues(page);
    await signInWithPassword(page, SEED.manager.email);
    await expect(page).toHaveURL(/\/dashboard$/);
    for (const label of [mn.nav.purchaseOrders, mn.nav.receiving, mn.nav.suppliers]) {
      await expect(page.getByRole("link", { name: label }).first()).toBeVisible();
    }
    const product = await createProduct("Менежерийн бараа");
    const supplier = `E2E Нийлүүлэгч ${token()}`;
    await createSupplier(page, supplier);
    const order = await createDraftOrder(page, {
      supplier,
      lines: [{ product, qty: "2", cost: "450" }],
    });
    await expect(main(page).getByRole("row").filter({ hasText: t.orders.total })).toContainText(
      money(900),
    );
    await markOrdered(page);
    await main(page).getByRole("link", { name: t.orders.receive }).click();
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    await expect(
      main(page).getByRole("row").filter({ hasText: product.name }).getByRole("cell").nth(2),
    ).toHaveText(money(450));
    await page.goto(`/purchasing/orders?status=RECEIVED`);
    await expect(main(page).getByRole("link", { name: order.number })).toBeVisible();
    await expectStock(page, product.name, "2", 450);
    expect(await stockState(product.variantId)).toMatchObject({ onHandMilli: 2000, cost: 45_000n });
    expect(issues).toEqual([]);
  });

  test("unknown and malformed ids are not found", async ({ page }) => {
    await signInOwner(page);
    for (const path of [
      "/purchasing/orders/not-a-uuid",
      "/purchasing/orders/01a13a2e-cc50-747d-adc9-25cbdc5c3eff",
      "/purchasing/orders/01a13a2e-cc50-747d-adc9-25cbdc5c3eff/edit",
      "/purchasing/receipts/not-a-uuid",
      "/purchasing/receipts/new?order=01a13a2e-cc50-747d-adc9-25cbdc5c3eff",
      "/purchasing/suppliers/01a13a2e-cc50-747d-adc9-25cbdc5c3eff",
    ]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: mn.states.notFoundTitle })).toBeVisible();
    }
  });
});

test.describe("phone width", () => {
  test("no horizontal overflow, console errors or failed requests on any purchasing page", async ({
    page,
  }) => {
    const issues = watchIssues(page);
    await signInOwner(page);
    const product = await createProduct("Утасны бараа");
    const other = await createProduct("Утасны бараа 2");
    const supplier = `E2E Нийлүүлэгч ${token()} ${"урт нэр ".repeat(4)}`.trim();
    await createSupplier(page, supplier);
    const ordered = await createDraftOrder(page, {
      supplier,
      lines: [
        { product, qty: "4", cost: "1000" },
        { product: other, qty: "2", cost: "2500" },
      ],
    });
    const draft = await createDraftOrder(page, {
      supplier,
      lines: [{ product, qty: "1", cost: "1000" }],
    });
    await page.goto(`/purchasing/orders/${ordered.id}`);
    await markOrdered(page);
    await main(page).getByRole("link", { name: t.orders.receive }).click();
    await main(page).getByLabel(t.receipts.qtyReceiving).first().fill("1");
    await main(page).getByRole("button", { name: t.receipts.submit }).click();
    await expect(page).toHaveURL(/\/purchasing\/receipts\/[0-9a-f-]{36}$/);
    const receiptUrl = page.url();
    const [supplierRow] = await query<{ id: string }>(
      `SELECT "id" FROM "Supplier" WHERE "name" = $1`,
      [supplier],
    );

    await page.setViewportSize({ width: 390, height: 844 });
    const pages: [string, RegExp | string][] = [
      ["/purchasing/suppliers", t.suppliers.title],
      [`/purchasing/suppliers/${supplierRow!.id}`, supplier],
      ["/purchasing/orders", t.orders.title],
      ["/purchasing/orders/new", t.orders.createTitle],
      [`/purchasing/orders/${ordered.id}`, ordered.number],
      [`/purchasing/orders/${draft.id}`, draft.number],
      [`/purchasing/orders/${draft.id}/edit`, new RegExp(draft.number)],
      ["/purchasing/receipts", t.receipts.title],
      ["/purchasing/receipts/new", t.receipts.newTitle],
      [`/purchasing/receipts/new?order=${ordered.id}`, t.receipts.newTitle],
      [receiptUrl.replace(/^https?:\/\/[^/]+/, ""), /./],
      [`/inventory/stock/${product.variantId}`, new RegExp(product.name)],
    ];
    for (const [path, heading] of pages) {
      await page.goto(path);
      await expect(main(page).getByRole("heading", { level: 1 }).first(), path).toHaveText(heading);
      await expectNoHorizontalOverflow(page);
    }

    // Forms with content: lines in the editor and a supplier dialog.
    await page.goto("/purchasing/orders/new");
    await scan(page, t.lines.addProduct, product.barcode);
    await expect(main(page).getByRole("listitem").filter({ hasText: product.name })).toHaveCount(1);
    await scan(page, t.lines.addProduct, other.barcode);
    await expect(main(page).getByRole("listitem").filter({ hasText: other.name })).toHaveCount(1);
    await expectNoHorizontalOverflow(page);
    await page.goto("/purchasing/receipts/new");
    await scan(page, t.lines.addProduct, product.barcode);
    await expect(
      main(page).getByRole("listitem").filter({ hasText: product.name }).first(),
    ).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto("/purchasing/suppliers");
    await main(page).getByRole("button", { name: t.suppliers.new }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    expect(issues).toEqual([]);
  });
});
