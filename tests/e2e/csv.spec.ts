import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { mn, SEED, signInWithPassword } from "./fixtures";
import {
  chooseAndPreview,
  csv,
  csvFile,
  expectNoHorizontalOverflow,
  fileInput,
  issueRows,
  query,
  randomEan13,
  signInAsCashier,
  signInAsOwner,
  summaryValue,
  t,
  token,
  watchProblems,
} from "./helpers/csv";

const tc = mn.taxClasses;
const SEED_DEFAULT_TAX = "НӨАТ 10%";
const SEED_EXEMPT_TAX = "НӨАТ-аас чөлөөлөгдсөн";

const HEADER = [
  "product_key",
  "name",
  "description",
  "type",
  "unit",
  "category",
  "tax_class",
  "prices_include_tax",
  "track_stock",
  "option1_name",
  "variant_name",
  "sku",
  "barcodes",
  "option1",
  "price",
  "cost",
  "variant_active",
];
const row = (values: Record<string, string>) => HEADER.map((h) => values[h] ?? "");

async function openImport(page: Page) {
  await page.goto("/catalog/import-export");
  await expect(page.getByRole("heading", { name: t.title, level: 1 })).toBeVisible();
}

async function expectIssue(page: Page, code: keyof typeof t.codes, line: string, column?: string) {
  const match = issueRows(page).filter({ hasText: t.codes[code] });
  const hit = match.filter({
    has: page.locator("td:first-child", { hasText: new RegExp(`^${line}$`) }),
  });
  await expect(hit.first()).toBeVisible();
  if (column) await expect(hit.first().locator("td").nth(1)).toHaveText(column);
}

