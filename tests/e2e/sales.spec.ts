import { expect, test, type Page } from "@playwright/test";
import { mn } from "./fixtures";
import { expectNoHorizontalOverflow, signInAsCashier, signInAsOwner } from "./helpers/products";
import { insertE2eSalesSet, type E2eSalesSet } from "./helpers/sales";

const S = mn.sales;
const R = mn.receipt;

let set: E2eSalesSet;
test.beforeAll(async () => {
  set = await insertE2eSalesSet();
});

const row = (page: Page, number: string) => page.locator(`tr[data-sale-number="${number}"]`);

/** The share token of a credit note / void slip, read off the staff page's PDF link. */
async function shareToken(page: Page, kind: "refund" | "void", path: string): Promise<string> {
  await page.goto(path);
  const href = await page.getByRole("link", { name: R.actions.downloadPdf }).getAttribute("href");
  const match = new RegExp(`/api/receipts/${kind}/([^/]+)/pdf`).exec(href ?? "");
  expect(match, href ?? "").not.toBeNull();
  return decodeURIComponent(match![1]!);
}

test.describe("sales history list", () => {
  test("shows each sale with its derived status, and totals", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto(`/sales?q=${set.tag}`);
    await expect(page.getByRole("heading", { level: 1, name: S.title })).toBeVisible();
    await expect(page.locator("tbody tr")).toHaveCount(5);
    const status = (number: string) => row(page, number).locator("[data-status]");
    await expect(status(set.completed.number)).toHaveAttribute("data-status", "COMPLETED");
    await expect(status(set.voided.number)).toHaveAttribute("data-status", "VOIDED");
    await expect(status(set.partial.number)).toHaveAttribute("data-status", "PARTIALLY_REFUNDED");
    await expect(status(set.refunded.number)).toHaveAttribute("data-status", "REFUNDED");
    await expect(status(set.partial.number)).toHaveText(S.status.PARTIALLY_REFUNDED);

    // 4 non-voided sales of 1 000 ₮; refunds 600 + 1 000 ₮; one voided sale.
    await expect(page.getByTestId("total-count")).toContainText("5");
    await expect(page.getByTestId("total-gross")).toContainText("4,000");
    await expect(page.getByTestId("total-refunded")).toContainText("1,600");
    await expect(page.getByTestId("total-net")).toContainText("2,400");
    await expect(page.getByTestId("total-voided")).toContainText("1,000");
    await expectNoHorizontalOverflow(page);
  });

  test("filters by status, payment method, amount and date", async ({ page }) => {
    await signInAsOwner(page);
    const search = async (query: string) => {
      await page.goto(`/sales?q=${set.tag}&${query}`);
      return page.locator("tbody tr[data-sale-number]");
    };

    await expect(await search("status=VOIDED")).toHaveCount(1);
    await expect(row(page, set.voided.number)).toBeVisible();
    await expect(await search("status=REFUNDED")).toHaveCount(1);
    await expect(await search("status=COMPLETED")).toHaveCount(2);
    await expect(await search("method=QPAY")).toHaveCount(1);
    await expect(row(page, set.partial.number)).toBeVisible();
    await expect(await search("method=CARD")).toHaveCount(1);
    await expect(await search("min=1000&max=1000")).toHaveCount(5);
    await expect(await search("min=1000.01")).toHaveCount(0);
    await expect(page.getByText(S.list.empty)).toBeVisible();
    await expect(await search(`from=${set.day}&to=${set.day}`)).toHaveCount(5);
    await expect(await search("from=2026-10-15")).toHaveCount(0);
    await expect(await search("to=2026-10-13")).toHaveCount(0);
    // An inverted range is reported, never silently empty.
    await search("from=2026-10-15&to=2026-10-01");
    await expect(page.getByRole("status").filter({ hasText: S.filters.invalid })).toBeVisible();
  });

  test("the filter form applies filters and keeps them in the URL", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/sales");
    await page.getByLabel(S.filters.search).fill(set.tag);
    await page.getByLabel(S.filters.status, { exact: true }).selectOption("PARTIALLY_REFUNDED");
    await page.getByRole("button", { name: S.filters.apply }).click();
    await expect(page).toHaveURL(new RegExp(`q=${set.tag}.*status=PARTIALLY_REFUNDED`));
    await expect(page.locator("tbody tr[data-sale-number]")).toHaveCount(1);
    await expect(page.getByLabel(S.filters.status, { exact: true })).toHaveValue(
      "PARTIALLY_REFUNDED",
    );
    await page.getByRole("link", { name: S.filters.reset }).click();
    await expect(page).toHaveURL(/\/sales$/);
  });

  test("works on a 360px phone", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await signInAsOwner(page);
    await page.goto(`/sales?q=${set.tag}`);
    await expect(page.locator("tbody tr[data-sale-number]")).toHaveCount(5);
    await expectNoHorizontalOverflow(page);
    const box = await page.getByRole("button", { name: S.filters.apply }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });

  test("is closed to cashiers", async ({ page }) => {
    await signInAsCashier(page);
    await page.goto("/sales");
    await expect(page).toHaveURL(/\/forbidden/);
    const csv = await page.request.get("/sales/export");
    expect(csv.status()).toBe(403);
  });
});

