import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { mn, SEED, signInWithPassword, signOut } from "./fixtures";
import {
  addByName,
  completeSale,
  endRegister,
  MANAGER_PIN,
  minor,
  mnt,
  openShiftWithFloat,
  payCash,
  product,
  receiptNumberOnScreen,
  retireCreated,
  sql,
  startNewSale,
  startRegister,
  tenderDialog,
  chargeButton,
  cartLines,
  type RegisterSession,
} from "./helpers/checkout";

/**
 * Phase 3 shifts, end to end against a production build: open, sell, cash in/out
 * with a manager's approval, X report, blind close with denominations and a
 * variance, the Z report (printable), the back-office list and detail, and what a
 * cashier may not do.
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

/** `window.print` is recorded instead of opening the print dialog. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __prints: number; print: () => void };
    w.__prints = 0;
    w.print = () => {
      w.__prints += 1;
    };
  });
}
const printCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __prints?: number }).__prints ?? 0);

async function openShiftMenu(page: Page, item: string) {
  await page.getByTestId("shift-menu").click();
  await page.getByRole("menuitem", { name: item }).click();
}

const cashDialog = (page: Page) => page.getByRole("dialog", { name: mn.shifts.cash.title });

async function moveCash(
  page: Page,
  options: { type: "in" | "out"; amountMajor: number; reason: string },
) {
  await openShiftMenu(page, mn.shifts.menu.cash);
  const dialog = cashDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("radio", { name: mn.shifts.cash[options.type] }).click();
  await dialog.getByLabel(mn.shifts.cash.amount).fill(String(options.amountMajor));
  await dialog.getByLabel(mn.shifts.cash.reason).fill(options.reason);
  await dialog.getByRole("button", { name: mn.shifts.cash.submit }).click();
}

/** The cashier has no `pos.cash_movement`: the server asks for a manager PIN. */
async function approveMovement(page: Page) {
  const approval = page.getByTestId("cash-approval");
  await expect(approval).toBeVisible();
  await approval.getByLabel(mn.shifts.cash.pin).fill(MANAGER_PIN);
  await approval.getByRole("button", { name: mn.shifts.cash.approve }).click();
}

async function setCount(page: Page, denomination: number, count: number) {
  await page.getByTestId(`denomination-${denomination}`).getByRole("textbox").fill(String(count));
}

