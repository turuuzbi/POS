import { expect, test, type Page } from "@playwright/test";
import { formAlert, mn, SEED, signInWithPassword } from "./fixtures";
import {
  adjust,
  adjustmentCount,
  appendMovements,
  addReferencedMovements,
  chooseReason,
  createLocation,
  createProduct,
  createStaff,
  expectLedgerConsistent,
  expectNoHorizontalOverflow,
  ledger,
  mainLocation,
  msg,
  num,
  onHand,
  PHONE,
  pickProduct,
  plural,
  qtyInput,
  qtyText,
  retireCreated,
  searchStock,
  setInput,
  shortId,
  signed,
  submitAdjustment,
  token,
  watchHealth,
} from "./helpers/stock";

test.afterEach(async () => {
  await retireCreated();
});

const signInOwner = (page: Page) => signInWithPassword(page, SEED.owner.email);

const stockRow = (page: Page, name: string) => page.getByRole("row").filter({ hasText: name });

test.describe("stock table", () => {
  test("search, low-stock filter, pagination, archived and untracked items", async ({ page }) => {
    const health = watchHealth(page);
    const t = token();
    const loc = await mainLocation();
    const name = (n: number) => `${t} бараа ${String(n).padStart(2, "0")}`;

    // 27 stocked items (pagination is 25 per page): #01 below its reorder point,
    // #02 exactly at it, #03 has no reorder point at all.
    for (let n = 1; n <= 27; n++) {
      await createProduct({
        name: name(n),
        sku: n === 5 ? `E2E-${t}-05` : undefined,
        locationId: loc.id,
        onHandMilli: n === 1 ? 3000 : n === 2 ? 5000 : n === 3 ? 2000 : 10000,
        reorderPointMilli: n === 3 ? null : 5000,
      });
    }
    await createProduct({
      name: `${t} архивласан`,
      isActive: false,
      locationId: loc.id,
      onHandMilli: 1000,
    });
    await createProduct({ name: `${t} үйлчилгээ`, trackStock: false });

    await signInOwner(page);
    await page.goto("/inventory/stock");
    await expect(page.getByRole("heading", { name: mn.inventory.title, level: 1 })).toBeVisible();
    // Single location: no location picker, and the owner sees cost columns.
    await expect(page.getByLabel(mn.inventory.location, { exact: true })).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: mn.inventory.avgCost })).toBeVisible();

    // Search narrows to this run's items; archived and untracked ones never show.
    await searchStock(page, t);
    await expect(page.getByText(plural(mn.inventory.resultCount, 27))).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(1 + 25);
    await expect(page.getByText(`${t} архивласан`)).toHaveCount(0);
    await expect(page.getByText(`${t} үйлчилгээ`)).toHaveCount(0);

    // Status and reorder-point rendering.
    const first = stockRow(page, name(1));
    await expect(first.getByRole("cell").nth(1)).toHaveText(qtyText(3000));
    await expect(first.getByRole("cell").nth(2)).toHaveText(qtyText(5000));
    await expect(first.getByText(mn.inventory.low, { exact: true })).toBeVisible();
    await expect(
      stockRow(page, name(2)).getByText(mn.inventory.low, { exact: true }),
    ).toBeVisible();
    const noPoint = stockRow(page, name(3));
    await expect(noPoint.getByRole("cell").nth(2)).toHaveText("—");
    await expect(noPoint.getByText(mn.inventory.ok, { exact: true })).toBeVisible();
    await expect(stockRow(page, name(4)).getByText(mn.inventory.ok, { exact: true })).toBeVisible();

    // Pagination keeps the search; back/forward walk the pages.
    await page.getByRole("link", { name: mn.common.next }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page).toHaveURL(new RegExp(`q=${encodeURIComponent(t)}`));
    await expect(page.getByRole("row")).toHaveCount(1 + 2);
    await expect(stockRow(page, name(27))).toBeVisible();
    await expect(page.getByRole("link", { name: mn.common.next })).toHaveCount(0);
    await page.goBack();
    await expect(page).not.toHaveURL(/page=2/);
    await expect(page.getByRole("row")).toHaveCount(1 + 25);
    await page.goForward();
    await expect(stockRow(page, name(27))).toBeVisible();
    await page.getByRole("link", { name: mn.common.previous }).click();
    await expect(stockRow(page, name(1))).toBeVisible();
    // A page number past the end clamps to the last page instead of erroring.
    await page.goto(`/inventory/stock?q=${encodeURIComponent(t)}&page=999`);
    await expect(stockRow(page, name(27))).toBeVisible();

    // Low-stock filter: at or below the reorder point, nothing else.
    await page.goto("/inventory/stock");
    await searchStock(page, t, { low: true });
    await expect(page).toHaveURL(/low=1/);
    await expect(page.getByText(plural(mn.inventory.resultCount, 2))).toBeVisible();
    await expect(page.getByRole("row")).toHaveCount(1 + 2);
    await expect(stockRow(page, name(1))).toBeVisible();
    await expect(stockRow(page, name(2))).toBeVisible();
    await expect(page.getByRole("link", { name: mn.common.next })).toHaveCount(0);

    // SKU search; an exact match on one item.
    await page.goto("/inventory/stock");
    await searchStock(page, `E2E-${t}-05`);
    await expect(page.getByText(plural(mn.inventory.resultCount, 1))).toBeVisible();
    await expect(stockRow(page, name(5))).toContainText(`E2E-${t}-05`);

    // Nothing matches: the "no results" empty state, not the "no products" one.
    await page.goto("/inventory/stock");
    await searchStock(page, `${t}-нет-такой`);
    await expect(page.getByRole("heading", { name: mn.inventory.noResults })).toBeVisible();
    await expect(page.getByText(mn.inventory.noResultsDescription)).toBeVisible();
    await expect(page.getByRole("heading", { name: mn.inventory.empty })).toHaveCount(0);

    // Low filter with a search that has no low items.
    await searchStock(page, name(4), { low: true });
    await expect(page.getByRole("heading", { name: mn.inventory.noResults })).toBeVisible();

    health.expectClean();
  });

  test("a user without any location sees the no-locations state", async ({ page }) => {
    const t = token();
    const staff = await createStaff({ role: "MANAGER", locationIds: [], suffix: t });
    await signInWithPassword(page, staff.email);
    await page.goto("/inventory/stock");
    await expect(page.getByRole("heading", { name: mn.inventory.noLocations })).toBeVisible();
    await expect(page.getByLabel(mn.inventory.search)).toHaveCount(0);
  });
});

