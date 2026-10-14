import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { mn, SEED, signInWithPassword, signOut, enterPin } from "./fixtures";
import {
  createFixture,
  expectNoHorizontalOverflow,
  externalMovement,
  fmt,
  movements,
  newToken,
  onHand,
  OPENING,
  retireFixture,
  stocktakeById,
  stocktakeMovementCount,
  stocktakesByNote,
  watchPage,
  type Fixture,
  type Item,
  type Started,
} from "./helpers/stocktake";

const t = mn.stocktakes;
const token = newToken();
let fx: Fixture;
let ownerState: Awaited<ReturnType<BrowserContext["storageState"]>>;

const DETAIL_URL = /\/inventory\/stocktakes\/[0-9a-f-]{36}(\?.*)?$/;

async function newOwnerContext(browser: Browser) {
  return browser.newContext({ storageState: ownerState });
}

/** Start a count through the real dialog; resolves once the count screen opens. */
async function startViaUi(page: Page, opts: { category?: string; note: string }): Promise<Started> {
  await page.goto("/inventory/stocktakes");
  await page.getByRole("button", { name: t.new }).click();
  const dialog = page.getByRole("dialog", { name: t.createTitle });
  if (opts.category) {
    await dialog
      .getByLabel(t.scope)
      .selectOption({ label: fmt(t.scopeCategory, { name: opts.category }) });
  }
  await dialog.getByLabel(t.note).fill(opts.note);
  await dialog.getByRole("button", { name: t.start }).click();
  await expect(page).toHaveURL(DETAIL_URL);
  const url = page.url();
  const id = /stocktakes\/([0-9a-f-]{36})/.exec(url)![1]!;
  const rows = await stocktakesByNote(opts.note);
  return { id, number: rows[0]!.number, url };
}

const qtyInput = (page: Page, item: Item) => page.getByLabel(fmt(t.qtyLabel, { name: item.name }));
const rowOf = (page: Page, item: Item) => page.getByRole("listitem").filter({ hasText: item.name });
const scanBox = (page: Page) => page.locator("#stocktake-scan");
const feedback = (page: Page) => page.locator("#stocktake-scan-feedback");

async function scan(page: Page, code: string) {
  await scanBox(page).fill(code);
  await scanBox(page).press("Enter");
}

async function typeCount(page: Page, item: Item, text: string) {
  const input = qtyInput(page, item);
  await input.fill(text);
  await input.press("Enter");
}

async function finalizeViaUi(page: Page) {
  await page.getByRole("button", { name: t.finalize }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: t.finalize }).click();
}

const stat = (page: Page, label: string) =>
  page.locator("dt").filter({ hasText: label }).locator("xpath=..");
const reviewTable = (page: Page) => page.getByRole("table");
const tableRow = (page: Page, item: Item) =>
  reviewTable(page).getByRole("row").filter({ hasText: item.name });

/** Check a page at phone width, then put the tablet viewport back. */
async function expectMobileFit(page: Page) {
  const before = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await expectNoHorizontalOverflow(page);
  } finally {
    if (before) await page.setViewportSize(before);
  }
}

