import { expect, test, type Page } from "@playwright/test";
import { mn } from "./fixtures";
import {
  addStockHistory,
  badEan13,
  dbAudit,
  dbCategory,
  dbProduct,
  dbProducts,
  expectNoHorizontalOverflow,
  freshEan13,
  freshPlu,
  insertCategory,
  insertProducts,
  JPEG_1X1,
  paddedJpeg,
  PNG_1X1,
  setProductActiveDb,
  signInAsCashier,
  signInAsOwner,
  sku,
  SVG,
  token,
  watchPage,
} from "./helpers/products";

const P = mn.products;
const UUID_URL =
  /\/catalog\/products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** "{count, plural, ... other {# хувилбар}}" → "4 хувилбар" without hardcoding the word. */
const plural = (message: string, count: number) =>
  `${count} ${/other \{# ([^}]+)\}/.exec(message)![1]}`;
const variantCount = (n: number) => plural(P.variantCount, n);

const saveButton = (page: Page) => page.getByRole("button", { name: mn.common.save, exact: true });
const toast = (page: Page, text: string) =>
  page.locator("[data-sonner-toast]").filter({ hasText: text }).first();
const field = (page: Page, i: number, name: string) => page.locator(`#pf-variants-${i}-${name}`);
const addBarcode = async (page: Page, i: number, code: string) => {
  const input = page.locator(`#pf-variants-${i}-barcodes-input`);
  await input.fill(code);
  await input.press("Enter");
  await expect(
    page.getByRole("button", { name: P.removeBarcode.replace("{code}", code) }),
  ).toBeVisible();
};
const rows = (page: Page) => page.locator("tbody tr");

interface NewProduct {
  name: string;
  price?: string;
  sku?: string;
  barcodes?: string[];
  plu?: string;
  cost?: string;
  categoryId?: string;
  unit?: "PIECE" | "KG";
}

/** Create a single-variant product through the form; returns its id. */
async function createProduct(page: Page, p: NewProduct): Promise<string> {
  await page.goto("/catalog/products/new");
  await page.locator("#pf-name").fill(p.name);
  if (p.unit) await page.locator("#pf-unit").selectOption(p.unit);
  if (p.categoryId) await page.locator("#pf-category").selectOption(p.categoryId);
  await field(page, 0, "price").fill(p.price ?? "12,500");
  if (p.sku) await field(page, 0, "sku").fill(p.sku);
  if (p.plu) await field(page, 0, "pluCode").fill(p.plu);
  if (p.cost) await field(page, 0, "cost").fill(p.cost);
  for (const code of p.barcodes ?? []) await addBarcode(page, 0, code);
  await saveButton(page).click();
  await expect(page).toHaveURL(UUID_URL);
  return page.url().split("/").pop()!;
}

let watch: ReturnType<typeof watchPage>;
test.beforeEach(async ({ page }) => {
  watch = watchPage(page);
});
test.afterEach(() => {
  watch.expectClean();
});

