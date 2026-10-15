import { expect, test, type Page } from "@playwright/test";
import { formatMoney } from "../../src/domain/money";
import {
  EMPTY_DRAFT,
  payoutRows,
  previewRefund,
  type Draft,
  type Preview,
} from "../../src/lib/refunds/plan";
import { IDS, makeSale } from "../../src/lib/refunds/test-fixtures";
import { resetSeedLocales } from "./db";
import { mn } from "./fixtures";
import {
  addByCode,
  approveWithManagerPin,
  cartLines,
  endRegister,
  msg,
  startRegister,
  tenderDialog,
  type RegisterSession,
} from "./helpers/checkout";
import {
  insertMilkRefund,
  insertSale,
  insertVoid,
  SALE_TOTAL,
  type E2eSale,
} from "./helpers/refunds";

/**
 * Returns / exchange / void UI (slice "refundui"). The refund and void SERVICE
 * is not part of this slice (the actions are stubs that answer INVALID_STATE),
 * so these specs cover everything the browser does BEFORE the server decides:
 * finding the sale, choosing lines, the live preview (checked against the same
 * pure domain the server runs), reasons, payout choice, approval prompts per
 * policy, the exact request shape sent to the action, and the exchange cart.
 * The real end to end (refund committed, stock, cash, receipts) belongs to the
 * verification stage that runs after the service is merged.
 */

const money = (value: bigint) => formatMoney(value, { locale: "mn" });
const MILK = "Сүү 1л";
const APPLES = "Алим";
const BOOK = "Ном";

let session: RegisterSession | undefined;

test.afterEach(async () => {
  await endRegister(session);
  session = undefined;
  await resetSeedLocales();
});

// The same numbers the fixture sale has, so expectations come from the domain.
const FIXTURE = makeSale();
const NOW = new Date();
const fixtureLine = { milk: IDS.milk, apples: IDS.apples, book: IDS.book };

function expectedPreview(draft: Draft, exchangeTotal?: bigint): Extract<Preview, { kind: "ok" }> {
  const preview = previewRefund({
    refundId: IDS.newRefund,
    sale: FIXTURE,
    draft,
    now: NOW,
    roundingUnit: 100n,
    maxRefundWindowDays: null,
    role: "CASHIER",
    exchangeTotal,
  });
  if (preview.kind !== "ok") throw new Error(`domain preview failed: ${preview.kind}`);
  return preview;
}

// -- helpers --------------------------------------------------------------------------

async function openReturns(page: Page) {
  await page.getByTestId("open-returns").click();
  await expect(page.getByRole("dialog", { name: mn.refunds.title })).toBeVisible();
}

async function openSale(page: Page, sale: E2eSale) {
  await openReturns(page);
  const input = page.getByTestId("receipt-input");
  await input.fill(sale.number.toLowerCase());
  await input.press("Enter");
  await expect(page.getByTestId("return-sale-number")).toHaveText(sale.number);
}

const row = (page: Page, name: string) => page.getByTestId("return-line").filter({ hasText: name });

async function pickLines(page: Page) {
  const inc = (name: string) =>
    page.getByRole("button", { name: msg(mn.refunds.line.increase, { name }) });
  await inc(MILK).click();
  await inc(MILK).click();
  await page.getByRole("button", { name: msg(mn.refunds.line.editQty, { name: APPLES }) }).click();
  const qty = page.getByRole("dialog", { name: APPLES });
  await qty.getByLabel(msg(mn.refunds.qty.label, { unit: mn.units.KG })).fill("0.7");
  await qty.getByRole("button", { name: mn.refunds.qty.apply }).click();
  await expect(qty).toHaveCount(0);
  await page.getByRole("button", { name: msg(mn.refunds.line.returnAll, { name: BOOK }) }).click();
}

const chosen: Draft = {
  ...EMPTY_DRAFT,
  reason: "DEFECTIVE",
  choices: {
    [fixtureLine.milk]: { qtyMilli: 2000, restock: true },
    [fixtureLine.apples]: { qtyMilli: 700, restock: true },
    [fixtureLine.book]: { qtyMilli: 1000, restock: true },
  },
};

/** Request bodies of server actions whose JSON contains every marker. */
function captureActions(page: Page, ...markers: string[]) {
  const bodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.headers()["next-action"]) return;
    const body = request.postData() ?? "";
    if (!markers.every((marker) => body.includes(marker))) return;
    try {
      const parsed: unknown = JSON.parse(body);
      if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === "object") {
        bodies.push(parsed[0] as Record<string, unknown>);
      }
    } catch {
      // not a JSON-encoded action call
    }
  });
  return bodies;
}