test.describe("variant ledger", () => {
  test("signed deltas, running balances, reference links and pagination", async ({ page }) => {
    const health = watchHealth(page);
    const t = token();
    const loc = await mainLocation();
    const product = await createProduct({
      name: `${t} дэвтэр`,
      locationId: loc.id,
      onHandMilli: 10000,
      reorderPointMilli: 2000,
    });
    const refs = await addReferencedMovements(product.variantId, loc.id, t, 10000);

    await signInOwner(page);
    await page.goto("/inventory/stock");
    await searchStock(page, t);
    await stockRow(page, product.name).getByRole("link", { name: product.name }).click();
    await expect(page).toHaveURL(new RegExp(`/inventory/stock/${product.variantId}\\?location=`));
    await expect(
      page.getByRole("heading", {
        name: msg(mn.inventory.historyFor, { name: product.name }),
        level: 1,
      }),
    ).toBeVisible();
    await expect(page.getByText(loc.name).first()).toBeVisible();
    const onHandCard = page.locator("dl").first();
    await expect(onHandCard).toContainText(qtyText(refs.balanceMilli));
    await expect(onHandCard).toContainText(qtyText(2000));

    // Newest first: stocktake −1 → 13, receipt +4 → 14, opening +10 → 10.
    const rows = page.getByRole("row");
    await expect(rows).toHaveCount(1 + 3);
    const cells = (row: number) => rows.nth(row).getByRole("cell");
    await expect(cells(1).nth(1)).toHaveText(mn.inventory.types.STOCKTAKE);
    await expect(cells(1).nth(2)).toHaveText(signed(-1000));
    await expect(cells(1).nth(3)).toHaveText(num(13000));
    await expect(cells(2).nth(1)).toHaveText(mn.inventory.types.PURCHASE_RECEIPT);
    await expect(cells(2).nth(2)).toHaveText(signed(4000));
    await expect(cells(2).nth(3)).toHaveText(num(14000));
    await expect(cells(3).nth(1)).toHaveText(mn.inventory.types.OPENING);
    await expect(cells(3).nth(2)).toHaveText(signed(10000));
    await expect(cells(3).nth(3)).toHaveText(num(10000));
    await expect(cells(3).nth(5)).toHaveText("—"); // no document behind an opening balance

    // References open real pages for an owner (no 404, no forbidden).
    const receiptLink = page.getByRole("link", {
      name: msg(mn.inventory.ref.goodsReceipt, { number: refs.receiptNumber }),
    });
    await receiptLink.click();
    await expect(page).toHaveURL(new RegExp(`/purchasing/receipts/${refs.receiptId}$`));
    await expect(page.getByRole("heading", { name: refs.receiptNumber })).toBeVisible();
    await page.goBack();
    await expect(receiptLink).toBeVisible();
    await page
      .getByRole("link", {
        name: msg(mn.inventory.ref.stocktake, { number: refs.stocktakeNumber }),
      })
      .click();
    await expect(page).toHaveURL(new RegExp(`/inventory/stocktakes/${refs.stocktakeId}$`));
    await expect(page.getByRole("heading", { name: refs.stocktakeNumber })).toBeVisible();

    // Back to the stock list keeps the location.
    await page.goto(`/inventory/stock/${product.variantId}?location=${loc.id}`);
    await page.getByRole("link", { name: mn.inventory.backToStock }).click();
    await expect(page).toHaveURL(new RegExp(`/inventory/stock\\?location=${loc.id}`));

    // A long ledger paginates, newest first, with continuous balances.
    const long = await createProduct({
      name: `${t} урт түүх`,
      locationId: loc.id,
      onHandMilli: 10000,
    });
    await appendMovements(long.variantId, loc.id, 33, 10000);
    const entries = await ledger(long.variantId, loc.id);
    expect(entries).toHaveLength(34);
    await page.goto(`/inventory/stock/${long.variantId}?location=${loc.id}`);
    await expect(page.getByRole("row")).toHaveCount(1 + 30);
    await expect(page.getByRole("row").nth(1).getByRole("cell").nth(3)).toHaveText(
      num(entries.at(-1)!.balance),
    );
    await expect(page.getByRole("row").nth(1).getByRole("cell").nth(7)).toHaveText("bulk 33");
    await page.getByRole("link", { name: mn.common.next }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(page).toHaveURL(new RegExp(`location=${loc.id}`));
    await expect(page.getByRole("row")).toHaveCount(1 + 4);
    await expect(page.getByRole("row").nth(1).getByRole("cell").nth(7)).toHaveText("bulk 3");
    await expect(page.getByRole("row").nth(4).getByRole("cell").nth(1)).toHaveText(
      mn.inventory.types.OPENING,
    );
    await page.goBack();
    await expect(page.getByRole("row")).toHaveCount(1 + 30);
    await page.goto(`/inventory/stock/${long.variantId}?location=${loc.id}&page=99`);
    await expect(page.getByRole("row")).toHaveCount(1 + 4); // clamped to the last page

    // A variant never stocked here has an empty ledger, not an error.
    const fresh = await createProduct({ name: `${t} шинэ` });
    await page.goto(`/inventory/stock/${fresh.variantId}?location=${loc.id}`);
    await expect(page.getByText(mn.inventory.ledgerEmpty)).toBeVisible();

    health.expectClean();
  });

  test("bad ids are a 404, not a crash", async ({ page }) => {
    await signInOwner(page);
    const loc = await mainLocation();
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
      await page.goto(`/inventory/stock/${id}?location=${loc.id}`);
      await expect(page.getByRole("heading", { name: mn.states.notFoundTitle })).toBeVisible();
    }
  });
});