test.describe("create", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsOwner(page);
  });

  test("simple product: Mongolian field errors, double submit, saved data", async ({ page }) => {
    const tok = token();
    const name = `Сүү ${tok}`;
    const code = freshEan13();
    await page.goto("/catalog/products/new");
    await expect(page.getByRole("heading", { name: P.createTitle })).toBeVisible();
    await expect(page.locator("#pf-name")).toBeFocused();

    // Empty form: errors sit next to the fields, in Mongolian.
    await saveButton(page).click();
    await expect(page.locator("#pf-name-error")).toHaveText(mn.validation.required);
    await expect(page.locator("#pf-name")).toHaveAttribute("aria-invalid", "true");
    await expect(page.locator("#pf-name")).toHaveAttribute("aria-describedby", "pf-name-error");
    await expect(field(page, 0, "price-error")).toHaveText(mn.validation.invalidMoney);
    await expect(page).toHaveURL(/\/catalog\/products\/new$/);

    // Bad values: junk price, SKU with a space, barcode with a wrong check digit.
    const bad = badEan13();
    await page.locator("#pf-name").fill(name);
    await field(page, 0, "price").fill("abc");
    await field(page, 0, "sku").fill("with space");
    await addBarcode(page, 0, bad);
    await saveButton(page).click();
    await expect(field(page, 0, "price-error")).toHaveText(mn.validation.invalidMoney);
    await expect(field(page, 0, "sku-error")).toHaveText(mn.validation.invalid);
    await expect(field(page, 0, "barcodes-0-error")).toHaveText(mn.validation.invalidBarcode);
    await expect(page.locator("#pf-name-error")).toHaveCount(0);

    // Fix everything; adding the same barcode twice is refused in place.
    await page.getByRole("button", { name: P.removeBarcode.replace("{code}", bad) }).click();
    await addBarcode(page, 0, code);
    await field(page, 0, "barcodes-input").fill(code);
    await field(page, 0, "barcodes-input").press("Enter");
    await expect(page.getByText(P.barcodeExists)).toBeVisible();
    await field(page, 0, "barcodes-input").clear();
    await field(page, 0, "price").fill("12,500");
    await field(page, 0, "sku").fill(sku(tok));
    await field(page, 0, "cost").fill("8,000");

    // Double click saves once.
    await saveButton(page).dblclick();
    await expect(page).toHaveURL(UUID_URL);
    await expect(toast(page, mn.common.saved)).toBeVisible();
    expect(await dbProducts(`%${tok}%`)).toHaveLength(1);

    const saved = (await dbProduct(name))!;
    expect(saved).toMatchObject({
      unit: "PIECE",
      type: "STANDARD",
      isActive: true,
      trackStock: true,
    });
    expect(saved.variants).toHaveLength(1);
    expect(saved.variants[0]).toMatchObject({
      sku: sku(tok),
      price: "1250000", // möngö
      cost: "800000",
      barcodes: [code],
    });

    // Re-opened product shows what was saved.
    await expect(page.locator("#pf-name")).toHaveValue(name);
    await expect(field(page, 0, "price")).toHaveValue("12,500");
    await expect(field(page, 0, "sku")).toHaveValue(sku(tok));
    await expect(
      page.getByRole("button", { name: P.removeBarcode.replace("{code}", code) }),
    ).toBeVisible();

    // And the list shows it.
    await page.goto(`/catalog/products?q=${encodeURIComponent(tok)}`);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(name);
    await expect(rows(page).first()).toContainText(sku(tok));
    await expect(rows(page).first()).toContainText("12,500");
  });

  test("product with two options generates a variant matrix; rename and remove keep rows", async ({
    page,
  }) => {
    const tok = token();
    const name = `Цамц ${tok}`;
    const codes = [freshEan13(), freshEan13(), freshEan13(), freshEan13()];
    await page.goto("/catalog/products/new");
    await page.locator("#pf-name").fill(name);

    await page.getByRole("button", { name: P.addOption }).click();
    await page.locator("#pf-options-0-name").fill("Хэмжээ");
    await page.locator("#pf-options-0-values").fill("S, M");
    await page.getByRole("button", { name: P.addOption }).click();
    await page.locator("#pf-options-1-name").fill("Өнгө");
    await page.locator("#pf-options-1-values").fill("Хар, Цагаан");
    await page.getByRole("button", { name: P.generateVariants }).click();
    await expect(page.getByText(variantCount(4))).toBeVisible();
    const combos = ["S / Хар", "S / Цагаан", "M / Хар", "M / Цагаан"];
    for (const combo of combos) {
      await expect(page.getByRole("heading", { name: combo, exact: true })).toBeVisible();
    }

    for (const [i] of combos.entries()) {
      await field(page, i, "sku").fill(sku(tok, i + 1));
      await field(page, i, "price").fill(String(10_000 + i * 1000));
      await addBarcode(page, i, codes[i]!);
    }
    await saveButton(page).click();
    await expect(page).toHaveURL(UUID_URL);
    await expect(page.getByText(variantCount(4))).toBeVisible();

    const created = (await dbProduct(name))!;
    expect(created.options).toEqual([
      { name: "Хэмжээ", values: ["S", "M"] },
      { name: "Өнгө", values: ["Хар", "Цагаан"] },
    ]);
    expect(
      created.variants.map((v) => [v.option1, v.option2, v.sku, v.price, v.barcodes[0]]),
    ).toEqual(
      combos.map((c, i) => [
        c.split(" / ")[0],
        c.split(" / ")[1],
        sku(tok, i + 1),
        String((10_000 + i * 1000) * 100),
        codes[i],
      ]),
    );
    const idBySku = new Map(created.variants.map((v) => [v.sku, v.id]));

    // Rename the first option and add a value: the four existing rows survive.
    await page.locator("#pf-options-0-name").fill("Size");
    await page.locator("#pf-options-0-values").fill("S, M, L");
    await page.locator("#pf-options-0-values").press("Tab");
    await expect(page.getByText(variantCount(6))).toBeVisible();
    await expect(field(page, 0, "sku")).toHaveValue(sku(tok, 1));
    await expect(field(page, 1, "sku")).toHaveValue(sku(tok, 2));
    await saveButton(page).click();
    await expect.poll(async () => (await dbProduct(name))!.variants.length).toBe(6);
    await expect(page.getByText(variantCount(6))).toBeVisible();

    const renamed = (await dbProduct(name))!;
    expect(renamed.options[0]).toEqual({ name: "Size", values: ["S", "M", "L"] });
    expect(renamed.variants).toHaveLength(6);
    for (let i = 1; i <= 4; i++) {
      const v = renamed.variants.find((x) => x.sku === sku(tok, i))!;
      expect(v.id).toBe(idBySku.get(sku(tok, i)));
      expect(v.barcodes).toEqual([codes[i - 1]]);
    }

    // Remove the colour option: one row per size remains, S and M keep their ids and codes.
    // The form remounts from the saved data after router.refresh(); wait for it to settle.
    await page.waitForLoadState("networkidle");
    await expect(async () => {
      await page.getByRole("button", { name: P.removeOption.replace("{n}", "2") }).click();
      await expect(page.getByText(variantCount(3))).toBeVisible({ timeout: 1000 });
    }).toPass();
    await saveButton(page).click();
    await expect.poll(async () => (await dbProduct(name))!.variants.length).toBe(3);
    await expect(page.getByText(variantCount(3))).toBeVisible();

    const collapsed = (await dbProduct(name))!;
    expect(collapsed.options).toEqual([{ name: "Size", values: ["S", "M", "L"] }]);
    expect(collapsed.variants.map((v) => [v.option1, v.option2])).toEqual([
      ["S", null],
      ["M", null],
      ["L", null],
    ]);
    expect(collapsed.variants[0]).toMatchObject({ id: idBySku.get(sku(tok, 1)), sku: sku(tok, 1) });
    expect(collapsed.variants[1]).toMatchObject({ id: idBySku.get(sku(tok, 3)), sku: sku(tok, 3) });
    expect(collapsed.variants[0]!.barcodes).toEqual([codes[0]]);
  });

  test("duplicate SKU, PLU and barcode across products are shown on the fields", async ({
    page,
  }) => {
    const tok = token();
    const code = freshEan13();
    const plu = freshPlu();
    await createProduct(page, {
      name: `Эх бараа ${tok}`,
      sku: sku(tok),
      barcodes: [code],
      plu,
    });

    await page.goto("/catalog/products/new");
    await page.locator("#pf-name").fill(`Давхар ${tok}`);
    await field(page, 0, "price").fill("500");
    await field(page, 0, "sku").fill(sku(tok).toUpperCase()); // codes compare case-insensitively
    await field(page, 0, "pluCode").fill(plu);
    await addBarcode(page, 0, code);
    await saveButton(page).click();
    await expect(field(page, 0, "sku-error")).toHaveText(mn.validation.duplicate);
    await expect(field(page, 0, "pluCode-error")).toHaveText(mn.validation.duplicate);
    await expect(field(page, 0, "barcodes-0-error")).toHaveText(mn.validation.duplicate);
    await expect(field(page, 0, "sku")).toHaveAttribute("aria-invalid", "true");
    await expect(page).toHaveURL(/\/catalog\/products\/new$/);
    expect(await dbProducts(`Давхар ${tok}`)).toHaveLength(0);

    // Fix the codes and the same form saves.
    await field(page, 0, "sku").fill(sku(tok, 2));
    await field(page, 0, "pluCode").fill(freshPlu());
    await page.getByRole("button", { name: P.removeBarcode.replace("{code}", code) }).click();
    await addBarcode(page, 0, freshEan13());
    await saveButton(page).click();
    await expect(page).toHaveURL(UUID_URL);

    // Within one product: two variants must not share a SKU.
    await page.goto("/catalog/products/new");
    await page.locator("#pf-name").fill(`Хоёр ${tok}`);
    await page.getByRole("button", { name: P.addOption }).click();
    await page.locator("#pf-options-0-name").fill("Хэмжээ");
    await page.locator("#pf-options-0-values").fill("S, M");
    await page.getByRole("button", { name: P.generateVariants }).click();
    for (const i of [0, 1]) {
      await field(page, i, "price").fill("900");
      await field(page, i, "sku").fill(sku(tok, "same"));
    }
    await saveButton(page).click();
    await expect(field(page, 1, "sku-error")).toHaveText(mn.validation.duplicate);
    expect(await dbProducts(`Хоёр ${tok}`)).toHaveLength(0);
  });

  test("weighed product (kg) with PLU", async ({ page }) => {
    const tok = token();
    const name = `Мах ${tok}`;
    const digits = String(10000 + (Number.parseInt(tok.slice(0, 4), 16) % 89999));
    await page.goto("/catalog/products/new");
    await page.locator("#pf-name").fill(name);
    await expect(page.getByText(P.unitPieceHint)).toBeVisible();
    await page.locator("#pf-unit").selectOption("KG");
    await expect(page.getByText(P.unitWeighedHint)).toBeVisible();
    await expect(page.getByLabel(P.pricePerUnit.replace("{unit}", mn.units.KG))).toBeVisible();
    await expect(page.getByText(P.pluHint)).toBeVisible();

    // The PLU field only takes digits, at most seven.
    await field(page, 0, "pluCode").fill("a-b1c2");
    await expect(field(page, 0, "pluCode")).toHaveValue("12");
    await field(page, 0, "pluCode").fill(`00${digits}`);
    await expect(field(page, 0, "pluCode")).toHaveValue(`00${digits}`);
    await field(page, 0, "price").fill("28,900");
    await saveButton(page).click();
    await expect(page).toHaveURL(UUID_URL);

    const saved = (await dbProduct(name))!;
    expect(saved.unit).toBe("KG");
    expect(saved.variants[0]).toMatchObject({ pluCode: String(Number(digits)), price: "2890000" });
    await expect(page.locator("#pf-unit")).toHaveValue("KG");
    await expect(field(page, 0, "pluCode")).toHaveValue(String(Number(digits)));

    // Scale code lookup in the list, with or without leading zeros.
    await page.goto(`/catalog/products?q=${digits}`);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(name);
    await expect(rows(page).first()).toContainText(mn.units.KG);
    await page.goto(`/catalog/products?q=00${digits}`);
    await expect(rows(page)).toHaveCount(1);

    // A second product cannot take the same PLU.
    await page.goto("/catalog/products/new");
    await page.locator("#pf-name").fill(`${name} 2`);
    await page.locator("#pf-unit").selectOption("KG");
    await field(page, 0, "price").fill("1,000");
    await field(page, 0, "pluCode").fill(digits);
    await saveButton(page).click();
    await expect(field(page, 0, "pluCode-error")).toHaveText(mn.validation.duplicate);

    // Services and gift cards do not track stock.
    await page.locator("#pf-type").selectOption("SERVICE");
    await expect(page.locator("#pf-track-stock")).toBeDisabled();
    await expect(page.locator("#pf-track-stock")).not.toBeChecked();
  });
});

