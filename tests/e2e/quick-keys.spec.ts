import { expect, test, type Page } from "@playwright/test";
import { mn } from "./fixtures";
import {
  expectNoHorizontalOverflow,
  insertCategory,
  insertProducts,
  signInAsCashier,
  signInAsOwner,
  token,
  watchPage,
} from "./helpers/products";
import { withE2eDb } from "./db";

const Q = mn.quickKeys;
const fill = (message: string, values: Record<string, string>) =>
  Object.entries(values).reduce((m, [k, v]) => m.replace(`{${k}}`, v), message);

let watch: ReturnType<typeof watchPage>;
test.beforeEach(async ({ page }) => {
  watch = watchPage(page);
});
test.afterEach(() => {
  watch.expectClean();
});

const rows = (page: Page) => page.getByRole("main").locator("ol > li");
const rowNames = async (page: Page) =>
  (await rows(page).evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")))) as (
    string | null
  )[];
const previewNames = (page: Page) =>
  page.getByTestId("quick-keys-preview").locator("li span.font-semibold").allTextContents();

async function pickProduct(page: Page, name: string) {
  await page.getByRole("combobox", { name: Q.pickerLabel }).fill(name);
  await page.getByRole("option", { name }).first().click();
}

/** A tab nobody else uses, so the test owns the whole grid. */
async function freshTab(page: Page, tok: string) {
  const categoryId = await insertCategory(`QK tab ${tok}`);
  await page.goto(`/catalog/quick-keys?tab=${categoryId}`);
  await expect(page.getByRole("heading", { name: Q.title, level: 1 })).toBeVisible();
  return categoryId;
}

test("owner adds, recolours, reorders and removes keys; the preview follows", async ({ page }) => {
  const tok = token();
  await insertProducts(`QK${tok}`, 3);
  const [a, b, c] = [`QK${tok} 00`, `QK${tok} 01`, `QK${tok} 02`];
  await signInAsOwner(page);
  const categoryId = await freshTab(page, tok);
  await expect(page.getByText(Q.empty)).toBeVisible();

  // Add three keys.
  for (const name of [a, b, c]) {
    await pickProduct(page, name);
    await expect(rows(page).filter({ hasText: name })).toHaveCount(1);
  }
  expect(await rowNames(page)).toEqual([a, b, c]);
  expect(await previewNames(page)).toEqual([a, b, c]);

  // The same product twice is refused with a message.
  await pickProduct(page, a);
  await expect(page.getByRole("alert").filter({ hasText: Q.errors.duplicate })).toBeVisible();
  expect(await rowNames(page)).toEqual([a, b, c]);

  // Colour.
  const colour = page.getByLabel(fill(Q.colorFor, { name: b }));
  await colour.selectOption({ label: Q.colors.red });
  await expect(colour).toHaveValue("red");
  await page.reload();
  await expect(page.getByLabel(fill(Q.colorFor, { name: b }))).toHaveValue("red");

  // Reorder with the keyboard-accessible buttons; focus follows the moved row.
  const later = (name: string) => page.getByRole("button", { name: fill(Q.moveLater, { name }) });
  const earlier = (name: string) =>
    page.getByRole("button", { name: fill(Q.moveEarlier, { name }) });
  await expect(earlier(a)).toBeDisabled();
  await expect(later(c)).toBeDisabled();
  await later(a).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => rowNames(page)).toEqual([b, a, c]);
  await expect(later(a)).toBeFocused();
  await earlier(c).click();
  await expect.poll(() => rowNames(page)).toEqual([b, c, a]);
  expect(await previewNames(page)).toEqual([b, c, a]);
  await page.reload();
  await expect(rows(page)).toHaveCount(3);
  expect(await rowNames(page)).toEqual([b, c, a]);
  expect(await previewNames(page)).toEqual([b, c, a]);

  // Remove: cancel keeps it, confirm removes it and closes the gap.
  await page.getByRole("button", { name: fill(Q.removeLabel, { name: c }) }).click();
  await page.getByRole("button", { name: mn.common.cancel }).click();
  expect(await rowNames(page)).toEqual([b, c, a]);
  await page.getByRole("button", { name: fill(Q.removeLabel, { name: c }) }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: Q.remove, exact: true }).click();
  await expect.poll(() => rowNames(page)).toEqual([b, a]);
  expect(await previewNames(page)).toEqual([b, a]);

  // Positions are contiguous in the database and every change is audited.
  await withE2eDb(async (db) => {
    const result = await db.query(
      `SELECT position FROM "QuickKey" WHERE "categoryId" = $1 ORDER BY position`,
      [categoryId],
    );
    expect(result.rows.map((r) => r.position)).toEqual([0, 1]);
    const audits = await db.query(
      `SELECT action FROM "AuditLog"
        WHERE action LIKE 'quickKey.%' AND (after->>'categoryId' = $1 OR before->>'categoryId' = $1)`,
      [categoryId],
    );
    expect(audits.rows.length).toBeGreaterThanOrEqual(6);
  });
});

test("the seeded grid shows on the favourites tab", async ({ page }) => {
  await signInAsOwner(page);
  await page.goto("/catalog/quick-keys");
  await expect(page.getByRole("link", { name: new RegExp(Q.favourites) })).toHaveAttribute(
    "aria-current",
    "page",
  );
  expect(await rows(page).count()).toBeGreaterThan(0);
  await expectNoHorizontalOverflow(page);
});

test("a cashier cannot open quick-key admin", async ({ page }) => {
  await signInAsCashier(page);
  await page.goto("/catalog/quick-keys");
  await expect(page).toHaveURL(/\/forbidden/);
});

test("fits a 390px phone with no horizontal scroll", async ({ page }) => {
  const tok = token();
  await insertProducts(`QK${tok}`, 1);
  await page.setViewportSize({ width: 390, height: 844 });
  await signInAsOwner(page);
  await freshTab(page, tok);
  await pickProduct(page, `QK${tok} 00`);
  await expect(rows(page)).toHaveCount(1);
  await expectNoHorizontalOverflow(page);
  // Every control in the row is a 44px target.
  for (const button of await rows(page).getByRole("button").all()) {
    const box = (await button.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