test.describe("sale detail", () => {
  test("shows lines, payments, taxes, refunds and approvals", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto(`/sales?q=${set.tag}`);
    await row(page, set.partial.number).getByRole("link", { name: set.partial.number }).click();
    await expect(page).toHaveURL(new RegExp(`/sales/${set.partial.id}$`));
    await expect(
      page.getByRole("heading", {
        level: 1,
        name: S.detail.heading.replace("{number}", set.partial.number),
      }),
    ).toBeVisible();
    await expect(page.locator("[data-status]").first()).toHaveAttribute(
      "data-status",
      "PARTIALLY_REFUNDED",
    );

    const lines = page.getByRole("region", { name: S.detail.lines.title });
    await expect(lines).toContainText(`Сүү ${set.tag}`);
    await expect(lines).toContainText(`Талх ${set.tag}`);
    const payments = page.getByRole("region", { name: S.detail.payments.title });
    await expect(payments).toContainText(mn.receipt.method.QPAY);
    await expect(page.getByRole("region", { name: S.detail.taxes.title })).toContainText("10%");

    const refunds = page.getByRole("region", { name: S.detail.refunds.title });
    await expect(refunds).toContainText(`PR-R-${set.tag}`);
    await expect(refunds).toContainText("-600");
    await expect(refunds).toContainText(mn.receipt.refund.reasons.DAMAGED);

    const approvals = page.getByRole("region", { name: S.detail.approvals.title });
    await expect(approvals).toContainText(S.detail.approvals.kinds.refund);
    await expect(approvals).toContainText("Сарантуяа");
    await expect(page.getByRole("region", { name: S.detail.fiscal.title })).toContainText(
      S.detail.fiscal.statuses.NONE,
    );
    await expectNoHorizontalOverflow(page);

    // Links to the receipt, the share link and the credit note.
    await expect(page.getByRole("link", { name: S.detail.openReceipt })).toHaveAttribute(
      "href",
      `/receipt/${set.partial.id}`,
    );
    await expect(page.getByTestId("share-link")).toHaveAttribute("href", `/r/${set.partial.token}`);
    await refunds.getByRole("link", { name: `PR-R-${set.tag}` }).click();
    await expect(page).toHaveURL(new RegExp(`/receipt/refund/${set.partial.refundIds[0]}`));
    await expect(page.locator("article.receipt-sheet")).toContainText(R.refund.title);
  });

  test("a voided sale shows the void and links to its slip", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto(`/sales/${set.voided.id}`);
    const voided = page.getByRole("region", { name: S.detail.void.title });
    await expect(voided).toContainText(mn.receipt.voidSlip.reasons.ENTRY_ERROR);
    await expect(voided).toContainText("Сарантуяа");
    await page.getByRole("link", { name: S.detail.voidSlip }).click();
    await expect(page.locator("article.receipt-sheet")).toContainText(R.voidSlip.title);
  });

  test("unknown sales are not found", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto("/sales/0193b7c4-0000-7000-8000-00000000ffff");
    await expect(page.getByRole("heading", { name: mn.states.notFoundTitle })).toBeVisible();
    await page.goto("/sales/not-a-uuid");
    await expect(page.getByRole("heading", { name: mn.states.notFoundTitle })).toBeVisible();
  });
});