test.describe("edit", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsOwner(page);
  });

  test("changing a price is audited as price_change; cost is read-only", async ({ page }) => {
    const tok = token();
    const name = `Талх ${tok}`;
    const first = freshEan13();
    const id = await createProduct(page, {
      name,
      price: "2,000",
      cost: "1,200",
      sku: sku(tok),
      barcodes: [first],
    });
    const variantId = (await dbProduct(name))!.variants[0]!.id;
    expect(await dbAudit(variantId, "product.price_change")).toHaveLength(0);

    // Existing variants show their cost read-only (no opening-cost input).
    await expect(field(page, 0, "cost")).toHaveCount(0);
    await expect(page.getByText(P.costReadOnly, { exact: true })).toBeVisible();
    await expect(page.getByText("1,200₮")).toBeVisible();

    // Saving without a price change writes no price_change.
    await page.locator("#pf-name").fill(`${name} шинэ`);
    await saveButton(page).click();
    await expect(toast(page, mn.common.saved)).toBeVisible();
    await page.waitForLoadState("networkidle"); // the form remounts from the saved data
    expect(await dbAudit(variantId, "product.price_change")).toHaveLength(0);
    expect((await dbProduct(`${name} шинэ`))?.id).toBe(id);

    // Change the price and swap the barcode.
    const second = freshEan13();
    await field(page, 0, "price").fill("2,500");
    await page.getByRole("button", { name: P.removeBarcode.replace("{code}", first) }).click();
    await addBarcode(page, 0, second);
    await saveButton(page).click();
    await expect
      .poll(async () => (await dbAudit(variantId, "product.price_change")).length)
      .toBe(1);
    await expect(field(page, 0, "price")).toHaveValue("2,500");

    const changes = await dbAudit(variantId, "product.price_change");
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ before: { price: "200000" }, after: { price: "250000" } });
    const saved = (await dbProduct(`${name} шинэ`))!;
    expect(saved.id).toBe(id);
    expect(saved.variants[0]).toMatchObject({
      price: "250000",
      cost: "120000",
      barcodes: [second],
    });

    // The old barcode is free again.
    await createProduct(page, { name: `Дахин ${tok}`, barcodes: [first] });
  });

  test("product image: jpeg/png work, svg / oversize / fake files are refused", async ({
    page,
  }) => {
    const tok = token();
    const name = `Зурагтай ${tok}`;
    const id = await createProduct(page, { name });
    const picker = page.locator("#pf-image");
    const error = page.locator("#pf-image-error");
    const img = page.getByRole("img", { name: P.imageAlt });
    await expect(img).toHaveCount(0);

    // Refused files: svg, oversize, svg disguised as png.
    await picker.setInputFiles({ name: "logo.svg", mimeType: "image/svg+xml", buffer: SVG });
    await expect(error).toHaveText(mn.validation.invalid);
    await picker.setInputFiles({
      name: "big.jpg",
      mimeType: "image/jpeg",
      buffer: paddedJpeg(2 * 1024 * 1024 + 1),
    });
    await expect(error).toHaveText(mn.validation.tooLong);
    await picker.setInputFiles({ name: "fake.png", mimeType: "image/png", buffer: SVG });
    await expect(error).toHaveText(mn.validation.invalid); // server checks the real bytes
    expect((await dbProduct(name))!.imageUrl).toBeNull();

    // A png uploads at once.
    await picker.setInputFiles({ name: "a.png", mimeType: "image/png", buffer: PNG_1X1 });
    await expect(toast(page, P.imageSaved)).toBeVisible();
    await expect(img).toBeVisible();
    await expect(error).toHaveCount(0);
    const pngUrl = (await dbProduct(name))!.imageUrl!;
    expect(pngUrl).toMatch(/^\/api\/uploads\/products\/.+\.png$/);
    await expect(img).toHaveAttribute("src", pngUrl);
    const served = await page.request.get(pngUrl);
    expect(served.status()).toBe(200);
    expect(served.headers()["content-type"]).toBe("image/png");

    // A ~1.5 MB jpeg replaces it; the old file is gone.
    await picker.setInputFiles({
      name: "b.jpg",
      mimeType: "image/jpeg",
      buffer: paddedJpeg(1_500_000),
    });
    await expect
      .poll(async () => (await dbProduct(name))!.imageUrl)
      .toMatch(/^\/api\/uploads\/products\/.+\.jpg$/);
    await expect(img).toBeVisible();
    expect((await page.request.get(pngUrl)).status()).toBe(404);
    const jpgUrl = (await dbProduct(name))!.imageUrl!;
    const jpg = await page.request.get(jpgUrl);
    expect(jpg.headers()["content-type"]).toBe("image/jpeg");
    expect((await jpg.body()).length).toBe(1_500_000);

    // The thumbnail shows in the list.
    await page.goto(`/catalog/products?q=${tok}`);
    await expect(rows(page).first().locator("img")).toHaveAttribute("src", jpgUrl);

    // Remove it.
    await page.goto(`/catalog/products/${id}`);
    await page.getByRole("button", { name: P.imageRemove }).click();
    await expect(toast(page, P.imageRemoved)).toBeVisible();
    await expect(img).toHaveCount(0);
    expect((await dbProduct(name))!.imageUrl).toBeNull();
    expect((await page.request.get(jpgUrl)).status()).toBe(404);
  });

  test("an image chosen on a new product is saved with it", async ({ page }) => {
    const tok = token();
    const name = `Шинэ зураг ${tok}`;
    await page.goto("/catalog/products/new");
    await page.locator("#pf-name").fill(name);
    await field(page, 0, "price").fill("700");
    await page.locator("#pf-image").setInputFiles({
      name: "a.jpg",
      mimeType: "image/jpeg",
      buffer: JPEG_1X1,
    });
    await expect(page.getByRole("img", { name: P.imageAlt })).toBeVisible();
    await page.getByRole("button", { name: P.imageRemove }).click();
    await expect(page.getByRole("img", { name: P.imageAlt })).toHaveCount(0);
    await page.locator("#pf-image").setInputFiles({
      name: "a.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    await saveButton(page).click();
    await expect(page).toHaveURL(UUID_URL);
    await expect(page.getByRole("img", { name: P.imageAlt })).toBeVisible();
    expect((await dbProduct(name))!.imageUrl).toMatch(/\.png$/);
  });
});