test.describe("stocktake", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({ browser }) => {
    fx = await createFixture(token);
    const context = await browser.newContext();
    const page = await context.newPage();
    await signInWithPassword(page, SEED.owner.email);
    ownerState = await context.storageState();
    await context.close();
  });

  test.afterAll(async () => {
    await retireFixture(token);
  });

  test.use({ storageState: undefined });

  // ---------------------------------------------------------------------------
  // Shared across the serial tests below.
  const first = { note: `Тооллого ${token} A`, id: "", number: "", url: "" };
  const baseline = {} as Record<"pieceA" | "pieceB" | "weighed", number>;

  test("start a category-scoped count: one stocktake despite a double click, blind count screen", async ({
    browser,
  }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);

    await page.goto("/dashboard");
    await page.getByRole("link", { name: mn.nav.stocktakes }).first().click();
    await expect(page).toHaveURL(/\/inventory\/stocktakes$/);
    await expect(page.getByRole("heading", { name: t.title, level: 1 })).toBeVisible();

    await page.getByRole("button", { name: t.new }).click();
    const dialog = page.getByRole("dialog", { name: t.createTitle });
    await dialog
      .getByLabel(t.scope)
      .selectOption({ label: fmt(t.scopeCategory, { name: fx.category.name }) });
    await dialog.getByLabel(t.note).fill(first.note);
    // A double click must not start two counts.
    await dialog.getByRole("button", { name: t.start }).dblclick();
    await expect(page).toHaveURL(DETAIL_URL);
    first.url = page.url();
    first.id = /stocktakes\/([0-9a-f-]{36})/.exec(first.url)![1]!;

    const rows = await stocktakesByNote(first.note);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    first.number = row!.number;
    expect(row!.status).toBe("IN_PROGRESS");
    expect(row!.categoryId).toBe(fx.category.id);
    // Only active, stock-tracked items of that category; archived and other-category items are out.
    expect(row!.lines.map((l) => l.variantId).sort()).toEqual(
      [fx.pieceA.variantId, fx.pieceB.variantId, fx.weighed.variantId].sort(),
    );
    expect(row!.lines.every((l) => l.countedMilli === null)).toBe(true);
    expect(row!.lines.find((l) => l.variantId === fx.pieceA.variantId)!.expectedMilli).toBe(
      OPENING.pieceA,
    );

    await expect(page.getByRole("heading", { name: first.number, level: 1 })).toBeVisible();
    await expect(page.getByText(fx.category.name).first()).toBeVisible();
    await expect(page.getByText(fmt(t.counts, { counted: 0, total: 3 }))).toBeVisible();
    for (const item of [fx.pieceA, fx.pieceB, fx.weighed]) {
      await expect(rowOf(page, item)).toBeVisible();
      // Blind count: nothing pre-filled, no expected quantity anywhere.
      await expect(qtyInput(page, item)).toHaveValue("");
      await expect(rowOf(page, item)).toContainText(t.notCounted);
    }
    await expect(page.getByText(fx.archived.name)).toHaveCount(0);
    await expect(page.getByText(fx.outside.name)).toHaveCount(0);
    for (const hidden of [t.expected, t.variance]) {
      await expect(page.getByText(hidden, { exact: true })).toHaveCount(0);
    }
    await expectMobileFit(page);

    // The list shows it as running with its progress.
    await page.getByRole("link", { name: t.backToList }).first().click();
    const listRow = page.getByRole("row").filter({ hasText: first.number });
    await expect(listRow).toContainText(t.statusIN_PROGRESS);
    await expect(listRow).toContainText(fx.category.name);
    await expect(listRow).toContainText(fmt(t.progressValue, { counted: 0, total: 3 }));
    await expectMobileFit(page);

    watch.expectNone();
    await context.close();
  });

  test("counting: scans, weighed decimals, validation, autosave across reload", async ({
    browser,
  }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);
    await page.goto(first.url);
    await expect(scanBox(page)).toBeFocused();

    // A scan of a piece item adds one; rapid scans keep their order.
    await scan(page, fx.pieceA.barcode);
    await expect(feedback(page)).toContainText(fx.pieceA.name);
    await expect(feedback(page)).toContainText(t.scanCounted.split("{qty}")[1]!.trim());
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("1");
    for (let i = 0; i < 3; i++) {
      await scanBox(page).fill(fx.pieceA.barcode);
      await scanBox(page).press("Enter");
    }
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("4");
    await expect(rowOf(page, fx.pieceA)).toContainText(t.saved);

    // By SKU as well.
    await scan(page, fx.pieceB.sku);
    await expect(qtyInput(page, fx.pieceB)).toHaveValue("1");

    // Unknown and archived codes: a clear message, nothing counted.
    const unknown = `NOPE-${token}`;
    await scan(page, unknown);
    await expect(feedback(page)).toHaveText(fmt(t.scanNone, { code: unknown }));
    await scan(page, fx.archived.barcode);
    await expect(feedback(page)).toHaveText(fmt(t.scanNone, { code: fx.archived.barcode }));
    await expect(page.getByText(fx.archived.name)).toHaveCount(0);

    // A name search offers a choice (never auto-counts); archived items are not offered.
    await scan(page, token);
    const choices = page.getByRole("list", { name: t.scanChoose });
    await expect(choices).toBeVisible();
    await expect(choices.getByRole("button", { name: fx.archived.name })).toHaveCount(0);
    await choices.getByRole("button", { name: fx.pieceB.name }).click();
    await expect(qtyInput(page, fx.pieceB)).toHaveValue("2");
    await expect(choices).toHaveCount(0);

    // Weighed items: the scan asks for the quantity and focuses the field.
    await scan(page, fx.weighed.sku);
    await expect(feedback(page)).toHaveText(fmt(t.scanEnter, { name: fx.weighed.name }));
    await expect(qtyInput(page, fx.weighed)).toBeFocused();
    await expect(qtyInput(page, fx.weighed)).toHaveValue("");
    await expect(
      rowOf(page, fx.weighed).getByRole("button", {
        name: fmt(t.plusOne, { name: fx.weighed.name }),
      }),
    ).toHaveCount(0);
    await typeCount(page, fx.weighed, "2,35");
    await expect(rowOf(page, fx.weighed)).toContainText(t.saved);
    await expect(qtyInput(page, fx.weighed)).toHaveValue("2.35");
    await expect(scanBox(page)).toBeFocused();

    // Validation sits next to the field, in Mongolian, and nothing is saved.
    for (const bad of ["1.5", "abc", "-2"]) {
      await typeCount(page, fx.pieceA, bad);
      await expect(rowOf(page, fx.pieceA)).toContainText(t.invalidQty);
      await expect(qtyInput(page, fx.pieceA)).toHaveAttribute("aria-invalid", "true");
    }
    await typeCount(page, fx.weighed, "1.2345");
    await expect(rowOf(page, fx.weighed)).toContainText(t.invalidQty);
    const line = (await stocktakeById(first.id)).lines.find(
      (l) => l.variantId === fx.pieceA.variantId,
    )!;
    expect(line.countedMilli).toBe(4000);

    // +/- buttons; an explicit zero is a real count; clearing un-counts.
    await typeCount(page, fx.pieceA, "5");
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("5");
    await rowOf(page, fx.pieceA)
      .getByRole("button", { name: fmt(t.plusOne, { name: fx.pieceA.name }) })
      .click();
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("6");
    await rowOf(page, fx.pieceA)
      .getByRole("button", { name: fmt(t.minusOne, { name: fx.pieceA.name }) })
      .click();
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("5");
    await typeCount(page, fx.pieceB, "0");
    await expect(rowOf(page, fx.pieceB)).toContainText(t.saved);
    await expect(rowOf(page, fx.pieceB)).not.toContainText(t.notCounted);
    await typeCount(page, fx.pieceB, "");
    await expect(rowOf(page, fx.pieceB)).toContainText(t.notCounted);
    await expect(qtyInput(page, fx.pieceB)).toHaveValue("");

    // Filters.
    await page.getByLabel(t.filterLabel).selectOption("uncounted");
    await expect(rowOf(page, fx.pieceB)).toBeVisible();
    await expect(rowOf(page, fx.pieceA)).toHaveCount(0);
    await page.getByLabel(t.filterLabel).selectOption("counted");
    await expect(rowOf(page, fx.pieceB)).toHaveCount(0);
    await expect(rowOf(page, fx.pieceA)).toBeVisible();
    await page.getByLabel(t.filterLabel).selectOption("all");
    await page.getByLabel(t.searchLabel).fill("zzz-no-such-item");
    await expect(page.getByText(t.noMatches)).toBeVisible();
    await page.getByLabel(t.searchLabel).fill(fx.pieceB.name);
    await expect(rowOf(page, fx.pieceB)).toBeVisible();
    await expect(rowOf(page, fx.pieceA)).toHaveCount(0);
    await page.getByLabel(t.searchLabel).fill("");

    await typeCount(page, fx.pieceB, "2");
    await expect(rowOf(page, fx.pieceB)).toContainText(t.saved);
    await expectMobileFit(page);

    // Autosave: a reload (and back/forward) keeps every count; the DB agrees.
    await page.reload();
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("5");
    await expect(qtyInput(page, fx.pieceB)).toHaveValue("2");
    await expect(qtyInput(page, fx.weighed)).toHaveValue("2.35");
    await expect(page.getByText(fmt(t.counts, { counted: 3, total: 3 }))).toBeVisible();
    await page.goto("/inventory/stocktakes");
    await page.goBack();
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("5");

    const saved = await stocktakeById(first.id);
    const counted = Object.fromEntries(saved.lines.map((l) => [l.variantId, l.countedMilli]));
    expect(counted).toEqual({
      [fx.pieceA.variantId]: 5000,
      [fx.pieceB.variantId]: 2000,
      [fx.weighed.variantId]: 2350,
    });
    // Counting alone never moves stock.
    expect(await onHand(fx.pieceA.variantId)).toBe(OPENING.pieceA);
    expect(await stocktakeMovementCount(first.id)).toBe(0);

    watch.expectNone();
    await context.close();
  });

  test("review uses the count-time balance, keeps movements made during the count, finalize posts", async ({
    browser,
  }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);

    // While the count is open: a sale of 3 A and a receipt of 1 kg of the weighed item.
    await externalMovement(fx.pieceA.variantId, fx.locationId, -3000, "SALE");
    await externalMovement(fx.weighed.variantId, fx.locationId, 1000, "PURCHASE_RECEIPT");
    baseline.pieceA = await onHand(fx.pieceA.variantId);
    baseline.pieceB = await onHand(fx.pieceB.variantId);
    baseline.weighed = await onHand(fx.weighed.variantId);
    expect(baseline).toEqual({ pieceA: 7000, pieceB: 5000, weighed: 4500 });

    await page.goto(first.url);
    await page.getByRole("link", { name: t.tabReview, exact: true }).click();
    await expect(page).toHaveURL(/view=review/);
    await expect(page.getByRole("heading", { name: t.reviewHeading })).toBeVisible();
    await expect(page.getByText(t.varianceNote)).toBeVisible();

    // Owner sees values (view_costs). Shelf had 5 of 10 expected when counted: -5, regardless of the later sale.
    await expect(reviewTable(page).getByRole("columnheader", { name: t.value })).toBeVisible();
    const a = tableRow(page, fx.pieceA).getByRole("cell");
    const b = tableRow(page, fx.pieceB).getByRole("cell");
    const w = tableRow(page, fx.weighed).getByRole("cell");
    await expect(a.nth(1)).toContainText("10");
    await expect(a.nth(1)).toContainText(fmt(t.liveNote, { qty: "7" }));
    await expect(b.nth(1)).not.toContainText(fmt(t.liveNote, { qty: "" }).trim().slice(0, 12));
    await expect(a.nth(2)).toHaveText("5");
    await expect(a.nth(3)).toHaveText(/[-−]5/);
    await expect(a.nth(4)).toHaveText(/[-−]5[,\s]?000/); // -5 x 1,000₮ = -5,000₮
    await expect(b.nth(3)).toHaveText(/[-−]3/);
    await expect(w.nth(3)).toHaveText(/[-−]1[.,]15/);
    // Net = -5,000 - 6,000 - 11,500 = -22,500₮
    await expect(stat(page, t.summaryNet)).toContainText(/[-−]22[,\s]?500/);
    await expect(stat(page, t.summaryUncounted)).toContainText("0");
    await expectMobileFit(page);

    // Nothing uncounted: no policy checkbox.
    await expect(page.getByRole("checkbox", { name: t.countAll })).toHaveCount(0);

    await finalizeViaUi(page);
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: fmt(t.finalized, { posted: 3, unchanged: 0 }) }),
    ).toBeVisible();

    // Completed and read-only.
    await expect(page.getByText(t.lockedNote)).toBeVisible();
    await expect(page.getByText(t.statusCOMPLETED).first()).toBeVisible();
    await expect(page.getByRole("button", { name: t.finalize })).toHaveCount(0);
    await expect(page.getByRole("button", { name: t.cancel })).toHaveCount(0);
    await expect(page.getByRole("link", { name: t.tabReview, exact: true })).toHaveCount(0);
    await expect(scanBox(page)).toHaveCount(0);
    await expect(page.getByRole("columnheader", { name: t.expected })).toBeVisible();
    await expectMobileFit(page);
    await expect(tableRow(page, fx.pieceA).getByRole("cell").nth(3)).toHaveText(/[-−]5/);
    await page.goto(first.url.split("?")[0]! + "?view=review");
    await expect(scanBox(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: t.finalize })).toHaveCount(0);

    // Ledger: delta posted (counted - expected at count time) on top of the sale/receipt.
    expect(await onHand(fx.pieceA.variantId)).toBe(2000); // 10 -3 sold -5 shrink
    expect(await onHand(fx.pieceB.variantId)).toBe(2000);
    expect(await onHand(fx.weighed.variantId)).toBe(3350); // 3.5 +1 received -1.15
    const ledgerA = await movements(fx.pieceA.variantId);
    expect(ledgerA.map((m) => [m.type, m.qtyDeltaMilli])).toEqual([
      ["OPENING", 10000],
      ["SALE", -3000],
      ["STOCKTAKE", -5000],
    ]);
    expect(ledgerA.at(-1)!.stocktakeId).toBe(first.id);
    expect(ledgerA.at(-1)!.balanceAfterMilli).toBe(2000);
    expect(await stocktakeMovementCount(first.id)).toBe(3);
    // Out-of-scope items untouched.
    expect(await onHand(fx.outside.variantId)).toBe(OPENING.outside);
    expect(await onHand(fx.archived.variantId)).toBe(4000);
    const done = await stocktakeById(first.id);
    expect(done.status).toBe("COMPLETED");
    expect(done.lines.find((l) => l.variantId === fx.pieceA.variantId)!.varianceMilli).toBe(-5000);
    baseline.pieceA = 2000;
    baseline.pieceB = 2000;
    baseline.weighed = 3350;

    // The stock history links back to the stocktake.
    await page.goto(`/inventory/stock/${fx.pieceA.variantId}`);
    await expect(
      page.getByRole("link", { name: fmt(mn.inventory.ref.stocktake, { number: first.number }) }),
    ).toBeVisible();
    await expectMobileFit(page);

    watch.expectNone();
    await context.close();
  });

  test("double finalize / cancel after completion are refused in the UI, stock moves once", async ({
    browser,
  }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);
    const note = `Тооллого ${token} B`;
    const second = await startViaUi(page, { category: fx.category.name, note });

    // Two more tabs on the same open count: a stale count screen and a stale review.
    const staleCount = await context.newPage();
    await staleCount.goto(second.url);
    const staleReview = await context.newPage();
    await staleReview.goto(second.url + "?view=review");
    await expect(staleReview.getByRole("button", { name: t.finalize })).toBeVisible();

    await scan(page, fx.pieceA.barcode); // count A = 1 (on hand 2 -> variance -1)
    await expect(qtyInput(page, fx.pieceA)).toHaveValue("1");
    await page.getByRole("link", { name: t.tabReview, exact: true }).click();
    await finalizeViaUi(page);
    await expect(page.getByText(t.lockedNote)).toBeVisible();
    expect(await onHand(fx.pieceA.variantId)).toBe(1000);
    const moves = await stocktakeMovementCount(second.id);
    expect(moves).toBe(1);

    // Second finalize from the stale review tab.
    await finalizeViaUi(staleReview);
    await expect(staleReview.locator("[data-sonner-toast][data-type=error]")).toContainText(
      mn.errors.INVALID_STATE,
    );
    await expect(staleReview.locator("[data-sonner-toast][data-type=success]")).toHaveCount(0);
    // ... and cancel.
    await staleReview.getByRole("button", { name: t.cancel }).click();
    await staleReview.getByRole("alertdialog").getByRole("button", { name: t.cancel }).click();
    await expect(staleReview.locator("[data-sonner-toast][data-type=error]").last()).toContainText(
      mn.errors.INVALID_STATE,
    );

    // The stale count screen cannot change a completed count either.
    await typeCount(staleCount, fx.pieceB, "9");
    await expect(rowOf(staleCount, fx.pieceB)).toContainText(mn.errors.INVALID_STATE);
    await scan(staleCount, fx.pieceB.barcode);
    await expect(feedback(staleCount)).toHaveText(mn.errors.INVALID_STATE);

    expect(await onHand(fx.pieceA.variantId)).toBe(1000);
    expect(await onHand(fx.pieceB.variantId)).toBe(2000);
    expect(await stocktakeMovementCount(second.id)).toBe(moves);
    const state = await stocktakeById(second.id);
    expect(state.status).toBe("COMPLETED");
    expect(state.lines.find((l) => l.variantId === fx.pieceB.variantId)!.countedMilli).toBeNull();

    watch.expectNone();
    await context.close();
  });

  test("uncounted items are left alone by default", async ({ browser }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);
    const st = await startViaUi(page, { category: fx.category.name, note: `Тооллого ${token} C` });

    await typeCount(page, fx.pieceA, "4");
    await expect(rowOf(page, fx.pieceA)).toContainText(t.saved);
    await page.getByRole("link", { name: t.tabReview, exact: true }).click();

    // Uncounted rows show "not counted" and no variance; the policy checkbox appears, off by default.
    await expect(stat(page, t.summaryUncounted)).toContainText("2");
    const b = tableRow(page, fx.pieceB).getByRole("cell");
    await expect(b.nth(2)).toContainText(t.notCounted);
    await expect(b.nth(3)).toHaveText(mn.common.none);
    const countAll = page.getByRole("checkbox", { name: t.countAll });
    await expect(countAll).not.toBeChecked();
    await expect(page.getByText(fmt(t.countAllHelp, { count: 2 }))).toBeVisible();

    await page.getByRole("button", { name: t.finalize }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(fmt(t.finalizeConfirm, { count: 1 }));
    await dialog.getByRole("button", { name: mn.common.cancel }).click();
    // Cancelling the dialog changes nothing.
    expect((await stocktakeById(st.id)).status).toBe("IN_PROGRESS");
    await finalizeViaUi(page);
    await expect(page.getByText(t.lockedNote)).toBeVisible();

    expect(await onHand(fx.pieceA.variantId)).toBe(4000); // 1 -> counted 4: baseline moved by +3
    expect(await onHand(fx.pieceB.variantId)).toBe(2000);
    expect(await onHand(fx.weighed.variantId)).toBe(3350);
    expect(await stocktakeMovementCount(st.id)).toBe(1);
    const done = await stocktakeById(st.id);
    expect(done.lines.filter((l) => l.countedMilli === null)).toHaveLength(2);
    // Completed view: uncounted lines still read as not counted.
    await expect(tableRow(page, fx.pieceB).getByRole("cell").nth(3)).toHaveText(mn.common.none);

    watch.expectNone();
    await context.close();
  });

  test("'count all' zeroes uncounted items against the live balance", async ({ browser }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);
    const st = await startViaUi(page, { category: fx.category.name, note: `Тооллого ${token} D` });

    await typeCount(page, fx.pieceA, "4"); // equals the shelf: matches
    await expect(rowOf(page, fx.pieceA)).toContainText(t.saved);
    // A sale of B during the count; "count all" must still end at zero, not at -1.
    await externalMovement(fx.pieceB.variantId, fx.locationId, -1000, "SALE");

    await page.getByRole("link", { name: t.tabReview, exact: true }).click();
    await page.getByRole("checkbox", { name: t.countAll }).check();
    await page.getByRole("button", { name: t.finalize }).click();
    await expect(page.getByRole("alertdialog")).toContainText(
      fmt(t.finalizeConfirmAll, { count: 3, uncounted: 2 }),
    );
    await page.getByRole("alertdialog").getByRole("button", { name: t.finalize }).click();
    await expect(page.getByText(t.lockedNote)).toBeVisible();
    await expect(
      page
        .locator("[data-sonner-toast]")
        .filter({ hasText: fmt(t.finalized, { posted: 2, unchanged: 1 }) }),
    ).toBeVisible();

    expect(await onHand(fx.pieceA.variantId)).toBe(4000);
    expect(await onHand(fx.pieceB.variantId)).toBe(0);
    expect(await onHand(fx.weighed.variantId)).toBe(0);
    const ledgerW = await movements(fx.weighed.variantId);
    expect(ledgerW.at(-1)).toMatchObject({
      type: "STOCKTAKE",
      qtyDeltaMilli: -3350,
      balanceAfterMilli: 0,
    });
    expect(await stocktakeMovementCount(st.id)).toBe(2);
    const done = await stocktakeById(st.id);
    expect(done.lines.every((l) => l.countedMilli !== null)).toBe(true);
    // Out-of-scope stock is never touched by a scoped count-all.
    expect(await onHand(fx.outside.variantId)).toBe(OPENING.outside);

    watch.expectNone();
    await context.close();
  });

  test("empty scope shows the empty state; a cancelled count changes nothing and is locked", async ({
    browser,
  }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);
    const st = await startViaUi(page, {
      category: fx.emptyCategory.name,
      note: `Тооллого ${token} E`,
    });

    await expect(page.getByText(t.noLines, { exact: true })).toBeVisible();
    await expect(page.getByText(fmt(t.counts, { counted: 0, total: 0 }))).toBeVisible();
    // A name that matches nothing in stock: still no crash, still a message.
    await scan(page, `NOPE-${token}`);
    await expect(feedback(page)).toContainText(`NOPE-${token}`);
    await page.getByRole("link", { name: t.tabReview, exact: true }).click();
    await expect(page.getByText(t.noLines, { exact: true })).toBeVisible();

    await page.getByRole("button", { name: t.cancel }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(t.cancelConfirm);
    await dialog.getByRole("button", { name: mn.common.cancel }).click();
    expect((await stocktakeById(st.id)).status).toBe("IN_PROGRESS");
    await page.getByRole("button", { name: t.cancel }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: t.cancel }).click();
    await expect(
      page.locator("[data-sonner-toast]").filter({ hasText: t.cancelled }),
    ).toBeVisible();
    await expect(page.getByText(t.statusCANCELLED).first()).toBeVisible();
    await expect(page.getByText(t.lockedNote)).toBeVisible();
    await expect(page.getByRole("button", { name: t.finalize })).toHaveCount(0);
    await expect(scanBox(page)).toHaveCount(0);
    expect((await stocktakeById(st.id)).status).toBe("CANCELLED");
    expect(await stocktakeMovementCount(st.id)).toBe(0);

    await page.goto("/inventory/stocktakes");
    await expect(page.getByRole("row").filter({ hasText: st.number })).toContainText(
      t.statusCANCELLED,
    );
    watch.expectNone();
    await context.close();
  });

  test("a full count lists every stocked item; cancelling it leaves all stock untouched", async ({
    browser,
  }) => {
    const context = await newOwnerContext(browser);
    const page = await context.newPage();
    const watch = watchPage(page);
    const before = {
      a: await onHand(fx.pieceA.variantId),
      outside: await onHand(fx.outside.variantId),
    };
    const st = await startViaUi(page, { note: `Тооллого ${token} F` });
    await expect(page.getByText(t.fullCount).first()).toBeVisible();
    const rows = await stocktakeById(st.id);
    expect(rows.categoryId).toBeNull();
    // Full scope includes the out-of-category item but still not the archived one.
    expect(rows.lines.map((l) => l.variantId)).toContain(fx.outside.variantId);
    expect(rows.lines.map((l) => l.variantId)).not.toContain(fx.archived.variantId);
    await scan(page, fx.outside.barcode);
    await expect(qtyInput(page, fx.outside)).toHaveValue("1");
    await expectMobileFit(page);

    await page.getByRole("link", { name: t.tabReview, exact: true }).click();
    await page.getByRole("button", { name: t.cancel }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: t.cancel }).click();
    await expect(page.getByText(t.statusCANCELLED).first()).toBeVisible();
    expect(await onHand(fx.outside.variantId)).toBe(before.outside);
    expect(await onHand(fx.pieceA.variantId)).toBe(before.a);
    expect(await stocktakeMovementCount(st.id)).toBe(0);
    watch.expectNone();
    await context.close();
  });

  test("not-found counts, anonymous visitors and a manager's view", async ({ browser, page }) => {
    // Anonymous: sent to sign-in.
    await page.goto(first.url);
    await expect(page).toHaveURL(/\/login/);

    const context = await newOwnerContext(browser);
    const owner = await context.newPage();
    const watch = watchPage(owner, { ignore: [/stocktakes\/00000000/, /stocktakes\/not-a-uuid/] });
    for (const bad of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
      await owner.goto(`/inventory/stocktakes/${bad}`);
      await expect(owner.getByRole("heading", { name: t.notFound })).toBeVisible();
    }
    watch.expectNone();
    await context.close();

    // A manager has the permission and sees values.
    await signInWithPassword(page, SEED.manager.email);
    await page.goto(first.url);
    await expect(page.getByRole("heading", { name: first.number, level: 1 })).toBeVisible();
    await expect(page.getByRole("columnheader", { name: t.value })).toBeVisible();
    await expect(tableRow(page, fx.pieceA).getByRole("cell").nth(4)).toHaveText(/[-−]5[,\s]?000/);
    await page.goto("/inventory/stocktakes");
    await expect(page.getByRole("button", { name: t.new })).toBeVisible();
  });

  test("a cashier cannot open or act on stocktakes", async ({ page }) => {
    // Pair the device as manager, then switch to the cashier's PIN.
    await signInWithPassword(page, SEED.manager.email);
    await page.goto("/settings/devices");
    await page.getByLabel(mn.devices.name).fill(`E2E stocktake ${token}`);
    await page.getByRole("button", { name: mn.devices.pair }).click();
    await expect(page.getByText(mn.devices.paired)).toBeVisible();
    await signOut(page, SEED.manager.name, mn.auth.signOut);
    await enterPin(page, SEED.cashier.pin);
    await expect(page).toHaveURL(/\/register$/);

    for (const url of ["/inventory/stocktakes", first.url, first.url + "?view=review"]) {
      await page.goto(url);
      await expect(page).toHaveURL(/\/forbidden$/);
      await expect(page.getByRole("heading", { name: mn.states.forbiddenTitle })).toBeVisible();
    }
    // Nothing leaked into the page, and no stocktake nav entry exists.
    await expect(page.getByText(first.number)).toHaveCount(0);
    await expect(page.getByRole("link", { name: mn.nav.stocktakes })).toHaveCount(0);
  });
});