test.describe("CSV export", () => {
  test("downloads the filtered list: BOM, header, one line per sale, formula-safe", async ({
    page,
  }) => {
    await signInAsOwner(page);
    await page.goto(`/sales?q=${set.tag}`);
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: S.filters.export }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^sales-\d{4}-\d{2}-\d{2}\.csv$/);

    const response = await page.request.get(`/sales/export?q=${set.tag}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/csv");
    expect(response.headers()["cache-control"]).toContain("no-store");
    const bytes = await response.body();
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const lines = bytes.toString("utf8").slice(1).trimEnd().split("\r\n");
    expect(lines).toHaveLength(6); // header + 5 sales
    expect(lines[0]).toBe(
      [
        S.csv.number,
        S.csv.date,
        S.csv.location,
        S.csv.register,
        S.csv.cashier,
        S.csv.methods,
        S.csv.total,
        S.csv.refunded,
        S.csv.status,
      ].join(","),
    );
    const partial = lines.find((l) => l.startsWith(set.partial.number))!;
    expect(partial).toContain("2026-10-14 18:00");
    expect(partial).toContain(",1000,600,");
    expect(partial.endsWith(S.status.PARTIALLY_REFUNDED)).toBe(true);
    // A receipt number starting with "=" must not execute as a formula in a spreadsheet.
    expect(lines.some((l) => l.startsWith(`'=1+1-${set.tag}`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`=1+1-${set.tag}`))).toBe(false);

    // The same filters narrow the export.
    const voidedOnly = await page.request.get(`/sales/export?q=${set.tag}&status=VOIDED`);
    const voidedLines = (await voidedOnly.text()).slice(1).trimEnd().split("\r\n");
    expect(voidedLines).toHaveLength(2);
  });

  test("needs a session", async ({ request }) => {
    const response = await request.get("/sales/export");
    expect(response.status()).toBe(401);
  });
});