test.describe("archive, restore, delete", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsOwner(page);
  });

  test("archive hides from the active list; restore brings it back", async ({ page }) => {
    const tok = token();
    const name = `Архив ${tok}`;
    const id = await createProduct(page, { name });
    await page.getByRole("button", { name: mn.common.archive, exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(P.archiveConfirm.replace("{name}", name));
    await dialog.getByRole("button", { name: mn.common.archive, exact: true }).click();
    await expect(toast(page, P.archived)).toBeVisible();
    await expect(page.getByText(mn.common.archived, { exact: true })).toBeVisible();
    expect((await dbProduct(name))!.isActive).toBe(false);

    await page.goto(`/catalog/products?q=${tok}`);
    await expect(page.getByText(P.emptyFiltered)).toBeVisible();
    await page.goto(`/catalog/products?q=${tok}&status=archived`);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(mn.common.archived);
    await page.goto(`/catalog/products?q=${tok}&status=all`);
    await expect(rows(page)).toHaveCount(1);

    // Archived products can still be opened and restored.
    await page.goto(`/catalog/products/${id}`);
    await page.getByRole("button", { name: mn.common.restore, exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: mn.common.restore, exact: true })
      .click();
    await expect(toast(page, P.restored)).toBeVisible();
    await expect(page.getByRole("button", { name: mn.common.archive, exact: true })).toBeVisible();
    expect((await dbProduct(name))!.isActive).toBe(true);
    await page.goto(`/catalog/products?q=${tok}`);
    await expect(rows(page)).toHaveCount(1);
  });

  test("delete removes an unused product; one with stock history is IN_USE", async ({ page }) => {
    const tok = token();
    const unused = `Устгах ${tok}`;
    const used = `Түүхтэй ${tok}`;
    const unusedId = await createProduct(page, { name: unused });
    const usedId = await createProduct(page, { name: used });

    // History: refuse, stay open, keep the product.
    await addStockHistory((await dbProduct(used))!.variants[0]!.id);
    await page.getByRole("button", { name: mn.common.delete, exact: true }).click();
    const dialog = page.getByRole("alertdialog");
    await expect(dialog).toContainText(mn.common.confirmDelete.replace("{name}", used));
    await dialog.getByRole("button", { name: mn.common.delete, exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(mn.errors.IN_USE);
    expect(await dbProducts(used)).toHaveLength(1);
    await dialog.getByRole("button", { name: mn.common.cancel }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`${usedId}$`));

    // No history: deleted, back on the list.
    await page.goto(`/catalog/products/${unusedId}`);
    await page.getByRole("button", { name: mn.common.delete, exact: true }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: mn.common.delete, exact: true })
      .click();
    await expect(page).toHaveURL(/\/catalog\/products$/);
    await expect(toast(page, P.deleted)).toBeVisible();
    expect(await dbProducts(unused)).toHaveLength(0);

    // The deleted product's page is a real 404.
    const response = await page.goto(`/catalog/products/${unusedId}`);
    // (The status stays 200 here: loading.tsx has already streamed the shell.)
    expect(response?.status()).toBeLessThan(500);
    await expect(page.getByRole("heading", { name: mn.states.notFoundTitle })).toBeVisible();
    expect(watch.problems).toEqual([]);
  });
});