async function setupSale(
  page: Page,
  options: Parameters<typeof insertSale>[1] = { shift: "open" },
) {
  session = await startRegister(page, { shift: true });
  const sale = await insertSale(session, options);
  return sale;
}

// -- tests ----------------------------------------------------------------------------

test.describe("finding the sale", () => {
  test("by receipt number typed (any case) or scanned, with a clear answer when it is not found", async ({
    page,
  }) => {
    const sale = await setupSale(page);
    await openReturns(page);
    const input = page.getByTestId("receipt-input");
    await expect(input).toBeFocused();

    await input.fill("nothing-here");
    await input.press("Enter");
    await expect(page.getByText(mn.refunds.find.notFound)).toBeVisible();
    await input.fill("hello world");
    await input.press("Enter");
    await expect(page.getByText(mn.refunds.find.notFound)).toBeVisible();

    // A scanner types the whole code in one burst and presses Enter: the register's own
    // wedge must not take it (nothing lands in the cart) and the sale opens.
    await page.keyboard.press("Control+a");
    await page.keyboard.type(sale.number, { delay: 0 });
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("return-sale-number")).toHaveText(sale.number);
    await expect(page.getByTestId("return-line")).toHaveCount(3);
    await page.getByRole("button", { name: mn.refunds.panel.back }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(cartLines(page)).toHaveCount(0);
  });

  test("F9 opens the screen with the box focused; the receipt link text also works", async ({
    page,
  }) => {
    const sale = await setupSale(page);
    await page.keyboard.press("F9");
    await expect(page.getByTestId("receipt-input")).toBeFocused();
    await page.getByTestId("receipt-input").fill(`https://pos.example/receipt/${sale.id}`);
    await page.getByTestId("receipt-find").click();
    await expect(page.getByTestId("return-sale-number")).toHaveText(sale.number);
  });

  test("recent sales: this shift by default, the whole register on demand, searchable", async ({
    page,
  }) => {
    const current = await setupSale(page);
    const older = await insertSale(session!, { shift: "closed" });
    await openReturns(page);

    const list = page.getByTestId("recent-sales");
    await expect(list.locator(`[data-number="${current.number}"]`)).toBeVisible();
    await expect(list.locator(`[data-number="${older.number}"]`)).toHaveCount(0);

    await page.getByTestId("recent-scope-REGISTER").click();
    await expect(list.locator(`[data-number="${older.number}"]`)).toBeVisible();
    await expect(list.locator(`[data-number="${current.number}"]`)).toBeVisible();

    await page.getByTestId("recent-search").fill(older.number.slice(-5));
    await expect(list.locator(`[data-number="${older.number}"]`)).toBeVisible();
    await expect(list.locator(`[data-number="${current.number}"]`)).toHaveCount(0);

    // The old shift's sale cannot be voided, and the list says why (it can still be returned).
    const olderRow = list.locator(`[data-number="${older.number}"]`);
    await expect(
      olderRow.getByRole("button", {
        name: msg(mn.refunds.find.voidSale, { number: older.number }),
      }),
    ).toBeDisabled();
    await expect(olderRow.getByTestId("void-reason-note")).toHaveText(
      mn.refunds.void.blocked.otherShift,
    );
    await expect(
      olderRow.getByRole("button", {
        name: msg(mn.refunds.find.returnSale, { number: older.number }),
      }),
    ).toBeEnabled();

    await page.getByTestId("recent-search").fill("ZZZZZZ");
    await expect(page.getByTestId("recent-empty")).toBeVisible();
  });
});