test.describe("shift life cycle", () => {
  test("open, sell, cash in/out, X report, blind close with variance, Z report, admin views", async ({
    page,
    browser,
  }) => {
    const suffix = uniq();
    const reg = (session = await startRegister(page, { shift: false }));
    const item = await product(reg.locationId, { label: "Item", price: 3_800, suffix });

    // -- open (float 50 000 ₮) and sell one item for cash ------------------------------
    await openShiftWithFloat(page, 50_000);
    const [shift] = await sql<{ id: string }>(
      `SELECT id FROM "Shift" WHERE "registerId" = $1 AND status = 'OPEN'`,
      [reg.registerId],
    );
    const shiftId = shift!.id;

    await addByName(page, item.name);
    await expect(cartLines(page)).toHaveCount(1);
    await chargeButton(page).click();
    await expect(tenderDialog(page)).toBeVisible();
    await payCash(page, 4_000);
    await completeSale(page);
    const receipt = await receiptNumberOnScreen(page);
    await startNewSale(page);

    // -- cash in / out: the cashier needs a manager's PIN, bound to type and amount ------
    await moveCash(page, { type: "in", amountMajor: 2_000, reason: "float top-up" });
    await approveMovement(page);
    await expect(page.getByText(mn.shifts.cash.recorded)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    await moveCash(page, { type: "out", amountMajor: 1_000, reason: "courier" });
    await approveMovement(page);
    await expect(page.getByText(mn.shifts.cash.recorded)).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const movements = await sql<{
      type: string;
      amount: string;
      reason: string;
      createdById: string;
      approvedById: string | null;
    }>(
      `SELECT type::text, amount::text, reason, "createdById", "approvedById"
         FROM "CashMovement" WHERE "shiftId" = $1 ORDER BY "createdAt"`,
      [shiftId],
    );
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({
      type: "CASH_IN",
      amount: "200000",
      reason: "float top-up",
    });
    expect(movements[1]).toMatchObject({ type: "CASH_OUT", amount: "100000" });
    for (const m of movements) {
      expect(m.createdById).toBe(reg.cashierId);
      expect(m.approvedById).not.toBeNull();
      expect(m.approvedById).not.toBe(reg.cashierId);
    }

    // A pay-out beyond the drawer needs the second (overdraw) approval; abandon it.
    await moveCash(page, { type: "out", amountMajor: 900_000, reason: "too much" });
    await approveMovement(page);
    await expect(page.getByTestId("cash-approval")).toContainText(mn.shifts.cash.approvalOverdraw);
    await page
      .getByTestId("cash-approval")
      .getByRole("button", { name: mn.shifts.cash.back })
      .click();
    await cashDialog(page).getByRole("button", { name: mn.shifts.cash.back }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect((await sql(`SELECT 1 FROM "CashMovement" WHERE "shiftId" = $1`, [shiftId])).length).toBe(
      2,
    );

    // -- X report: live totals, expected cash hidden for a cashier, printable -------------
    await stubPrint(page);
    await openShiftMenu(page, mn.shifts.menu.xReport);
    const xDialog = page.getByRole("dialog", { name: mn.shifts.report.titleX });
    await expect(xDialog.getByTestId("sales-total")).toHaveText(mnt(380_000));
    await expect(xDialog.getByTestId("tender-CASH")).toHaveText(mnt(380_000));
    await expect(xDialog.getByText(mn.shifts.report.expectedHidden)).toBeVisible();
    await expect(xDialog.getByTestId("expected-cash")).toHaveCount(0);
    // Server-side blind close: none of the components of the expected cash is on the page either.
    for (const label of [
      mn.shifts.report.openingFloat,
      mn.shifts.report.cashSales,
      mn.shifts.report.cashIn,
      mn.shifts.report.cashOut,
    ]) {
      await expect(xDialog.getByText(label, { exact: true })).toHaveCount(0);
    }
    await xDialog.getByTestId("report-print").click();
    expect(await printCalls(page)).toBe(1);
    // Print media: only the report remains.
    await page.emulateMedia({ media: "print" });
    await expect(xDialog.locator(".shift-print")).toBeVisible();
    await expect(page.locator("header").first()).toBeHidden();
    await expect(xDialog.getByRole("button", { name: mn.shifts.report.print })).toBeHidden();
    await page.emulateMedia({ media: "screen" });
    await page.keyboard.press("Escape");
    await expect(xDialog).toHaveCount(0);

    // -- a cart with items warns before closing ---------------------------------------------
    await addByName(page, item.name);
    await expect(cartLines(page)).toHaveCount(1);

    // -- blind close: count first; expected (54 800 ₮) is not on screen ------------------
    await openShiftMenu(page, mn.shifts.menu.close);
    // The dialog title changes once the shift is closed, so address it by role alone.
    const closeDialog = page.getByRole("dialog");
    await expect(page.getByRole("dialog", { name: mn.shifts.close.title })).toBeVisible();
    await expect(closeDialog.getByTestId("close-count")).toBeVisible();
    await expect(closeDialog.getByText(/Сагсанд 1 бараа байна/)).toBeVisible();
    await expect(closeDialog.getByText(mnt(5_480_000))).toHaveCount(0);
    // The steppers work: + then edit.
    const row20000 = closeDialog.getByTestId("denomination-20000");
    await row20000.getByRole("button").nth(1).click();
    await expect(row20000.getByRole("textbox")).toHaveValue("1");
    await setCount(page, 20000, 2);
    await setCount(page, 10000, 1);
    await setCount(page, 1000, 3);
    await expect(closeDialog.getByTestId("counted-total")).toHaveText(mnt(5_300_000));
    await closeDialog.getByRole("button", { name: mn.shifts.close.review }).click();
    await expect(closeDialog.getByTestId("close-confirm")).toContainText(mnt(5_300_000));
    await closeDialog.getByRole("button", { name: mn.shifts.close.confirm }).click();

    // 1 800 ₮ short exceeds the 1 000 ₮ threshold: a note is required.
    await expect(
      closeDialog.getByRole("alert").filter({ hasText: mn.shifts.errors.VARIANCE_NOTE_REQUIRED }),
    ).toBeVisible();
    await expect(closeDialog.getByTestId("close-count")).toBeVisible();
    expect(
      (await sql(`SELECT 1 FROM "Shift" WHERE id = $1 AND status = 'OPEN'`, [shiftId])).length,
    ).toBe(1);
    await closeDialog.getByLabel(mn.shifts.close.note).fill("Drawer short after the courier");
    await closeDialog.getByRole("button", { name: mn.shifts.close.review }).click();
    await closeDialog.getByRole("button", { name: mn.shifts.close.confirm }).click();

    // After closing: expected, counted, variance and the Z report; sign out is offered.
    const result = closeDialog.getByTestId("close-result");
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.getByTestId("result-variance")).toHaveText(mnt(-180_000));
    await expect(result.getByTestId("result-class")).toHaveText(
      mn.shifts.report.classification.SHORT,
    );
    await expect(result).toContainText(mnt(5_480_000));
    const z = closeDialog.getByTestId("z-report");
    await expect(z.getByTestId("variance")).toHaveText(mnt(-180_000));
    await expect(z.getByTestId("counted-cash")).toHaveText(mnt(5_300_000));
    await expect(z.getByTestId("expected-cash")).toHaveText(mnt(5_480_000));
    await expect(z.getByTestId("sales-total")).toHaveText(mnt(380_000));
    await expect(closeDialog.getByRole("button", { name: mn.shifts.close.signOut })).toBeVisible();
    await stubPrint(page);
    await z.getByTestId("report-print").click();
    expect(await printCalls(page)).toBe(1);

    // Database: closed, frozen report, audit.
    const [closed] = await sql<{
      status: string;
      expectedCash: string;
      countedCash: string;
      cashVariance: string;
      closingNote: string;
      closedById: string;
      denominations: Record<string, number>;
    }>(
      `SELECT status::text, "expectedCash"::text, "countedCash"::text, "cashVariance"::text,
              "closingNote", "closedById", denominations
         FROM "Shift" WHERE id = $1`,
      [shiftId],
    );
    expect(closed).toMatchObject({
      status: "CLOSED",
      expectedCash: "5480000",
      countedCash: "5300000",
      cashVariance: "-180000",
      closingNote: "Drawer short after the courier",
      closedById: reg.cashierId,
    });
    expect(closed!.denominations).toMatchObject({ "20000": 2, "10000": 1, "1000": 3 });
    const [zrow] = await sql<{ number: number; saleCount: number }>(
      `SELECT number, (data->>'saleCount')::int AS "saleCount" FROM "ZReport" WHERE "shiftId" = $1`,
      [shiftId],
    );
    expect(zrow).toMatchObject({ saleCount: 1 });

    // Done: the register goes back to the open-shift screen.
    await closeDialog.getByRole("button", { name: mn.shifts.close.done }).click();
    await expect(page.getByTestId("open-shift")).toBeVisible();

    // -- a cashier has no back-office reports -----------------------------------------------
    await page.goto("/shifts");
    await expect(page).toHaveURL(/\/forbidden/);

    // -- back office: a manager sees the variance in the list and the detail ------------------
    const adminContext = await browser.newContext({
      locale: "mn-MN",
      timezoneId: "Asia/Ulaanbaatar",
    });
    try {
      const admin = await adminContext.newPage();
      await signInWithPassword(admin, SEED.manager.email);
      await admin.goto(`/shifts?register=${reg.registerId}&status=CLOSED`);
      await expect(admin.getByRole("heading", { name: mn.shifts.title, level: 1 })).toBeVisible();
      await expect(admin.getByTestId("variance-summary")).toContainText(
        mn.shifts.list.summaryShort,
      );
      const row = admin.getByTestId("shift-row").first();
      await expect(row.locator('[data-variance="SHORT"]')).toBeVisible();
      await expect(row).toContainText(mnt(-180_000));
      await row.getByRole("link").first().click();
      await expect(admin).toHaveURL(new RegExp(`/shifts/${shiftId}$`));

      await expect(admin.getByTestId("detail-variance")).toContainText(mnt(-180_000));
      await expect(admin.getByTestId("movement-row")).toHaveCount(2);
      await expect(admin.getByTestId("movement-row").first()).toContainText("float top-up");
      const report = admin.locator(".shift-print");
      await expect(report.getByTestId("variance")).toHaveText(mnt(-180_000));
      await expect(report.getByTestId("expected-cash")).toHaveText(mnt(5_480_000));
      await expect(report).toContainText(receipt);

      // Printable: A4 and 80 mm, and in print media only the report remains.
      await stubPrint(admin);
      await admin.getByRole("button", { name: mn.shifts.paper.a4 }).click();
      await expect(admin.locator('.shift-print[data-paper="A4"]')).toBeVisible();
      await admin.getByTestId("report-print").click();
      expect(await printCalls(admin)).toBe(1);
      await admin.emulateMedia({ media: "print" });
      await expect(admin.locator(".shift-print")).toBeVisible();
      await expect(admin.getByRole("navigation").first()).toBeHidden();
      await expect(admin.locator("aside")).toBeHidden();
      await admin.emulateMedia({ media: "screen" });

      // The list's filters narrow by status.
      await admin.goto(`/shifts?register=${reg.registerId}&status=OPEN`);
      await expect(admin.getByTestId("shift-row")).toHaveCount(0);
    } finally {
      await adminContext.close();
    }
  });

  test("a manager at the till pays out without a second person", async ({ page }) => {
    const reg = (session = await startRegister(page, { shift: true }));
    // Sign the cashier out and the manager in on the same tablet (PIN).
    await signOut(page, SEED.cashier.name, mn.auth.lock);
    await signInWithPassword(page, SEED.manager.email);
    await page.goto("/register");

    await moveCash(page, { type: "out", amountMajor: 1_000, reason: "bank run" });
    await expect(page.getByText(mn.shifts.cash.recorded)).toBeVisible();
    const [row] = await sql<{ approvedById: string | null; createdById: string }>(
      `SELECT m."approvedById", m."createdById" FROM "CashMovement" m
         JOIN "Shift" s ON s.id = m."shiftId"
        WHERE s."registerId" = $1 AND s.status = 'OPEN'`,
      [reg.registerId],
    );
    expect(row!.approvedById).toBeNull();
    expect(row!.createdById).not.toBe(reg.cashierId);

    // A manager sees the expected cash in the X report (no blind close for them).
    await openShiftMenu(page, mn.shifts.menu.xReport);
    const xDialog = page.getByRole("dialog", { name: mn.shifts.report.titleX });
    // float 50 000 ₮ - 1 000 ₮ = 49 000 ₮
    await expect(xDialog.getByTestId("expected-cash")).toHaveText(mnt(minor(49_000)));
  });

  test("the close flow fits a 360px phone with 44px touch targets", async ({ page }) => {
    session = await startRegister(page, { shift: true });
    await page.setViewportSize({ width: 360, height: 740 });
    await openShiftMenu(page, mn.shifts.menu.close);
    const dialog = page.getByRole("dialog", { name: mn.shifts.close.title });
    await expect(dialog.getByTestId("close-count")).toBeVisible();
    const overflow = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]') as HTMLElement;
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        dialog: d.scrollWidth - d.clientWidth,
      };
    });
    expect(overflow.page).toBeLessThanOrEqual(0);
    expect(overflow.dialog).toBeLessThanOrEqual(0);
    for (const button of await dialog.getByTestId("denomination-20000").getByRole("button").all()) {
      const box = await button.boundingBox();
      expect(box!.width).toBeGreaterThanOrEqual(44);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press("Escape");
  });
});