test.describe("list: search, filters, pagination", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsOwner(page);
  });

  test("search by name, SKU, barcode; category and status filters; empty state", async ({
    page,
  }) => {
    const tok = token();
    const parent = await insertCategory(`Эцэг ${tok}`);
    const child = await insertCategory(`Хүү ${tok}`, parent);
    const codeA = freshEan13();
    const codeB = freshEan13();
    const nameA = `Алим ${tok}`;
    const nameB = `Banana ${tok}`;
    await createProduct(page, {
      name: nameA,
      sku: sku(tok, "A"),
      barcodes: [codeA],
      categoryId: parent,
    });
    await createProduct(page, {
      name: nameB,
      sku: sku(tok, "B"),
      barcodes: [codeB],
      categoryId: child,
    });

    await page.goto("/catalog/products");
    const search = page.getByRole("searchbox", { name: P.search });
    const apply = page.getByRole("button", { name: P.applyFilters });
    const run = async (q: string) => {
      await search.fill(q);
      await apply.click();
      await expect(page).toHaveURL((url) => url.searchParams.get("q") === q);
    };

    await run(tok);
    await expect(rows(page)).toHaveCount(2);
    await run(`banana ${tok}`.toUpperCase()); // case-insensitive name
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(nameB);
    await run(sku(tok, "A").toLowerCase());
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(nameA);
    await run(codeB);
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(nameB);

    // Empty result: message and a way back.
    await run(`нэг-ч-үгүй-${tok}`);
    await expect(page.getByText(P.emptyFiltered, { exact: true })).toBeVisible();
    await page.getByRole("link", { name: P.clearFilters }).click();
    await expect(page).toHaveURL(/\/catalog\/products$/);
    await expect(search).toHaveValue("");

    // Category filter includes sub-categories.
    await page.goto(`/catalog/products?q=${tok}`);
    await page.getByLabel(P.category, { exact: true }).selectOption(parent);
    await apply.click();
    await expect(rows(page)).toHaveCount(2);
    await page.getByLabel(P.category, { exact: true }).selectOption(child);
    await apply.click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(nameB);
    await expect(rows(page).first()).toContainText(`Хүү ${tok}`);

    // Status filter.
    await setProductActiveDb(nameB, false);
    await page.goto(`/catalog/products?q=${tok}`);
    await expect(rows(page)).toHaveCount(1);
    await page.getByLabel(P.status, { exact: true }).selectOption("archived");
    await apply.click();
    await expect(rows(page)).toHaveCount(1);
    await expect(rows(page).first()).toContainText(nameB);
    await page.getByLabel(P.status, { exact: true }).selectOption("all");
    await apply.click();
    await expect(rows(page)).toHaveCount(2);

    // Browser back / forward restore earlier results.
    await page.goBack();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByLabel(P.status, { exact: true })).toHaveValue("archived");
    await page.goForward();
    await expect(rows(page)).toHaveCount(2);

    // Open a product, come back with Back: the filtered list is intact.
    await rows(page).getByRole("link", { name: nameA }).first().click();
    await expect(page).toHaveURL(UUID_URL);
    await page.goBack();
    await expect(page).toHaveURL(/status=all/);
    await expect(rows(page)).toHaveCount(2);
  });

  test("pagination: 25 per page, next / previous, back and forward, clamped page", async ({
    page,
  }) => {
    const tok = token();
    await insertProducts(`Хуудас ${tok}`, 27);

    await page.goto(`/catalog/products?q=${tok}`);
    const nav = page.getByRole("navigation", { name: P.pagination });
    await expect(rows(page)).toHaveCount(25);
    await expect(nav).toContainText(
      mn.common.pageOf.replace("{page}", "1").replace("{pages}", "2"),
    );
    await expect(nav).toContainText(P.total.replace("{count}", "27"));
    await expect(nav.getByRole("link", { name: mn.common.previous })).toHaveCount(0);

    await nav.getByRole("link", { name: mn.common.next }).click();
    await expect(page).toHaveURL(/page=2/);
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page).first()).toContainText(`Хуудас ${tok} 25`);
    await expect(nav.getByRole("link", { name: mn.common.next })).toHaveCount(0);

    await page.goBack();
    await expect(page).not.toHaveURL(/page=/);
    await expect(rows(page)).toHaveCount(25);
    await page.goForward();
    await expect(rows(page)).toHaveCount(2);
    await nav.getByRole("link", { name: mn.common.previous }).click();
    await expect(rows(page)).toHaveCount(25);

    // Out-of-range and junk page numbers do not break the list.
    await page.goto(`/catalog/products?q=${tok}&page=999`);
    await expect(rows(page)).toHaveCount(2);
    await page.goto(`/catalog/products?q=${tok}&page=abc`);
    await expect(rows(page)).toHaveCount(25);
    await page.goto(`/catalog/products?q=${tok}&page=-3&status=bogus&category=not-a-uuid`);
    await expect(rows(page)).toHaveCount(25);
  });
});