test.describe("return form", () => {
  test("lines, steppers, restock and the live preview equal the domain math", async ({ page }) => {
    const sale = await setupSale(page);
    await openSale(page, sale);

    // nothing chosen yet: skeleton with dashes, submit disabled, no layout jump
    await expect(page.getByTestId("refund-total")).toHaveText("—");
    await expect(page.getByTestId("refund-submit")).toBeDisabled();

    await pickLines(page);
    await expect(row(page, MILK).getByTestId("line-qty")).toHaveText("2");
    await expect(row(page, APPLES).getByTestId("line-qty")).toContainText("0.7");

    const expected = expectedPreview(chosen).plan;
    await expect(page.getByTestId("refund-items")).toHaveText(money(expected.itemsTotal));
    await expect(page.getByTestId("refund-vat")).toHaveText(money(expected.vatAmount));
    await expect(page.getByTestId("refund-net")).toHaveText(money(expected.netAmount));
    await expect(page.getByTestId("refund-total")).toHaveText(money(expected.totalAmount));
    if (expected.roundingAmount !== 0n) {
      await expect(page.getByTestId("refund-rounding")).toHaveText(money(expected.roundingAmount));
    }
    // payout defaults to the original methods, summing to the total
    for (const payout of payoutRows(expected)) {
      await expect(page.getByTestId(`payout-${payout.method}`)).toHaveText(money(payout.amount));
    }
    if (expected.cashRefund > 0n) {
      await expect(page.getByTestId("refund-cash")).toHaveText(money(expected.cashRefund));
    }

    // stock tracking drives the restock switch; turning it off changes nothing in the money
    const milkSwitch = row(page, MILK).getByRole("switch");
    await expect(milkSwitch).toBeChecked();
    await milkSwitch.click();
    await expect(milkSwitch).not.toBeChecked();
    await expect(page.getByTestId("refund-total")).toHaveText(money(expected.totalAmount));

    // cannot step past what was sold
    await expect(
      page.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }),
    ).toBeDisabled();
    // weighed keypad refuses more than the remaining weight
    await page
      .getByRole("button", { name: msg(mn.refunds.line.editQty, { name: APPLES }) })
      .click();
    const qty = page.getByRole("dialog", { name: APPLES });
    await qty.getByLabel(msg(mn.refunds.qty.label, { unit: mn.units.KG })).fill("2");
    await expect(qty.getByRole("alert")).toBeVisible();
    await expect(qty.getByRole("button", { name: mn.refunds.qty.apply })).toBeDisabled();
    await page.keyboard.press("Escape");
  });

  test("a reason is required, and a note when the reason is Other", async ({ page }) => {
    const sale = await setupSale(page);
    await openSale(page, sale);
    await page.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }).click();
    const submit = page.getByTestId("refund-submit");
    await expect(submit).toBeDisabled();
    await expect(page.getByTestId("refund-blockers")).toHaveText(mn.refunds.panel.needReason);

    await page.getByLabel(mn.refunds.panel.reason).selectOption("OTHER");
    await expect(page.getByTestId("refund-blockers")).toHaveText(mn.refunds.panel.needNote);
    await expect(submit).toBeDisabled();
    await page.getByLabel(mn.refunds.panel.noteRequired).fill("Хэрэглэгч буцаав");
    await expect(submit).toBeEnabled();
    await expect(submit).toContainText(money(500_000n));
  });

  test("a cashier needs the manager's PIN; the request carries exactly what was previewed", async ({
    page,
  }) => {
    const sale = await setupSale(page);
    const bodies = captureActions(page, '"refundId"', '"expectedTotal"');
    await openSale(page, sale);
    await pickLines(page);
    await page.getByLabel(mn.refunds.panel.reason).selectOption("DEFECTIVE");
    await page.getByLabel(mn.refunds.panel.note).fill("Хагарсан");
    const expected = expectedPreview(chosen).plan;

    // policy: the cashier lacks pos.refund -> approval for THIS refund is listed up front
    await expect(page.getByTestId("approval-needed")).toContainText(
      msg(mn.refunds.approval.refund, { total: money(expected.totalAmount) }),
    );

    await page.getByTestId("refund-submit").click();
    const pin = page.getByRole("dialog", { name: mn.pos.approval.title });
    await expect(pin).toBeVisible();
    await expect(pin.getByTestId("approval-items").locator("li")).toHaveCount(1);
    await pin.getByLabel(mn.pos.approval.pinLabel).fill("0000");
    await pin.getByRole("button", { name: mn.pos.approval.approve }).click();
    await expect(pin.getByRole("alert")).toHaveText(mn.pos.approval.invalidPin);
    expect(bodies).toHaveLength(0);

    await approveWithManagerPin(page);
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    const body = bodies[0] as {
      refundId: string;
      saleId: string;
      reason: string;
      note: string;
      expectedTotal: string;
      lines: { saleLineId: string; qtyMilli: number; restock: boolean }[];
      approvals: Record<string, string>;
      payments?: unknown;
    };
    expect(body.saleId).toBe(sale.id);
    expect(body.refundId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(body.reason).toBe("DEFECTIVE");
    expect(body.note).toBe("Хагарсан");
    expect(body.expectedTotal).toBe(expected.totalAmount.toString());
    expect(body.payments).toBeUndefined(); // original methods: no override
    expect(body.approvals.refund).toBeTruthy();
    const byLine = new Map(body.lines.map((l) => [l.qtyMilli, l] as const));
    expect([...byLine.keys()].sort((a, b) => a - b)).toEqual([700, 1000, 2000]);
    expect(body.lines.every((l) => l.restock)).toBe(true);
    const lineIds = body.lines.map((l) => l.saleLineId);
    expect(new Set(lineIds)).toEqual(
      new Set([sale.lineIds.milk, sale.lineIds.apples, sale.lineIds.book]),
    );

    // the real service commits it (approval bound to this exact refund); a changed amount
    // needing a fresh PIN is unit-tested (missingApprovals) and refused by the server in phase3.spec
    await expect(page.getByTestId("refund-done")).toBeVisible({ timeout: 20_000 });
  });

  test("paying out through another method needs a separate approval and shows the allocation", async ({
    page,
  }) => {
    const sale = await setupSale(page);
    const bodies = captureActions(page, '"refundId"', '"expectedTotal"');
    await openSale(page, sale);
    await page
      .getByRole("button", { name: msg(mn.refunds.line.returnAll, { name: MILK }) })
      .click();
    await page.getByLabel(mn.refunds.panel.reason).selectOption("WRONG_ITEM");

    const draft: Draft = {
      ...EMPTY_DRAFT,
      reason: "WRONG_ITEM",
      choices: { [fixtureLine.milk]: { qtyMilli: 2000, restock: true } },
    };
    const original = expectedPreview(draft).plan;
    await expect(page.getByTestId("payout-CARD")).toHaveText(
      money(payoutRows(original).find((r) => r.method === "CARD")!.amount),
    );

    await page.getByTestId("payout-choice-CASH").click();
    const toCash = expectedPreview({ ...draft, payout: { kind: "METHOD", method: "CASH" } });
    await expect(page.getByTestId("refund-payout").getByTestId("payout-CASH")).toHaveText(
      money(toCash.plan.totalAmount),
    );
    await expect(page.getByTestId("refund-payout").getByText(mn.refunds.method.CARD)).toHaveCount(
      0,
    );
    await expect(page.getByTestId("refund-cash")).toHaveText(money(toCash.plan.totalAmount));
    await expect(page.getByTestId("approval-needed")).toContainText(mn.refunds.approval.method);

    await page.getByTestId("refund-submit").click();
    const pin = page.getByRole("dialog", { name: mn.pos.approval.title });
    await expect(pin.getByTestId("approval-items").locator("li")).toHaveCount(2);
    await approveWithManagerPin(page);
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    const body = bodies[0] as {
      payments: { method: string; amount: string }[];
      approvals: Record<string, string>;
    };
    expect(body.payments).toEqual([{ method: "CASH", amount: toCash.plan.totalAmount.toString() }]);
    expect(Object.keys(body.approvals).sort()).toEqual(["refund", "refund:method"]);
  });

  test("an already partly returned sale offers only what is left, and says what happened", async ({
    page,
  }) => {
    const sale = await setupSale(page);
    await insertMilkRefund(session!, sale);
    await openSale(page, sale);
    await expect(
      page.getByTestId("return-sale-header").getByText(mn.refunds.state.PARTIALLY_REFUNDED),
    ).toBeVisible();
    const milk = row(page, MILK);
    await expect(milk.getByTestId("line-remaining")).toContainText("1");
    await milk.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }).click();
    await expect(
      milk.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }),
    ).toBeDisabled();
    // one bottle left: refunding it takes exactly what is left of that line
    await page.getByLabel(mn.refunds.panel.reason).selectOption("DAMAGED");
    await expect(page.getByTestId("refund-total")).toHaveText(money(500_000n));
    // voiding a sale that has returns is explained, not offered
    await expect(page.getByTestId("void-sale")).toBeDisabled();
    await expect(page.getByTestId("void-blocked")).toHaveText(mn.refunds.void.blocked.hasRefunds);
  });

  test("a voided sale cannot be returned and says so", async ({ page }) => {
    const sale = await setupSale(page);
    await insertVoid(session!, sale);
    await openSale(page, sale);
    await expect(
      page.getByTestId("return-sale-header").getByText(mn.refunds.state.VOIDED),
    ).toBeVisible();
    await expect(page.getByText(mn.refunds.panel.voidedNote)).toBeVisible();
    await expect(page.getByTestId("refund-submit")).toHaveCount(0);
  });
});