test.describe("credit note (refund receipt)", () => {
  test("renders the credit note on a 390px phone with the right facts", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInAsOwner(page);
    await page.goto(`/receipt/refund/${set.partial.refundIds[0]}`);
    const sheet = page.locator("article.receipt-sheet");
    await expect(sheet).toContainText(R.refund.title);
    await expect(sheet).toContainText(`PR-R-${set.tag}`);
    await expect(sheet).toContainText(`${R.refund.originalReceiptNo}`);
    await expect(sheet).toContainText(set.partial.number);
    await expect(sheet).toContainText(`Сүү ${set.tag}`);
    await expect(sheet).not.toContainText(`Талх ${set.tag}`);
    await expect(sheet).toContainText("-600");
    await expect(sheet).toContainText(R.refund.reasons.DAMAGED);
    await expect(sheet).toContainText("Сарантуяа"); // approver
    await expect(sheet).toContainText(R.refund.fiscalPending); // TODO(ebarimt) placeholder
    await expect(sheet).not.toContainText(set.internalNote);
    await expectNoHorizontalOverflow(page);
    const box = await sheet.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(80 * (96 / 25.4) + 1);
    for (const [role, name] of [
      ["button", R.actions.print],
      ["button", R.actions.shareLink],
      ["link", R.actions.downloadPdf],
    ] as const) {
      const b = await page.getByRole(role, { name }).boundingBox();
      expect(b!.height, name).toBeGreaterThanOrEqual(44);
    }
  });

  test("print CSS leaves only the slip, 80 mm wide", async ({ page }) => {
    await signInAsOwner(page);
    await page.goto(`/receipt/refund/${set.partial.refundIds[0]}`);
    await page.emulateMedia({ media: "print" });
    await expect(page.getByRole("toolbar")).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeHidden();
    const box = await page.locator("article.receipt-sheet").boundingBox();
    expect(Math.round(box!.width)).toBe(Math.round(80 * (96 / 25.4)));
    await page.emulateMedia({ media: "screen" });
    await page.goto(`/receipt/refund/${set.partial.refundIds[0]}?paper=58`);
    await expect(page.locator("article.receipt-sheet")).toHaveAttribute("data-paper", "58");
  });

  test("is scoped to staff: needs a session and unknown refunds are not found", async ({
    page,
  }) => {
    await page.goto(`/receipt/refund/${set.partial.refundIds[0]}`);
    await expect(page).toHaveURL(/\/login/);
    await signInAsOwner(page);
    const response = await page.goto("/receipt/refund/0193b7c4-0000-7000-8000-00000000ffff");
    expect(response?.status()).toBe(404);
  });

  test("the public share page shows the credit note without signing in and no internal data", async ({
    page,
    browser,
    request,
  }) => {
    await signInAsOwner(page);
    const token = await shareToken(page, "refund", `/receipt/refund/${set.partial.refundIds[0]}`);

    const anonymous = await browser.newContext({ locale: "mn-MN", timezoneId: "Asia/Ulaanbaatar" });
    try {
      const anon = await anonymous.newPage();
      const response = await anon.goto(`/r/refund/${token}`);
      expect(response?.status()).toBe(200);
      await expect(anon.locator("article.receipt-sheet")).toContainText(R.refund.title);
      await expect(anon.locator("article.receipt-sheet")).toContainText(set.partial.number);
      await expect(anon.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
      await expectNoHorizontalOverflow(anon);
      const html = await anon.content();
      for (const secret of [
        set.internalNote,
        set.partial.refundIds[0]!,
        set.partial.id,
        set.partial.token,
      ]) {
        expect(html, secret).not.toContain(secret);
      }
      // No app chrome or staff navigation on the public page.
      await expect(anon.getByRole("navigation", { name: mn.nav.label })).toHaveCount(0);
    } finally {
      await anonymous.close();
    }

    const pdf = await request.get(`/api/receipts/refund/${token}/pdf`);
    expect(pdf.status()).toBe(200);
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    expect((await pdf.body()).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  test("wrong, tampered and other-kind tokens are not found", async ({ page, request }) => {
    await signInAsOwner(page);
    const token = await shareToken(page, "refund", `/receipt/refund/${set.partial.refundIds[0]}`);
    const [idPart, sig] = token.split(".") as [string, string];
    const tampered = `${idPart}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    for (const bad of ["short", "x".repeat(43), tampered, set.partial.token, idPart]) {
      for (const path of [`/r/refund/${bad}`, `/r/void/${bad}`]) {
        const r = await request.get(path);
        expect(r.status(), path).toBe(404);
      }
      const pdf = await request.get(`/api/receipts/refund/${bad}/pdf`);
      expect(pdf.status(), bad).toBe(404);
    }
    // A refund token does not open the void routes (or a sale receipt).
    expect((await request.get(`/r/void/${token}`)).status()).toBe(404);
    expect((await request.get(`/r/${token}`)).status()).toBe(404);
    expect((await request.get(`/api/receipts/void/${token}/pdf`)).status()).toBe(404);
  });
});

test.describe("void slip", () => {
  test("renders for staff and publicly by its own token", async ({ page, request }) => {
    await signInAsOwner(page);
    await page.goto(`/receipt/void/${set.voided.id}`);
    const sheet = page.locator("article.receipt-sheet");
    await expect(sheet).toContainText(R.voidSlip.title);
    await expect(sheet).toContainText(set.voided.number);
    await expect(sheet).toContainText(R.voidSlip.reasons.ENTRY_ERROR);
    const token = await shareToken(page, "void", `/receipt/void/${set.voided.id}`);
    const response = await request.get(`/r/void/${token}`);
    expect(response.status()).toBe(200);
    expect(await response.text()).toContain(R.voidSlip.title);
    // Not available for a sale that was never voided.
    const notVoided = await page.goto(`/receipt/void/${set.completed.id}`);
    expect(notVoided?.status()).toBe(404);
  });
});

test.describe("refunded banner on the original receipt", () => {
  test("shows partial and full refunds on the public receipt", async ({ page, request }) => {
    const partial = await request.get(`/r/${set.partial.token}`);
    const partialHtml = await partial.text();
    expect(partialHtml).toContain(R.partiallyRefundedBanner);
    expect(partialHtml).toContain(`PR-R-${set.tag}`);

    await page.goto(`/r/${set.refunded.token}`);
    const sheet = page.locator("article.receipt-sheet");
    await expect(sheet).toContainText(R.refundedBanner);
    await expect(sheet).toContainText(`FR-R1-${set.tag}`);
    await expect(sheet).toContainText(`FR-R2-${set.tag}`);

    await page.goto(`/r/${set.completed.token}`);
    await expect(page.locator("article.receipt-sheet")).not.toContainText(R.refundedBanner);
  });
});
