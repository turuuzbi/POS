import { expect, test } from "@playwright/test";
import { mn } from "./fixtures";
import { expectNoHorizontalOverflow, signInAsOwner } from "./helpers/products";
import { insertE2eReceipt, type E2eReceipt } from "./helpers/receipts";

const R = mn.receipt;

let receipt: E2eReceipt;
test.beforeAll(async () => {
  receipt = await insertE2eReceipt();
});

test.describe("public receipt page", () => {
  test("shows the receipt without signing in, indexed nowhere", async ({ page }) => {
    const response = await page.goto(`/r/${receipt.token}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("article", { name: `${R.title} ${receipt.number}` })).toBeVisible();
    const sheet = page.locator("article.receipt-sheet");
    await expect(sheet).toContainText(receipt.number);
    await expect(sheet).toContainText("Сүү 1л");
    await expect(sheet).toContainText(R.change);
    await expect(sheet).toContainText("2026-10-15 01:30");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expectNoHorizontalOverflow(page);
  });

  test("fits a 390px phone and an 80 mm slip", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/r/${receipt.token}`);
    await expectNoHorizontalOverflow(page);
    const box = await page.locator("article.receipt-sheet").boundingBox();
    expect(box!.width).toBeLessThanOrEqual(80 * (96 / 25.4) + 1);
    for (const name of [R.actions.print, R.actions.shareLink, R.actions.downloadPdf]) {
      const target = page.getByRole(name === R.actions.downloadPdf ? "link" : "button", { name });
      const b = await target.boundingBox();
      expect(b!.height, name).toBeGreaterThanOrEqual(44);
    }
  });

  test("print media hides the toolbar and leaves only the slip", async ({ page }) => {
    await page.goto(`/r/${receipt.token}`);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("toolbar")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeHidden();
    await expect(page.locator("article.receipt-sheet")).toBeVisible();
    const box = await page.locator("article.receipt-sheet").boundingBox();
    expect(Math.round(box!.width)).toBe(Math.round(80 * (96 / 25.4)));
  });

  test("offers the 58 mm option", async ({ page }) => {
    await page.goto(`/r/${receipt.token}?paper=58`);
    await expect(page.locator("article.receipt-sheet")).toHaveAttribute("data-paper", "58");
  });

  test("downloads a PDF", async ({ request }) => {
    const response = await request.get(`/api/receipts/${receipt.token}/pdf`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toBe("application/pdf");
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = await response.body();
    expect(body.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  test("unknown, short and wrong tokens are not found", async ({ page, request }) => {
    const tampered = receipt.token.slice(0, -1) + (receipt.token.endsWith("A") ? "B" : "A");
    for (const token of ["short", "x".repeat(43), tampered]) {
      const response = await page.goto(`/r/${token}`);
      expect(response?.status(), token).toBe(404);
      const pdf = await request.get(`/api/receipts/${token}/pdf`);
      expect(pdf.status(), token).toBe(404);
    }
  });
});

test.describe("staff receipt page", () => {
  test("lets staff print, copy the share link and download the PDF", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signInAsOwner(page);
    await page.goto(`/receipt/${receipt.saleId}`);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(receipt.number);
    await expect(page.getByRole("button", { name: R.actions.print })).toBeVisible();
    await expect(page.getByRole("link", { name: R.actions.downloadPdf })).toHaveAttribute(
      "href",
      new RegExp(`/api/receipts/${receipt.token}/pdf`),
    );
    await page.getByRole("button", { name: R.actions.shareLink }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(new URL(`/r/${receipt.token}`, page.url()).toString());
  });

  test("needs a session, and unknown sales are not found", async ({ page }) => {
    await page.goto(`/receipt/${receipt.saleId}`);
    await expect(page).toHaveURL(/\/login/);
    await signInAsOwner(page);
    const response = await page.goto("/receipt/0193b7c4-0000-7000-8000-00000000ffff");
    expect(response?.status()).toBe(404);
  });
});