test.describe("void", () => {
  test("the open shift's sale: reason, manager PIN bound to the sale and amount, exact request", async ({
    page,
  }) => {
    const sale = await setupSale(page);
    const bodies = captureActions(page, '"saleId"', '"createdAtClient"', '"approvals"');
    await openReturns(page);
    await page
      .getByRole("button", { name: msg(mn.refunds.find.voidSale, { number: sale.number }) })
      .click();
    const panel = page.getByTestId("void-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("void-total")).toHaveText(money(SALE_TOTAL));
    await expect(page.getByTestId("void-cash")).toHaveText(money(850_200n));
    await expect(page.getByTestId("void-approval")).toBeVisible();

    const submit = page.getByTestId("void-submit");
    await expect(submit).toBeDisabled();
    await page.getByLabel(mn.refunds.void.reason).selectOption("OTHER");
    await expect(submit).toBeDisabled(); // OTHER needs a note
    await page.getByLabel(mn.refunds.panel.noteRequired).fill("Давхар бүртгэсэн");
    await expect(submit).toBeEnabled();
    await submit.click();
    await approveWithManagerPin(page);
    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    const body = bodies[0] as {
      saleId: string;
      reason: string;
      note: string;
      approvals: Record<string, string>;
    };
    expect(body).toMatchObject({ saleId: sale.id, reason: "OTHER", note: "Давхар бүртгэсэн" });
    expect(body.approvals.void).toBeTruthy();
    await expect(page.getByTestId("void-done")).toBeVisible({ timeout: 20_000 });
  });

  test("another shift's sale and a voided sale are explained, not offered", async ({ page }) => {
    const older = await setupSale(page, { shift: "closed" });
    await openSale(page, older);
    await expect(page.getByTestId("void-sale")).toBeDisabled();
    await expect(page.getByTestId("void-blocked")).toHaveText(mn.refunds.void.blocked.otherShift);
  });
});

test.describe("exchange", () => {
  test("credit, replacement and net due follow the cart and the domain; it survives a reload", async ({
    page,
  }) => {
    const sale = await setupSale(page);
    await openSale(page, sale);
    await page.getByTestId("mode-EXCHANGE").click();
    await page.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }).click();
    await page.getByLabel(mn.refunds.panel.reason).selectOption("WRONG_ITEM");
    await page.getByTestId("refund-submit").click();

    // the Returns screen is gone; the register cart is in exchange mode
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const bar = page.getByTestId("exchange-bar");
    await expect(bar).toBeVisible();
    const draft: Draft = {
      ...EMPTY_DRAFT,
      reason: "WRONG_ITEM",
      choices: { [fixtureLine.milk]: { qtyMilli: 1000, restock: true } },
    };
    const credit = expectedPreview(draft).plan.totalAmount;
    await expect(page.getByTestId("bar-credit")).toHaveText(money(credit));
    await expect(page.getByTestId("exchange-finish")).toBeDisabled(); // empty cart

    // replacement cheaper than the credit -> money back
    await addByCode(page, "DAIRY-MILK-1L"); // 3 800 ₮ in the seed
    await expect(cartLines(page)).toHaveCount(1);
    const cheaper = expectedPreview(draft, 380_000n).plan.exchange!;
    expect(cheaper.netRefund).toBeGreaterThan(0n);
    await expect(page.getByTestId("bar-replacement")).toHaveText(money(380_000n));
    await expect(page.getByTestId("bar-net")).toHaveText(money(cheaper.netRefund));

    // replacement dearer than the credit -> net due
    await page
      .getByRole("button", { name: msg(mn.pos.cart.increase, { name: "Сүү 1 л" }) })
      .click();
    const dearer = expectedPreview(draft, 760_000n).plan.exchange!;
    expect(dearer.netDue).toBeGreaterThan(0n);
    await expect(page.getByTestId("bar-replacement")).toHaveText(money(760_000n));
    await expect(page.getByTestId("bar-net")).toHaveText(money(dearer.netDue));

    // survives a reload (context + cart draft)
    await page.reload();
    await expect(page.getByTestId("exchange-bar")).toBeVisible();
    await expect(page.getByTestId("bar-credit")).toHaveText(money(credit));
    await expect(page.getByTestId("bar-net")).toHaveText(money(dearer.netDue));

    // finish: review dialog with the same numbers, cashier approval, then the tender for net due
    await page.getByTestId("exchange-finish").click();
    const finish = page.getByTestId("exchange-finish-dialog");
    await expect(finish).toBeVisible();
    await expect(finish.getByTestId("exchange-credit")).toHaveText(money(dearer.creditApplied));
    await expect(finish.getByTestId("exchange-net-due")).toHaveText(money(dearer.netDue));
    await finish.getByTestId("exchange-continue").click();
    await approveWithManagerPin(page);
    const tender = tenderDialog(page);
    await expect(tender).toBeVisible();
    await expect(tender).toContainText(money(dearer.netDue));
    // Escape leaves the tender step for the review step, a second Escape leaves the exchange dialog.
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("exchange-finish-dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // cancel leaves a normal cart
    await expect(page.getByTestId("exchange-bar")).toBeVisible();
    await page.getByTestId("exchange-cancel").click();
    await expect(page.getByTestId("exchange-bar")).toHaveCount(0);
    await expect(cartLines(page)).toHaveCount(1);
  });

  test("parking the cart is refused while an exchange is open", async ({ page }) => {
    const sale = await setupSale(page);
    await openSale(page, sale);
    await page.getByTestId("mode-EXCHANGE").click();
    await page.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }).click();
    await page.getByLabel(mn.refunds.panel.reason).selectOption("DAMAGED");
    await page.getByTestId("refund-submit").click();
    await addByCode(page, "DAIRY-MILK-1L");
    await page.keyboard.press("F3");
    await expect(page.getByText(mn.refunds.exchange.noHold)).toBeVisible();
    await expect(cartLines(page)).toHaveCount(1);
  });
});