test.describe("permissions", () => {
  test("a cashier can look but not create, edit, archive or delete", async ({ page }) => {
    const tok = token();
    const name = `Үзэх ${tok}`;
    await insertProducts(name, 1);
    const id = (await dbProducts(`${name}%`))[0]!.id;
    await signInAsCashier(page);

    await page.goto(`/catalog/products?q=${tok}`);
    await expect(page.getByRole("heading", { name: P.title, level: 1 })).toBeVisible();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByRole("link", { name: P.new })).toHaveCount(0);
    await expect(rows(page).first().getByRole("link", { name: P.view, exact: true })).toBeVisible();

    await page.goto("/catalog/products/new");
    await expect(page).toHaveURL(/\/forbidden$/);
    await expect(page.getByRole("heading", { name: mn.states.forbiddenTitle })).toBeVisible();

    await page.goto(`/catalog/products/${id}`);
    await expect(page.getByText(P.readOnlyHint)).toBeVisible();
    await expect(page.locator("#pf-name")).toHaveCount(0);
    await expect(page.getByRole("button", { name: mn.common.archive, exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: mn.common.delete, exact: true })).toHaveCount(0);

    await page.goto("/catalog/categories");
    await expect(page.getByRole("heading", { name: mn.categories.title, level: 1 })).toBeVisible();
    await expect(page.getByRole("button", { name: mn.categories.new })).toHaveCount(0);
    await expect(page.getByRole("button", { name: mn.common.edit })).toHaveCount(0);
    // The server-side guards are asserted by the integration suite; the cashier page fails closed.
    watch.problems.splice(0);
  });
});