test.describe("catalog CSV import and export", () => {
  test("crafted file: preview, commit, data, export round trip", async ({ page }) => {
    const problems = watchProblems(page);
    const tok = token();
    const [ean1, ean2] = [randomEan13(), randomEan13()];
    const milkName = `Сүү "Алтан" ${tok}`;
    const formulaName = `=HYPERLINK("http://evil.example","x") ${tok}`;
    const content = csv(HEADER, [
      row({
        product_key: `milk-${tok}`,
        name: milkName,
        description: "Шинэхэн, цэвэр сүү\nХоёр мөр",
        type: "STANDARD",
        unit: "PIECE",
        tax_class: SEED_EXEMPT_TAX,
        prices_include_tax: "true",
        track_stock: "true",
        sku: `MLK-${tok}`,
        barcodes: `${ean1};${ean2}`,
        price: "12500.50",
        cost: "8000",
      }),
      row({
        product_key: `shirt-${tok}`,
        name: `Цамц ${tok}`,
        option1_name: "Хэмжээ",
        sku: `SH-S-${tok}`,
        option1: "S",
        price: "25000",
      }),
      row({
        product_key: `shirt-${tok}`,
        name: `Цамц ${tok}`,
        option1_name: "Хэмжээ",
        sku: `SH-M-${tok}`,
        option1: "M",
        price: "26000",
      }),
      row({ name: formulaName, description: "@SUM(1+1)", sku: `F1-${tok}`, price: "100" }),
      row({ name: `'=literal ${tok}`, sku: `F2-${tok}`, price: "200" }),
      row({ name: `+Нэмэлт ${tok}`, sku: `F3-${tok}`, price: "300" }),
    ]);

    await signInAsOwner(page);
    await openImport(page);
    await expectNoHorizontalOverflow(page);

    // Template download carries BOM, CRLF and the documented header.
    const templateDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: t.template.button }).click();
    const template = await readFile(await (await templateDownload).path(), "utf8");
    expect(template.startsWith("﻿product_key,name,")).toBe(true);
    expect(template).toContain("\r\n");
    expect(template).toContain("Талх");

    // Nothing to check yet: preview needs a file.
    await expect(page.getByRole("button", { name: t.import.preview, exact: true })).toBeDisabled();

    await chooseAndPreview(page, csvFile(content));
    await expect(page.getByRole("heading", { name: t.ready })).toBeVisible();
    await expect(summaryValue(page, t.summary.rows)).toHaveText("6");
    await expect(summaryValue(page, t.summary.create)).toHaveText("5");
    await expect(summaryValue(page, t.summary.update)).toHaveText("0");
    await expect(summaryValue(page, t.summary.newVariants)).toHaveText("6");
    await expect(page.getByRole("cell", { name: milkName, exact: true })).toBeVisible();
    // Preview writes nothing.
    expect(await query(`SELECT 1 FROM "Product" WHERE name LIKE '%' || $1`, [tok])).toHaveLength(0);
    await expectNoHorizontalOverflow(page);

    // Commit; a double click must not run it twice.
    await page.getByRole("button", { name: t.import.commit, exact: true }).dblclick();
    await expect(page.getByRole("heading", { name: t.committed })).toBeVisible();
    await expect(summaryValue(page, t.summary.create)).toHaveText("5");

    const rows = await query<{
      name: string;
      description: string | null;
      tax: string;
      sku: string;
      price: string;
      cost: string;
      codes: string | null;
    }>(
      `SELECT p.name, p.description, t.name AS tax, v.sku, v.price::text AS price, v.cost::text AS cost,
              (SELECT string_agg(code, ';' ORDER BY code) FROM "Barcode" b WHERE b."variantId" = v.id) AS codes
         FROM "ProductVariant" v
         JOIN "Product" p ON p.id = v."productId"
         JOIN "TaxClass" t ON t.id = p."taxClassId"
        WHERE p.name LIKE '%' || $1
        ORDER BY v.sku`,
      [tok],
    );
    expect(rows).toHaveLength(6);
    const bySku = new Map(rows.map((r) => [r.sku, r]));
    const milk = bySku.get(`MLK-${tok}`)!;
    expect(milk.name).toBe(milkName);
    expect(milk.description).toBe("Шинэхэн, цэвэр сүү\nХоёр мөр");
    expect(milk.tax).toBe(SEED_EXEMPT_TAX);
    expect(milk.price).toBe("1250050");
    expect(milk.cost).toBe("800000");
    expect(milk.codes).toBe([ean1, ean2].sort().join(";"));
    expect(bySku.get(`SH-S-${tok}`)!.price).toBe("2500000");
    expect(bySku.get(`SH-M-${tok}`)!.price).toBe("2600000");
    // Formula-looking text is stored as typed; the leading apostrophe is only an export escape.
    expect(bySku.get(`F1-${tok}`)!.name).toBe(formulaName);
    expect(bySku.get(`F1-${tok}`)!.description).toBe("@SUM(1+1)");
    expect(bySku.get(`F2-${tok}`)!.name).toBe(`=literal ${tok}`);
    expect(bySku.get(`F3-${tok}`)!.name).toBe(`+Нэмэлт ${tok}`);
    // New products default to the business default tax class.
    expect(bySku.get(`F3-${tok}`)!.tax).toBe(SEED_DEFAULT_TAX);

    // The products show up in the catalog; back returns to a clean import page.
    await page.goto(`/catalog/products?q=${encodeURIComponent(tok)}`);
    await expect(page.getByText(`Цамц ${tok}`).first()).toBeVisible();
    await expect(page.getByText(`+Нэмэлт ${tok}`).first()).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/catalog\/import-export$/);
    await expect(fileInput(page)).toBeVisible();
    await expect(page.getByRole("button", { name: t.import.preview, exact: true })).toBeDisabled();
    await page.goForward();
    await expect(page).toHaveURL(/\/catalog\/products/);
    await page.goBack();

    // Re-importing the same file changes nothing but updates.
    await chooseAndPreview(page, csvFile(content));
    await expect(page.getByRole("heading", { name: t.ready })).toBeVisible();
    await expect(summaryValue(page, t.summary.create)).toHaveText("0");
    await expect(summaryValue(page, t.summary.update)).toHaveText("5");
    await expect(summaryValue(page, t.summary.newVariants)).toHaveText("0");
    await expect(summaryValue(page, t.summary.updatedVariants)).toHaveText("6");
    await page.getByRole("button", { name: t.import.reset, exact: true }).click();

    // Export: BOM, CRLF, formula-escaped cells, then re-import unedited = no-op.
    const exportDownload = page.waitForEvent("download");
    await page.getByRole("link", { name: t.export.button }).click();
    const download = await exportDownload;
    expect(download.suggestedFilename()).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
    const exported = await readFile(await download.path(), "utf8");
    expect(exported.startsWith("﻿product_key,name,description,")).toBe(true);
    expect(exported).toContain("\r\n");
    expect(exported).toContain(`'=HYPERLINK(""http://evil.example"",""x"") ${tok}`);
    expect(exported).toContain(`'=literal ${tok}`);
    expect(exported).toContain(`'+Нэмэлт ${tok}`);
    expect(exported).toContain(`"Сүү ""Алтан"" ${tok}"`);
    expect(exported).toContain([ean1, ean2].sort().join(";"));

    await chooseAndPreview(page, csvFile(exported, "export.csv"));
    await expect(page.getByRole("heading", { name: t.ready })).toBeVisible();
    await expect(summaryValue(page, t.summary.create)).toHaveText("0");
    await expect(summaryValue(page, t.summary.newVariants)).toHaveText("0");
    await expect(summaryValue(page, t.summary.update)).not.toHaveText("0");
    // Nothing was committed by the no-op preview.
    expect(await query(`SELECT 1 FROM "Product" WHERE name LIKE '%' || $1`, [tok])).toHaveLength(5);

    expect(problems.problems).toEqual([]);
  });

  test("template file previews cleanly and writes nothing", async ({ page }) => {
    await signInAsOwner(page);
    await openImport(page);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: t.template.button }).click();
    const text = await readFile(await (await download).path(), "utf8");
    await chooseAndPreview(page, csvFile(text, "products-template.csv"));
    await expect(page.getByRole("heading", { name: t.ready })).toBeVisible();
    await expect(summaryValue(page, t.summary.rows)).toHaveText("3");
    await expect(issueRows(page)).toHaveCount(0);
  });

  test("error rows show line numbers and nothing is committed", async ({ page }) => {
    const tok = token();
    await signInAsOwner(page);
    await openImport(page);
    const content = csv(HEADER, [
      // Lines 2-3: a valid product whose description spans two physical lines.
      row({
        name: `Зөв бараа ${tok}`,
        description: "эхний мөр\nхоёр дахь мөр",
        sku: `OK-${tok}`,
        price: "1000",
      }),
      // Line 4: bad price.
      row({ name: `Буруу үнэ ${tok}`, sku: `BAD-${tok}`, price: "12,5x" }),
      // Line 5: missing name.
      row({ sku: `NONAME-${tok}`, price: "10" }),
    ]).concat(`short,row\r\n`, `${cellRowDuplicate(tok)}\r\n`);

    await chooseAndPreview(page, csvFile(content));
    await expect(page.getByRole("heading", { name: t.issues.heading })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: t.notCommitted })).toBeVisible();
    await expectIssue(page, "invalidMoney", "4", "price");
    await expectIssue(page, "required", "5", "name");
    await expectIssue(page, "columnCount", "6");
    await expectIssue(page, "duplicateInFile", "7");
    // No way to commit a file with errors.
    await expect(page.getByRole("button", { name: t.import.commit, exact: true })).toHaveCount(0);
    await expect(summaryValue(page, t.summary.create)).toHaveCount(0);
    expect(
      await query(`SELECT 1 FROM "ProductVariant" WHERE sku LIKE '%' || $1`, [tok]),
    ).toHaveLength(0);

    // Cancel returns to file choosing.
    await page.getByRole("button", { name: t.import.reset, exact: true }).click();
    await expect(page.getByRole("heading", { name: t.issues.heading })).toHaveCount(0);
    await expect(page.getByRole("button", { name: t.import.preview, exact: true })).toBeDisabled();

    // Database-level problems (unknown tax class) are reported with their line too.
    await chooseAndPreview(
      page,
      csvFile(
        csv(HEADER, [
          row({ name: `Нэг ${tok}`, sku: `ONE-${tok}`, price: "1" }),
          row({ name: `Хоёр ${tok}`, sku: `TWO-${tok}`, price: "2", tax_class: `Байхгүй ${tok}` }),
        ]),
      ),
    );
    await expectIssue(page, "unknownTaxClass", "3", "tax_class");
    expect(
      await query(`SELECT 1 FROM "ProductVariant" WHERE sku LIKE '%' || $1`, [tok]),
    ).toHaveLength(0);
  });

  test("invalid and oversize files get a clear message", async ({ page }) => {
    await signInAsOwner(page);
    await openImport(page);
    const preview = page.getByRole("button", { name: t.import.preview, exact: true });

    // Header only.
    await chooseAndPreview(page, csvFile("name,price\r\n"));
    await expectIssue(page, "empty", t.issues.fileLevel);

    // Zero-byte file.
    await fileInput(page).setInputFiles(csvFile(""));
    await preview.click();
    await expectIssue(page, "empty", t.issues.fileLevel);

    // Not UTF-8.
    await fileInput(page).setInputFiles(
      csvFile(Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xc3, 0x28])),
    );
    await preview.click();
    await expectIssue(page, "badEncoding", t.issues.fileLevel);

    // Unterminated quote.
    await fileInput(page).setInputFiles(csvFile('name,price\r\n"abc,1\r\n'));
    await preview.click();
    await expectIssue(page, "unterminatedQuote", "2");

    // Unknown and missing columns.
    await fileInput(page).setInputFiles(csvFile("name,colour\r\nA,red\r\n"));
    await preview.click();
    await expectIssue(page, "unknownColumn", "1");
    await expectIssue(page, "missingColumn", "1", "price");

    // Too many rows.
    await fileInput(page).setInputFiles(csvFile(`name,price\n${"a,1\n".repeat(5001)}`));
    await preview.click();
    await expectIssue(page, "tooManyRows", t.issues.fileLevel);

    // Over 2 MB is refused in the browser before upload.
    await fileInput(page).setInputFiles(csvFile(Buffer.alloc(2 * 1024 * 1024 + 1, "a")));
    await expect(page.getByRole("alert").filter({ hasText: t.tooLargeClient })).toBeVisible();
    await expect(preview).toBeDisabled();
  });

  test("works on a phone-width screen without overflow", async ({ page }) => {
    const problems = watchProblems(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAsOwner(page);
    await openImport(page);
    await expectNoHorizontalOverflow(page);
    await chooseAndPreview(page, csvFile("name,price\r\n,abc\r\n"));
    await expect(page.getByRole("heading", { name: t.issues.heading })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.goto("/settings/tax-classes");
    await expect(page.getByRole("heading", { name: tc.title, level: 1 })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(problems.problems).toEqual([]);
  });

  test("formula-injection cells in an existing catalog are neutralised on export", async ({
    page,
  }) => {
    const tok = token();
    await signInAsOwner(page);
    await openImport(page);
    await chooseAndPreview(
      page,
      csvFile(csv(HEADER, [row({ name: `\t@cmd ${tok}`, sku: `T-${tok}`, price: "5" })])),
    );
    await expect(page.getByRole("heading", { name: t.ready })).toBeVisible();
    await page.getByRole("button", { name: t.import.commit, exact: true }).click();
    await expect(page.getByRole("heading", { name: t.committed })).toBeVisible();
    const [stored] = await query<{ name: string }>(
      `SELECT name FROM "Product" WHERE name LIKE '%' || $1`,
      [tok],
    );
    expect(stored).toBeDefined();
    const response = await page.request.get("/api/catalog/export");
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");
    const body = await response.text();
    const record = body.split("\r\n").find((l) => l.includes(`T-${tok}`));
    expect(record).toBeDefined();
    // No cell in the record may begin with a formula trigger.
    for (const field of record!.match(/(?:^|,)("(?:[^"]|"")*"|[^,]*)/g) ?? []) {
      const value = field.replace(/^,/, "").replace(/^"/, "");
      expect(value).not.toMatch(/^[=+\-@\t\r]/);
    }
  });
});

function cellRowDuplicate(tok: string): string {
  // Same SKU as the valid first row, so it collides within the file.
  return row({ name: `Давхар ${tok}`, sku: `OK-${tok}`, price: "5" }).join(",");
}

test.describe("permissions", () => {
  test("manager reaches import/export but not tax classes", async ({ page }) => {
    await signInWithPassword(page, SEED.manager.email);
    await page.goto("/catalog/import-export");
    await expect(page.getByRole("heading", { name: t.title, level: 1 })).toBeVisible();
    await page.goto("/settings/tax-classes");
    await expect(page).toHaveURL(/\/forbidden$/);
    await expect(page.getByRole("heading", { name: mn.states.forbiddenTitle })).toBeVisible();
  });

  test("cashier cannot open the pages or download the export", async ({ page }) => {
    await signInAsCashier(page);
    await page.goto("/catalog/import-export");
    await expect(page).toHaveURL(/\/forbidden$/);
    await page.goto("/settings/tax-classes");
    await expect(page).toHaveURL(/\/forbidden$/);
    const response = await page.request.get("/api/catalog/export");
    expect(response.status()).toBe(403);
  });

  test("signed-out visitors get nothing", async ({ request }) => {
    const response = await request.get("/api/catalog/export", { maxRedirects: 0 });
    expect(response.status()).not.toBe(200);
    expect(await response.text()).not.toContain("product_key");
  });
});

test.describe("tax classes", () => {
  test("create, validate, edit, lock VAT, archive, restore, import usage", async ({ page }) => {
    const problems = watchProblems(page);
    const tok = token();
    const name = `Тест татвар ${tok}`;
    const exemptName = `Чөлөөлөгдсөн ${tok}`;
    await signInAsOwner(page);
    await page.goto("/settings/tax-classes");
    await expect(page.getByRole("heading", { name: tc.title, level: 1 })).toBeVisible();

    const rowOf = (n: string) => page.getByRole("row").filter({ hasText: n });
    const dialog = page.getByRole("dialog");
    const save = () => dialog.getByRole("button", { name: mn.common.save });

    // Validation errors sit next to the field, in Mongolian.
    await page.getByRole("button", { name: tc.new }).click();
    await expect(dialog.getByRole("heading", { name: tc.createTitle })).toBeVisible();
    await dialog.getByLabel(tc.name).fill("");
    await dialog.getByLabel(tc.vatRate).fill("abc");
    await dialog.getByLabel(tc.cityTaxRate).fill("150");
    await save().click();
    await expect(dialog.locator("#tax-class-name-error")).toHaveText(mn.validation.required);
    await expect(dialog.locator("#tax-class-vat-error")).toHaveText(mn.validation.invalid);
    await expect(dialog.locator("#tax-class-city-error")).toHaveText(mn.validation.invalid);
    await expect(dialog.getByLabel(tc.name)).toHaveAttribute("aria-invalid", "true");

    // Create (a double click must still create exactly one).
    await dialog.getByLabel(tc.name).fill(name);
    await dialog.getByLabel(tc.vatRate).fill("12.5");
    await dialog.getByLabel(tc.cityTaxRate).fill("2");
    await save().dblclick();
    await expect(dialog).toHaveCount(0);
    await expect(rowOf(name)).toContainText("12.5%");
    await expect(rowOf(name)).toContainText("2%");
    await expect(rowOf(name)).toContainText(tc.treatments.STANDARD);
    await expect(rowOf(name)).toContainText("Бараагүй");
    let stored = await query<{ vatRateBps: number; cityTaxRateBps: number; treatment: string }>(
      `SELECT "vatRateBps", "cityTaxRateBps", treatment FROM "TaxClass" WHERE name = $1`,
      [name],
    );
    expect(stored).toEqual([{ vatRateBps: 1250, cityTaxRateBps: 200, treatment: "STANDARD" }]);

    // A duplicate name is refused with a message, not a crash.
    await page.getByRole("button", { name: tc.new }).click();
    await dialog.getByLabel(tc.name).fill(name);
    await save().click();
    await expect(dialog.getByRole("alert")).toHaveText(mn.errors.CONFLICT);
    await dialog.getByRole("button", { name: mn.common.cancel }).click();
    await expect(dialog).toHaveCount(0);

    // Exempt locks VAT to 0, whatever was typed before.
    await page.getByRole("button", { name: tc.new }).click();
    await dialog.getByLabel(tc.name).fill(exemptName);
    await dialog.getByLabel(tc.vatRate).fill("15");
    await dialog.getByLabel(tc.treatment).selectOption("EXEMPT");
    await expect(dialog.getByLabel(tc.vatRate)).toBeDisabled();
    await expect(dialog.getByLabel(tc.vatRate)).toHaveValue("0");
    await expect(dialog.getByText(tc.noVatNote)).toBeVisible();
    await save().click();
    await expect(dialog).toHaveCount(0);
    await expect(rowOf(exemptName)).toContainText(tc.treatments.EXEMPT);
    await expect(rowOf(exemptName)).toContainText("0%");
    stored = await query(
      `SELECT "vatRateBps", "cityTaxRateBps", treatment FROM "TaxClass" WHERE name = $1`,
      [exemptName],
    );
    expect(stored).toEqual([{ vatRateBps: 0, cityTaxRateBps: 0, treatment: "EXEMPT" }]);

    // Editing: cancelled edits do not leak into the next open; zero-rated locks VAT.
    await rowOf(name).getByRole("button", { name: mn.common.edit }).click();
    await expect(dialog.getByRole("heading", { name: tc.editTitle })).toBeVisible();
    await dialog.getByLabel(tc.name).fill(`${name} (өөрчлөлт)`);
    await dialog.getByRole("button", { name: mn.common.cancel }).click();
    await expect(dialog).toHaveCount(0);
    await rowOf(name).getByRole("button", { name: mn.common.edit }).click();
    await expect(dialog.getByLabel(tc.name)).toHaveValue(name);
    await dialog.getByLabel(tc.treatment).selectOption("ZERO_RATED");
    await expect(dialog.getByLabel(tc.vatRate)).toHaveValue("0");
    await save().click();
    await expect(dialog).toHaveCount(0);
    await expect(rowOf(name)).toContainText(tc.treatments.ZERO_RATED);
    stored = await query(
      `SELECT "vatRateBps", "cityTaxRateBps", treatment FROM "TaxClass" WHERE name = $1`,
      [name],
    );
    expect(stored).toEqual([{ vatRateBps: 0, cityTaxRateBps: 200, treatment: "ZERO_RATED" }]);

    // The default class cannot be archived.
    await page
      .getByRole("row")
      .filter({ hasText: SEED_DEFAULT_TAX })
      .filter({ hasText: tc.defaultBadge })
      .getByRole("button", { name: mn.common.archive })
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.archive }).click();
    await expect(page.locator("[data-sonner-toast][data-type=error]")).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: tc.defaultBadge }).getByText(mn.common.archived),
    ).toHaveCount(0);

    // Archive another class; an import that names it is refused, restoring fixes it.
    await rowOf(exemptName).getByRole("button", { name: mn.common.archive }).click();
    await expect(page.getByRole("alertdialog")).toContainText(exemptName);
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.archive }).click();
    await expect(page.getByText(tc.archived, { exact: true })).toBeVisible();
    await expect(rowOf(exemptName).getByText(mn.common.archived, { exact: true })).toBeVisible();
    await expect(
      query(`SELECT "isActive" FROM "TaxClass" WHERE name = $1`, [exemptName]),
    ).resolves.toEqual([{ isActive: false }]);

    const sku = `TX-${tok}`;
    const productName = `Татвартай бараа ${tok}`;
    const file = csvFile(
      csv(HEADER, [row({ name: productName, sku, price: "700", tax_class: exemptName })]),
    );
    await openImport(page);
    await chooseAndPreview(page, file);
    await expectIssue(page, "inactive", "2", "tax_class");

    await page.goto("/settings/tax-classes");
    await rowOf(exemptName).getByRole("button", { name: mn.common.restore }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: mn.common.restore }).click();
    await expect(page.getByText(tc.restored, { exact: true })).toBeVisible();
    await expect(rowOf(exemptName).getByText(mn.common.archived, { exact: true })).toHaveCount(0);

    await openImport(page);
    await chooseAndPreview(page, file);
    await expect(page.getByRole("heading", { name: t.ready })).toBeVisible();
    await page.getByRole("button", { name: t.import.commit, exact: true }).click();
    await expect(page.getByRole("heading", { name: t.committed })).toBeVisible();

    await page.goto("/settings/tax-classes");
    await expect(rowOf(exemptName)).toContainText("1 бараа");
    expect(
      await query(
        `SELECT t.name FROM "Product" p JOIN "TaxClass" t ON t.id = p."taxClassId" WHERE p.name = $1`,
        [productName],
      ),
    ).toEqual([{ name: exemptName }]);

    await expectNoHorizontalOverflow(page);
    expect(problems.problems.filter((p) => !p.includes("sonner"))).toEqual([]);
  });
});