test.describe("phone, touch and theme", () => {
  test("full screen at 360px, no horizontal scroll, 44px touch targets", async ({ page }) => {
    const sale = await setupSale(page);
    await page.setViewportSize({ width: 360, height: 740 });
    await openReturns(page);
    const opening = page.getByRole("dialog", { name: mn.refunds.title });
    // (the dialog zooms in on open: measure once the animation has settled)
    await expect
      .poll(async () => {
        const box = (await opening.boundingBox())!;
        return [Math.round(box.width), Math.round(box.height)];
      })
      .toEqual([360, 740]);

    const input = page.getByTestId("receipt-input");
    await input.fill(sale.number);
    await input.press("Enter");
    await expect(page.getByTestId("return-sale-number")).toBeVisible();
    const dialog = page.getByRole("dialog");
    await page.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }).click();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    const dialogOverflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(dialogOverflow).toBeLessThanOrEqual(0);

    const small = await dialog.evaluate((el) =>
      [
        ...el.querySelectorAll<HTMLElement>(
          "button, [role='radio'], select, input, [role='switch']",
        ),
      ]
        .filter((node) => node.offsetParent !== null)
        .map((node) => ({ node, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.height > 0 && (rect.height < 43.5 || rect.width < 43.5))
        // Radix's switch is 44px wide x 24px high inside a 44px label row; the row is the target.
        .filter(({ node }) => node.getAttribute("role") !== "switch")
        .map(
          ({ node, rect }) =>
            `${node.tagName} ${node.textContent?.slice(0, 20)} ${rect.width}x${rect.height}`,
        ),
    );
    expect(small).toEqual([]);
  });

  test("dark theme keeps the text readable", async ({ page }) => {
    const sale = await setupSale(page);
    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await openSale(page, sale);
    await page.getByRole("button", { name: msg(mn.refunds.line.increase, { name: MILK }) }).click();
    const contrast = await page.getByTestId("refund-total").evaluate((el) => {
      // Colours are oklch() in the theme: let a canvas turn any CSS colour into sRGB.
      const context = document
        .createElement("canvas")
        .getContext("2d", { willReadFrequently: true })!;
      const rgba = (css: string) => {
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = css;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
      };
      const luminance = ([r, g, b]: number[]) => {
        const f = (v: number) => {
          const c = v / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
      };
      let node: HTMLElement | null = el as HTMLElement;
      let background = [0, 0, 0, 0];
      while (node) {
        background = rgba(getComputedStyle(node).backgroundColor);
        if (background[3]! > 0) break;
        node = node.parentElement;
      }
      const a = luminance(rgba(getComputedStyle(el).color));
      const b = luminance(background);
      return {
        ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        dark: document.documentElement.classList.contains("dark"),
      };
    });
    expect(contrast.dark).toBe(true);
    expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
  });
});