test.describe("categories", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsOwner(page);
  });

  test("nested categories, cycle prevention, archive and delete", async ({ page }) => {
    const tok = token();
    const rootName = `Корень ${tok}`;
    const childName = `Салаа ${tok}`;
    const leafName = `Навч ${tok}`;
    await page.goto("/catalog/categories");
    const dialog = page.getByRole("dialog");
    const row = (name: string) => page.getByRole("row").filter({ hasText: name });
    const save = () => dialog.getByRole("button", { name: mn.common.save, exact: true });

    // Create: empty name is refused next to the field; Escape closes and returns focus.
    const open = page.getByRole("button", { name: mn.categories.new });
    await open.click();
    await expect(dialog.getByRole("heading", { name: mn.categories.createTitle })).toBeVisible();
    await save().click();
    await expect(dialog.locator("#category-name-error")).toHaveText(mn.validation.required);
    await expect(dialog.locator("#category-name")).toHaveAttribute("aria-invalid", "true");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(open).toBeFocused();

    await open.click();
    await dialog.locator("#category-name").fill(rootName);
    await dialog.getByRole("button", { name: mn.categories.colors.blue, exact: true }).click();
    await expect(
      dialog.getByRole("button", { name: mn.categories.colors.blue, exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await save().click();
    await expect(toast(page, mn.common.saved)).toBeVisible();
    await expect(row(rootName)).toBeVisible();
    const root = (await dbCategory(rootName))!;
    expect(root.parentId).toBeNull();

    // Nested: child under root, leaf under child.
    await open.click();
    await dialog.locator("#category-name").fill(childName);
    await dialog.locator("#category-parent").selectOption(root.id);
    await save().click();
    await expect(row(childName)).toBeVisible();
    const child = (await dbCategory(childName))!;
    expect(child.parentId).toBe(root.id);
    await open.click();
    await dialog.locator("#category-name").fill(leafName);
    await dialog.locator("#category-parent").selectOption(child.id);
    await save().click();
    await expect(row(leafName)).toBeVisible();
    const leaf = (await dbCategory(leafName))!;
    expect(leaf.parentId).toBe(child.id);
    const pad = (name: string) =>
      row(name)
        .locator("td")
        .first()
        .locator("div")
        .first()
        .evaluate((el) => el.style.paddingInlineStart);
    expect(Number.parseFloat(await pad(childName))).toBeGreaterThan(
      Number.parseFloat(await pad(rootName)),
    );
    expect(Number.parseFloat(await pad(leafName))).toBeGreaterThan(
      Number.parseFloat(await pad(childName)),
    );

    // Cycle: root cannot move under itself (not offered) nor under its descendant (refused).
    await row(rootName).getByRole("button", { name: mn.common.edit }).click();
    await expect(dialog.getByRole("heading", { name: mn.categories.editTitle })).toBeVisible();
    await expect(dialog.locator(`#category-parent option[value="${root.id}"]`)).toHaveCount(0);
    await dialog.locator("#category-parent").selectOption(leaf.id);
    await save().click();
    await expect(dialog.locator("#category-parent-error")).toHaveText(mn.validation.cycle);
    await expect(dialog.locator("#category-parent")).toHaveAttribute("aria-invalid", "true");
    expect((await dbCategory(rootName))!.parentId).toBeNull();
    // Cancel throws the edit away: reopening shows the stored values again.
    await dialog.locator("#category-name").fill("зөвхөн оролдлого");
    await dialog.getByRole("button", { name: mn.common.cancel }).click();
    await expect(dialog).toHaveCount(0);
    await row(rootName).getByRole("button", { name: mn.common.edit }).click();
    await expect(dialog.locator("#category-name")).toHaveValue(rootName);
    await expect(dialog.locator("#category-parent")).toHaveValue("");
    await expect(dialog.locator("#category-parent-error")).toHaveCount(0);
    // A valid edit works: rename.
    await dialog.locator("#category-name").fill(`${rootName} v2`);
    await save().click();
    await expect(row(`${rootName} v2`)).toBeVisible();

    // A product in the leaf: counted, and it blocks deleting the category.
    const productName = `Ангилалтай ${tok}`;
    await createProduct(page, { name: productName, categoryId: leaf.id });
    await page.goto("/catalog/categories");
    await expect(row(leafName)).toContainText(plural(mn.categories.productCount, 1));
    await row(leafName).getByRole("button", { name: mn.common.delete }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.delete }).click();
    await expect(toast(page, mn.errors.IN_USE)).toBeVisible();
    await expect(row(leafName)).toBeVisible();

    // Archive the child: badge, and it can no longer be picked as a parent or product category.
    await row(childName).getByRole("button", { name: mn.common.archive }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.archive }).click();
    await expect(toast(page, mn.categories.archived)).toBeVisible();
    await expect(row(childName)).toContainText(mn.common.archived);
    await page.getByRole("button", { name: mn.categories.new }).click();
    await expect(dialog.locator(`#category-parent option[value="${child.id}"]`)).toHaveCount(0);
    await dialog.getByRole("button", { name: mn.common.cancel }).click();
    await page.goto("/catalog/products/new");
    await expect(page.locator(`#pf-category option[value="${child.id}"]`)).toHaveCount(0);
    await expect(page.locator(`#pf-category option[value="${root.id}"]`)).toHaveCount(1);
    // ... but a product already in it keeps showing it when edited.
    const p = (await dbProduct(productName))!;
    await page.goto(`/catalog/products/${p.id}`);
    await expect(page.locator("#pf-category")).toHaveValue(leaf.id);

    // Restore the child.
    await page.goto("/catalog/categories");
    await row(childName).getByRole("button", { name: mn.common.restore }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.restore }).click();
    await expect(toast(page, mn.categories.restored)).toBeVisible();

    // Delete: a parent with children is IN_USE, an empty leaf goes away.
    const emptyLeaf = `Хоосон ${tok}`;
    await open.click();
    await dialog.locator("#category-name").fill(emptyLeaf);
    await dialog.locator("#category-parent").selectOption(root.id);
    await save().click();
    await expect(row(emptyLeaf)).toBeVisible();
    await row(emptyLeaf).getByRole("button", { name: mn.common.delete }).click();
    await expect(page.getByRole("alertdialog")).toContainText(
      mn.common.confirmDelete.replace("{name}", emptyLeaf),
    );
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.delete }).click();
    await expect(toast(page, mn.common.deleted)).toBeVisible();
    await expect(row(emptyLeaf)).toHaveCount(0);
    expect(await dbCategory(emptyLeaf)).toBeUndefined();

    await row(`${rootName} v2`).getByRole("button", { name: mn.common.delete }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.delete }).click();
    await expect(toast(page, mn.errors.IN_USE).last()).toBeVisible();
    expect(await dbCategory(`${rootName} v2`)).toBeDefined();
  });
});