test.describe("adjustments", () => {
  test("every reason posts the right signed delta; stock, ledger and detail agree", async ({
    page,
  }) => {
    const health = watchHealth(page);
    const t = token();
    const loc = await mainLocation();
    const product = await createProduct({
      name: `${t} шил`,
      sku: `ADJ-${t}`,
      locationId: loc.id,
      onHandMilli: 10000,
      cost: 500,
    });

    await signInOwner(page);
    // Warm the stock page into the client router cache, then adjust: the next
    // visit must show the new balance, not a stale one.
    await page.goto("/inventory/stock");
    await searchStock(page, t);
    await expect(stockRow(page, product.name).getByRole("cell").nth(1)).toHaveText(qtyText(10000));

    const plan = [
      { reason: "DAMAGED", qty: "3", delta: -3000, balance: 7000, note: `${t} гэмтсэн` },
      { reason: "FOUND", qty: "5", delta: 5000, balance: 12000, note: `${t} олдсон` },
      { reason: "CORRECTION", qty: "-2", delta: -2000, balance: 10000, note: `${t} залруулга` },
      { reason: "CORRECTION", qty: "3", delta: 3000, balance: 13000, note: `${t} нэмэлт` },
      { reason: "LOST_STOLEN", qty: "1", delta: -1000, balance: 12000, note: `${t} алдсан` },
      { reason: "EXPIRED", qty: "2", delta: -2000, balance: 10000, note: `${t} дууссан` },
      { reason: "INTERNAL_USE", qty: "1", delta: -1000, balance: 9000, note: `${t} дотоод` },
      { reason: "OTHER", qty: "-4", delta: -4000, balance: 5000, note: `${t} бусад` },
    ] as const;
    const ids: string[] = [];
    for (const step of plan) {
      const id = await adjust(page, product, {
        reason: step.reason,
        qty: step.qty,
        note: step.note,
      });
      ids.push(id);
      // Detail page: reason, location, signed delta, balance after.
      await expect(
        page.getByRole("heading", { name: msg(mn.adjustments.detailTitle, { id: shortId(id) }) }),
      ).toBeVisible();
      await expect(page.getByText(mn.adjustments.reasons[step.reason]).first()).toBeVisible();
      await expect(page.getByText(step.note)).toBeVisible();
      const line = page.getByRole("row").filter({ hasText: product.name });
      await expect(line).toContainText(`${signed(step.delta)} ${mn.units.PIECE}`);
      await expect(line).toContainText(qtyText(step.balance));
      const rows = await ledger(product.variantId, loc.id);
      const last = rows.at(-1)!;
      expect(last).toMatchObject({
        type: "ADJUSTMENT",
        delta: step.delta,
        balance: step.balance,
        adjustmentId: id,
        note: step.note,
      });
    }
    await expectLedgerConsistent(product.variantId, loc.id);
    expect(await ledger(product.variantId, loc.id)).toHaveLength(1 + plan.length);

    // Stock page shows the exact final balance (client-side navigation back).
    await page.getByRole("link", { name: mn.nav.stock }).first().click();
    await expect(page).toHaveURL(/\/inventory\/stock/);
    await searchStock(page, t);
    await expect(stockRow(page, product.name).getByRole("cell").nth(1)).toHaveText(qtyText(5000));

    // The ledger carries every step, with link, signed change and balance.
    await stockRow(page, product.name).getByRole("link", { name: product.name }).click();
    for (const [index, step] of plan.entries()) {
      const row = page.getByRole("row").filter({ hasText: step.note });
      await expect(row.getByRole("cell").nth(1)).toHaveText(mn.inventory.types.ADJUSTMENT);
      await expect(row.getByRole("cell").nth(2)).toHaveText(signed(step.delta));
      await expect(row.getByRole("cell").nth(3)).toHaveText(num(step.balance));
      const link = row.getByRole("link", {
        name: msg(mn.inventory.ref.adjustment, { id: shortId(ids[index]!) }),
      });
      await expect(link).toHaveAttribute("href", `/inventory/adjustments/${ids[index]}`);
    }
    await expect(page.getByRole("row").nth(1)).toContainText(`${t} бусад`); // newest first
    // Reference links open the adjustment (no 404 / forbidden for the owner).
    await page.getByRole("row").filter({ hasText: plan[0].note }).getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/inventory/adjustments/${ids[0]}$`));
    await expect(page.getByText(plan[0].note)).toBeVisible();
    // And the product link on the detail page returns to the ledger.
    await page.getByRole("link", { name: product.name }).click();
    await expect(page).toHaveURL(new RegExp(`/inventory/stock/${product.variantId}`));

    // The adjustments list shows them all, newest first, with their reasons.
    await page.goto("/inventory/adjustments");
    await expect(page.getByRole("link", { name: shortId(ids.at(-1)!) })).toBeVisible();
    await expect(page.getByRole("row").nth(1)).toContainText(mn.adjustments.reasons.OTHER);
    for (const id of ids) await expect(page.getByRole("link", { name: shortId(id) })).toBeVisible();

    health.expectClean();
  });

  test("'set to' mode, previews, direction hints and form behaviour", async ({ page }) => {
    const t = token();
    const loc = await mainLocation();
    const product = await createProduct({
      name: `${t} кабель`,
      locationId: loc.id,
      onHandMilli: 8000,
      cost: 500,
    });
    const other = await createProduct({ name: `${t} утас`, locationId: loc.id, onHandMilli: 2000 });

    await signInOwner(page);
    await page.goto("/inventory/adjustments/new");
    await expect(page.getByRole("button", { name: mn.adjustments.form.submit })).toBeDisabled();
    await expect(page.getByText(mn.adjustments.form.noLines)).toBeVisible();

    // Direction hints follow the reason.
    await chooseReason(page, "DAMAGED");
    await expect(page.getByText(mn.adjustments.direction.decrease)).toBeVisible();
    await chooseReason(page, "FOUND");
    await expect(page.getByText(mn.adjustments.direction.increase)).toBeVisible();
    await chooseReason(page, "CORRECTION");
    await expect(page.getByText(mn.adjustments.direction.both)).toBeVisible();
    await expect(page.getByText(mn.adjustments.noteRequiredHint)).toBeVisible();

    // The picker adds a line once only; the line shows the current balance.
    await pickProduct(page, product);
    await pickProduct(page, product);
    await expect(qtyInput(page)).toHaveCount(1);
    await expect(
      page.getByText(msg(mn.adjustments.form.current, { qty: qtyText(8000) })),
    ).toBeVisible();

    // Delta preview with the cost impact; switching to 'set to' recomputes.
    await qtyInput(page).fill("-3");
    await expect(
      page.getByText(msg(mn.adjustments.form.after, { qty: qtyText(5000) }), { exact: false }),
    ).toBeVisible();
    await page
      .getByLabel(mn.adjustments.form.mode, { exact: true })
      .selectOption({ label: mn.adjustments.form.modeSet });
    await setInput(page).fill("2");
    await expect(
      page.getByText(msg(mn.adjustments.form.after, { qty: qtyText(2000) }), { exact: false }),
    ).toBeVisible();

    // Reasons with a different direction reset the typed quantities.
    await chooseReason(page, "DAMAGED");
    await expect(page.getByLabel(mn.adjustments.form.mode, { exact: true })).toHaveCount(0);
    await expect(qtyInput(page)).toHaveValue("");
    await qtyInput(page).fill("1");
    await chooseReason(page, "FOUND");
    await expect(qtyInput(page)).toHaveValue("");

    // A line can be removed again.
    await page
      .getByRole("button", { name: msg(mn.adjustments.form.removeLine, { name: product.name }) })
      .click();
    await expect(page.getByText(mn.adjustments.form.noLines)).toBeVisible();

    // Two lines, 'set to' on both: counted values replace balances exactly.
    await chooseReason(page, "CORRECTION");
    await page.getByLabel(mn.adjustments.note).fill(`${t} тоолсон`);
    await pickProduct(page, product);
    await pickProduct(page, other);
    const modes = page.getByLabel(mn.adjustments.form.mode, { exact: true });
    await modes.nth(0).selectOption({ label: mn.adjustments.form.modeSet });
    await modes.nth(1).selectOption({ label: mn.adjustments.form.modeSet });
    await setInput(page).nth(0).fill("0"); // zero is a valid count
    await setInput(page).nth(1).fill("7");
    await submitAdjustment(page);
    await page.waitForURL(/\/inventory\/adjustments\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("row").filter({ hasText: product.name })).toContainText(
      `${signed(-8000)} ${mn.units.PIECE}`,
    );
    await expect(page.getByRole("row").filter({ hasText: other.name })).toContainText(
      `${signed(5000)} ${mn.units.PIECE}`,
    );
    expect(await onHand(product.variantId, loc.id)).toBe(0);
    expect(await onHand(other.variantId, loc.id)).toBe(7000);
    await expectLedgerConsistent(product.variantId, loc.id);
    await expectLedgerConsistent(other.variantId, loc.id);
  });

  test("validation errors are shown in Mongolian next to the field; nothing is posted", async ({
    page,
  }) => {
    const t = token();
    const loc = await mainLocation();
    const product = await createProduct({
      name: `${t} аяга`,
      locationId: loc.id,
      onHandMilli: 5000,
    });
    const archived = await createProduct({
      name: `${t} хуучин`,
      isActive: false,
      locationId: loc.id,
      onHandMilli: 5000,
    });
    const untracked = await createProduct({ name: `${t} засвар үйлчилгээ`, trackStock: false });
    const adjustments = await adjustmentCount(loc.id);

    await signInOwner(page);
    await page.goto("/inventory/adjustments/new");

    // Archived and untracked items are not offered.
    const picker = page.getByRole("combobox", { name: mn.adjustments.form.find });
    for (const hidden of [archived, untracked]) {
      await picker.fill(hidden.name);
      await expect(page.getByRole("listbox").getByText(mn.picker.noResults)).toBeVisible();
      await picker.fill("");
    }

    // A reason that needs a note refuses to submit without one, at the field.
    await chooseReason(page, "LOST_STOLEN");
    await pickProduct(page, product);
    await qtyInput(page).fill("1");
    await submitAdjustment(page);
    await expect(page.locator("#adj-note-error")).toHaveText(mn.validation.required);
    await expect(page.getByLabel(mn.adjustments.note)).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/adjustments\/new$/);
    await page.getByLabel(mn.adjustments.note).fill(`${t} тэмдэглэл`);
    await expect(page.locator("#adj-note-error")).toHaveCount(0);

    // Bad quantities: text, zero, fractions of a piece, blank.
    for (const bad of ["abc", "0", "1.5", "", "-"]) {
      await qtyInput(page).fill(bad);
      await submitAdjustment(page);
      await expect(page.locator("#adj-qty-" + product.variantId + "-error")).toHaveText(
        mn.validation.invalidQty,
      );
      await expect(formAlert(page)).toHaveText(mn.adjustments.form.fixLines);
      await expect(page).toHaveURL(/\/adjustments\/new$/);
    }

    // Cannot take stock below zero; the server says so and nothing changes.
    await qtyInput(page).fill("6");
    await submitAdjustment(page);
    await expect(formAlert(page)).toHaveText(mn.errors.INSUFFICIENT_STOCK);
    await expect(page).toHaveURL(/\/adjustments\/new$/);
    expect(await adjustmentCount(loc.id)).toBe(adjustments);
    expect(await onHand(product.variantId, loc.id)).toBe(5000);
    expect(await ledger(product.variantId, loc.id)).toHaveLength(1);

    // 'Set to' the current value is nothing to adjust: rejected, nothing posted.
    await chooseReason(page, "CORRECTION");
    await page.getByLabel(mn.adjustments.note).fill(`${t} ижил`);
    await pickProduct(page, product);
    await page
      .getByLabel(mn.adjustments.form.mode, { exact: true })
      .selectOption({ label: mn.adjustments.form.modeSet });
    await setInput(page).fill("5");
    await submitAdjustment(page);
    await expect(formAlert(page)).toHaveText(mn.errors.VALIDATION);
    expect(await adjustmentCount(loc.id)).toBe(adjustments);
    await setInput(page).fill("-1");
    await submitAdjustment(page);
    await expect(page.locator("#adj-qty-" + product.variantId + "-error")).toHaveText(
      mn.validation.invalidQty,
    );

    // Exactly the balance is allowed, and then zero is the floor.
    await adjust(page, product, { reason: "DAMAGED", qty: "5", note: `${t} бүгд` });
    expect(await onHand(product.variantId, loc.id)).toBe(0);
    await page.goto("/inventory/adjustments/new");
    await chooseReason(page, "DAMAGED");
    await pickProduct(page, product);
    await qtyInput(page).fill("1");
    await submitAdjustment(page);
    await expect(formAlert(page)).toHaveText(mn.errors.INSUFFICIENT_STOCK);
    expect(await onHand(product.variantId, loc.id)).toBe(0);
    await expectLedgerConsistent(product.variantId, loc.id);
    expect(await adjustmentCount(loc.id)).toBe(adjustments + 1);
  });

  test("fractional units, and a double click posts once", async ({ page }) => {
    const t = token();
    const loc = await mainLocation();
    const meat = await createProduct({
      name: `${t} мах`,
      unit: "KG",
      locationId: loc.id,
      onHandMilli: 4000,
      reorderPointMilli: 1000,
    });

    await signInOwner(page);
    await page.goto("/inventory/adjustments/new");
    await pickProduct(page, meat);
    // The unit is on the label and a decimal comma is accepted.
    await qtyInput(page, "KG").fill("1,5");
    const before = await adjustmentCount(loc.id);
    await page.getByRole("button", { name: mn.adjustments.form.submit }).dblclick();
    await page.waitForURL(/\/inventory\/adjustments\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("row").filter({ hasText: meat.name })).toContainText(
      `${signed(-1500)} ${mn.units.KG}`,
    );
    expect(await adjustmentCount(loc.id)).toBe(before + 1);
    const entries = await ledger(meat.variantId, loc.id);
    expect(entries).toHaveLength(2);
    expect(entries.at(-1)).toMatchObject({ delta: -1500, balance: 2500 });
    await expectLedgerConsistent(meat.variantId, loc.id);

    await page.goto("/inventory/stock");
    await searchStock(page, t);
    await expect(stockRow(page, meat.name).getByRole("cell").nth(1)).toHaveText(
      qtyText(2500, "KG"),
    );
    // "1.0005" has too many decimals for a weighed item.
    await page.goto("/inventory/adjustments/new");
    await pickProduct(page, meat);
    await qtyInput(page, "KG").fill("1.0005");
    await submitAdjustment(page);
    await expect(page.locator("#adj-qty-" + meat.variantId + "-error")).toHaveText(
      mn.validation.invalidQty,
    );
  });
});

test.describe("dashboard low-stock card", () => {
  test("appears below the reorder point, links to the filtered list, clears when restocked", async ({
    page,
  }) => {
    const health = watchHealth(page);
    const t = token();
    const loc = await mainLocation();
    // An id of zeros sorts first among equally depleted items, so the card shows it.
    const product = await createProduct({
      name: `${t} тос`,
      variantId: `00000000-0000-4000-8000-${t}${t}`.slice(0, 36),
      locationId: loc.id,
      onHandMilli: 6000,
      reorderPointMilli: 5000,
    });
    const cardLink = (p: Page) => p.locator(`a[href^="/inventory/stock/${product.variantId}"]`);

    await signInOwner(page);
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: mn.inventory.lowStock.title })).toBeVisible();
    await expect(cardLink(page)).toHaveCount(0); // 6 > 5: not low

    // Take it to the reorder point exactly (≤ is low) through the UI.
    await adjust(page, product, { reason: "DAMAGED", qty: "1", note: `${t} тос` });
    await page.getByRole("link", { name: mn.nav.dashboard }).first().click();
    await expect(page).toHaveURL(/\/dashboard$/);
    await expect(cardLink(page)).toHaveCount(1);
    await expect(cardLink(page)).toContainText(product.name);
    await expect(cardLink(page)).toContainText(
      msg(mn.inventory.lowStock.level, { qty: num(5000), point: qtyText(5000) }),
    );

    // The card links to the ledger of that item…
    await cardLink(page).click();
    await expect(page).toHaveURL(new RegExp(`/inventory/stock/${product.variantId}`));
    await expect(page.getByText(mn.inventory.low, { exact: true }).first()).toBeVisible();

    // …and "view all" to the low-stock list, which contains it.
    await page.goto("/dashboard");
    await page.getByRole("link", { name: mn.inventory.lowStock.viewAll }).click();
    await expect(page).toHaveURL(/\/inventory\/stock\?low=1/);
    await expect(page.getByLabel(mn.inventory.lowOnly)).toBeChecked();
    await searchStock(page, t, { low: true });
    await expect(stockRow(page, product.name)).toBeVisible();

    // Restock above the reorder point: it leaves the card.
    await adjust(page, product, { reason: "FOUND", qty: "10", note: `${t} нөхсөн` });
    await page.goto("/dashboard");
    await expect(cardLink(page)).toHaveCount(0);
    health.expectClean();
  });
});

test.describe("locations and permissions", () => {
  test("second location: picker, per-location stock, restricted staff, card link", async ({
    browser,
    page,
  }) => {
    const t = token();
    const main = await mainLocation();
    const second = await createLocation(t);
    const product = await createProduct({
      name: `${t} сав`,
      variantId: `00000000-0000-4000-8000-${t}${t}`.slice(0, 36),
      locationId: second.id,
      onHandMilli: 2000,
      reorderPointMilli: 5000,
    });
    const restricted = await createStaff({ role: "MANAGER", locationIds: [main.id], suffix: t });

    await signInOwner(page);

    // The dashboard card lists the item and its links point at the right branch.
    await page.goto("/dashboard");
    const cardLink = page.locator(
      `a[href="/inventory/stock/${product.variantId}?location=${second.id}"]`,
    );
    await expect(cardLink).toBeVisible();
    await page.getByRole("link", { name: mn.inventory.lowStock.viewAll }).click();
    await expect(page).toHaveURL(/\/inventory\/stock\?.*low=1/);
    // The low-stock list lands on the branch where the shortage is.
    await expect(stockRow(page, product.name)).toBeVisible();
    await expect(page.getByLabel(mn.inventory.location, { exact: true })).toHaveValue(second.id);

    // Location picker: the same item reads 0 in the other branch.
    const picker = page.getByLabel(mn.inventory.location, { exact: true });
    await expect(picker.locator("option")).toHaveCount(2);
    await picker.selectOption(main.id);
    await page.getByLabel(mn.inventory.lowOnly).uncheck();
    await searchStock(page, t);
    await expect(stockRow(page, product.name).getByRole("cell").nth(1)).toHaveText(qtyText(0));
    await picker.selectOption(second.id);
    await page.getByRole("button", { name: mn.inventory.apply }).click();
    await expect(stockRow(page, product.name).getByRole("cell").nth(1)).toHaveText(qtyText(2000));

    // Changing the branch on the adjustment form drops lines (balances belong to the old one).
    await page.goto("/inventory/adjustments/new");
    await pickProduct(page, product);
    await expect(qtyInput(page)).toHaveCount(1);
    await page.getByLabel(mn.adjustments.location, { exact: true }).selectOption(second.id);
    await expect(page.getByText(mn.adjustments.form.noLines)).toBeVisible();
    await chooseReason(page, "FOUND");
    await pickProduct(page, product);
    await expect(
      page.getByText(msg(mn.adjustments.form.current, { qty: qtyText(2000) })),
    ).toBeVisible();
    await qtyInput(page).fill("10");
    await submitAdjustment(page);
    await page.waitForURL(/\/inventory\/adjustments\/[0-9a-f-]{36}$/);
    const adjustmentId = new URL(page.url()).pathname.split("/").pop()!;
    await expect(page.getByText(second.name).first()).toBeVisible();
    expect(await onHand(product.variantId, second.id)).toBe(12000);
    expect(await onHand(product.variantId, main.id)).toBe(0);
    await expectLedgerConsistent(product.variantId, second.id);

    // Restocked above the reorder point: gone from the card.
    await page.goto("/dashboard");
    await expect(cardLink).toHaveCount(0);

    // Staff limited to the main branch cannot see the other one's stock or documents.
    const context = await browser.newContext({ locale: "mn-MN", timezoneId: "Asia/Ulaanbaatar" });
    const other = await context.newPage();
    await signInWithPassword(other, restricted.email);
    await other.goto("/inventory/stock");
    await expect(other.getByRole("heading", { name: mn.inventory.title, level: 1 })).toBeVisible();
    await expect(other.getByLabel(mn.inventory.location, { exact: true })).toHaveCount(0);
    await other.goto(`/inventory/stock?location=${second.id}`);
    await searchStock(other, t);
    await expect(stockRow(other, product.name).getByRole("cell").nth(1)).toHaveText(qtyText(0));
    await other.goto(`/inventory/stock/${product.variantId}?location=${second.id}`);
    await expect(other.getByText(main.name).first()).toBeVisible();
    await expect(other.getByText(second.name)).toHaveCount(0);
    await expect(other.getByText(mn.inventory.ledgerEmpty)).toBeVisible();
    await other.goto(`/inventory/adjustments/${adjustmentId}`);
    await expect(other.getByRole("heading", { name: mn.states.notFoundTitle })).toBeVisible();
    await other.goto("/inventory/adjustments");
    await expect(other.getByRole("link", { name: shortId(adjustmentId) })).toHaveCount(0);
    await other.goto("/inventory/adjustments/new");
    await expect(
      other.getByLabel(mn.adjustments.location, { exact: true }).locator("option"),
    ).toHaveCount(1);
    await context.close();
  });

  test("cashier: read-only stock, no costs, plain-text references, no adjustments", async ({
    page,
  }) => {
    const t = token();
    const loc = await mainLocation();
    const cashier = await createStaff({ role: "CASHIER", locationIds: [loc.id], suffix: t });
    const product = await createProduct({
      name: `${t} чийдэн`,
      locationId: loc.id,
      onHandMilli: 10000,
    });
    const refs = await addReferencedMovements(product.variantId, loc.id, t, 10000);

    // The owner leaves an adjustment behind so the ledger has a third reference type.
    await signInOwner(page);
    const adjustmentId = await adjust(page, product, {
      reason: "DAMAGED",
      qty: "1",
      note: `${t} х`,
    });

    const context = await page.context().browser()!.newContext({
      locale: "mn-MN",
      timezoneId: "Asia/Ulaanbaatar",
    });
    const till = await context.newPage();
    await signInWithPassword(till, cashier.email);
    await till.goto("/inventory/stock");
    await expect(till.getByRole("heading", { name: mn.inventory.title, level: 1 })).toBeVisible();
    await expect(till.getByRole("link", { name: mn.nav.adjustments })).toHaveCount(0);
    await searchStock(till, t);
    await expect(stockRow(till, product.name)).toBeVisible();
    await expect(till.getByRole("columnheader", { name: mn.inventory.avgCost })).toHaveCount(0);
    await expect(till.getByRole("columnheader", { name: mn.inventory.value })).toHaveCount(0);

    await stockRow(till, product.name).getByRole("link", { name: product.name }).click();
    await expect(
      till.getByRole("heading", { name: msg(mn.inventory.historyFor, { name: product.name }) }),
    ).toBeVisible();
    await expect(till.getByRole("columnheader", { name: mn.inventory.col.unitCost })).toHaveCount(
      0,
    );
    // References are plain text for a role that can't open their targets.
    const texts = [
      msg(mn.inventory.ref.adjustment, { id: shortId(adjustmentId) }),
      msg(mn.inventory.ref.goodsReceipt, { number: refs.receiptNumber }),
      msg(mn.inventory.ref.stocktake, { number: refs.stocktakeNumber }),
    ];
    for (const text of texts) {
      await expect(till.getByText(text)).toBeVisible();
      await expect(till.getByRole("link", { name: text })).toHaveCount(0);
    }
    await expect(till.getByRole("row").nth(1).getByRole("link")).toHaveCount(0);

    // Every manager-only page is forbidden, including direct links to documents.
    for (const path of [
      "/inventory/adjustments",
      "/inventory/adjustments/new",
      `/inventory/adjustments/${adjustmentId}`,
      "/inventory/stocktakes",
      `/inventory/stocktakes/${refs.stocktakeId}`,
      `/purchasing/receipts/${refs.receiptId}`,
    ]) {
      await till.goto(path);
      await expect(till, path).toHaveURL(/\/forbidden$/);
    }
    // The dashboard still shows the low-stock card (inventory.view).
    await till.goto("/dashboard");
    await expect(till.getByRole("heading", { name: mn.inventory.lowStock.title })).toBeVisible();
    await context.close();
  });

  test("manager: adjusts stock, sees costs and working reference links", async ({ page }) => {
    const t = token();
    const loc = await mainLocation();
    const manager = await createStaff({ role: "MANAGER", locationIds: [loc.id], suffix: t });
    const product = await createProduct({
      name: `${t} ваар`,
      locationId: loc.id,
      onHandMilli: 10000,
      cost: 1500,
    });
    const refs = await addReferencedMovements(product.variantId, loc.id, t, 10000);

    await signInWithPassword(page, manager.email);
    await expect(page.getByRole("link", { name: mn.nav.adjustments }).first()).toBeVisible();
    const adjustmentId = await adjust(page, product, {
      reason: "DAMAGED",
      qty: "2",
      note: `${t} м`,
    });
    await expect(page.getByRole("main").getByText(manager.name)).toBeVisible(); // recorded under the manager
    expect(await onHand(product.variantId, loc.id)).toBe(refs.balanceMilli - 2000);
    // The cost impact is visible to managers: −2 × 1 500 = −3 000.
    await expect(page.getByText(`${mn.adjustments.totalValue}: -30₮`)).toBeVisible();

    await page.goto(`/inventory/stock/${product.variantId}?location=${loc.id}`);
    await expect(page.getByRole("columnheader", { name: mn.inventory.col.unitCost })).toBeVisible();
    const adjustmentRow = page.getByRole("row").filter({ hasText: `${t} м` });
    await expect(adjustmentRow).toContainText(manager.name);
    await adjustmentRow.getByRole("link").click();
    await expect(page).toHaveURL(new RegExp(`/inventory/adjustments/${adjustmentId}$`));
    await page.goBack();
    await page
      .getByRole("link", {
        name: msg(mn.inventory.ref.goodsReceipt, { number: refs.receiptNumber }),
      })
      .click();
    await expect(page).toHaveURL(new RegExp(`/purchasing/receipts/${refs.receiptId}$`));
    await page.goBack();
    await page
      .getByRole("link", {
        name: msg(mn.inventory.ref.stocktake, { number: refs.stocktakeNumber }),
      })
      .click();
    await expect(page).toHaveURL(new RegExp(`/inventory/stocktakes/${refs.stocktakeId}$`));
  });
});

test.describe("phone width", () => {
  test("no horizontal overflow, console errors or failed requests", async ({ page }) => {
    const health = watchHealth(page);
    const t = token();
    const loc = await mainLocation();
    const product = await createProduct({
      name: `${t} урт нэртэй бараа харагдац шалгах`,
      sku: `PH-${t}`,
      locationId: loc.id,
      onHandMilli: 10000,
      reorderPointMilli: 20000,
    });
    const refs = await addReferencedMovements(product.variantId, loc.id, t, 10000);

    await page.setViewportSize(PHONE);
    await signInOwner(page);
    const adjustmentId = await adjust(page, product, {
      reason: "CORRECTION",
      qty: "-1",
      note: `${t} утасны тэмдэглэл маш урт тэмдэглэл`,
    });
    await expectNoHorizontalOverflow(page); // adjustment detail

    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: mn.inventory.lowStock.title })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto("/inventory/stock");
    await searchStock(page, t);
    await expect(stockRow(page, product.name)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto(`/inventory/stock/${product.variantId}?location=${loc.id}`);
    await expect(page.getByText(`${t} утасны`)).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto("/inventory/adjustments");
    await expect(page.getByRole("link", { name: shortId(adjustmentId) })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.goto("/inventory/adjustments/new");
    await chooseReason(page, "CORRECTION");
    await pickProduct(page, product);
    await qtyInput(page).fill("abc");
    await submitAdjustment(page);
    await expect(formAlert(page)).toHaveText(mn.adjustments.form.fixLines);
    await expectNoHorizontalOverflow(page);

    // Reference pages reachable from the ledger stay clean too.
    await page.goto(`/purchasing/receipts/${refs.receiptId}`);
    await expect(page.getByRole("heading", { name: refs.receiptNumber })).toBeVisible();
    health.expectClean();
  });
});