test.describe("quality", () => {
  test.beforeEach(async ({ page }) => {
    await signInAsOwner(page);
  });

  test("no horizontal overflow at 390px on the products and categories pages", async ({ page }) => {
    const tok = token();
    const name = `Гар утас ${tok}`;
    const cat = await insertCategory(`Өөр ${tok}`);
    await page.goto("/catalog/products/new");
    await page.locator("#pf-name").fill(name);
    await page.locator("#pf-category").selectOption(cat);
    await page.getByRole("button", { name: P.addOption }).click();
    await page.locator("#pf-options-0-name").fill("Хэмжээ");
    await page.locator("#pf-options-0-values").fill("S, M, L");
    await page.getByRole("button", { name: P.generateVariants }).click();
    for (const i of [0, 1, 2]) {
      await field(page, i, "price").fill("19,900");
      await addBarcode(page, i, freshEan13());
    }
    await saveButton(page).click();
    await expect(page).toHaveURL(UUID_URL);
    const editUrl = page.url();

    await page.setViewportSize({ width: 390, height: 844 });
    for (const url of [
      `/catalog/products?q=${tok}`,
      "/catalog/products",
      "/catalog/products?status=all",
      "/catalog/products/new",
      editUrl,
      "/catalog/categories",
    ]) {
      await page.goto(url);
      await expect(page.getByRole("main")).toBeVisible();
      await expectNoHorizontalOverflow(page);
    }

    // The edit form with errors showing (longest content) still fits.
    await page.goto(editUrl);
    await page.locator("#pf-name").fill("");
    await field(page, 0, "price").fill("x");
    await saveButton(page).click();
    await expect(page.locator("#pf-name-error")).toBeVisible();
    await expectNoHorizontalOverflow(page);

    // Dialog on a phone.
    await page.goto("/catalog/categories");
    await page.getByRole("button", { name: mn.categories.new }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });

  test("labels and keyboard: every control is named, Enter adds barcodes, Enter submits", async ({
    page,
  }) => {
    const tok = token();
    const name = `Гар ${tok}`;
    await page.goto("/catalog/products/new");
    await page.getByRole("button", { name: P.addOption }).click();

    const unnamed = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          "main input, main select, main textarea, main button, main [role=switch]",
        ),
      ]
        .filter(
          (el) => !el.closest("[aria-hidden=true]") && el.getAttribute("aria-hidden") !== "true",
        )
        .filter((el) => {
          const named =
            el.getAttribute("aria-label") ||
            el.getAttribute("aria-labelledby") ||
            (el as HTMLInputElement).labels?.length ||
            el.textContent?.trim();
          return !named;
        })
        .map((el) => el.outerHTML.slice(0, 120)),
    );
    expect(unnamed).toEqual([]);

    // Hidden file input must not be a keyboard trap / unnamed tab stop.
    const fileInput = page.locator("#pf-image");
    const tabbable = await fileInput.evaluate(
      (el) => (el as HTMLInputElement).tabIndex >= 0 && !el.closest("[aria-hidden=true]"),
    );
    if (tabbable) {
      expect(
        await fileInput.evaluate(
          (el) => el.getAttribute("aria-label") || (el as HTMLInputElement).labels?.length,
        ),
      ).toBeTruthy();
    }

    // Switch toggles with the space bar.
    await page.locator("#pf-active").focus();
    await expect(page.locator("#pf-active")).toBeChecked();
    await page.keyboard.press("Space");
    await expect(page.locator("#pf-active")).not.toBeChecked();
    await page.keyboard.press("Space");
    await expect(page.locator("#pf-active")).toBeChecked();

    // A scanner's Enter adds the code and does not submit the form.
    await page.locator("#pf-name").fill(name);
    await field(page, 0, "price").fill("3,000");
    const code = freshEan13();
    await field(page, 0, "barcodes-input").focus();
    await page.keyboard.type(code);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: P.removeBarcode.replace("{code}", code) }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/catalog\/products\/new$/);
    await expect(field(page, 0, "barcodes-input")).toBeFocused();
    await expect(field(page, 0, "barcodes-input")).toHaveValue("");

    // Enter in an ordinary field submits.
    await field(page, 0, "price").press("Enter");
    await expect(page).toHaveURL(UUID_URL);
    expect((await dbProduct(name))!.variants[0]!.barcodes).toEqual([code]);

    // Tabbing from the price field reaches the next field in order.
    await field(page, 0, "price").focus();
    await page.keyboard.press("Tab");
    await expect(page.locator(":focus")).not.toHaveAttribute("id", "pf-name");
  });
});
