import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { mn, SEED, signInWithPassword, signOut } from "./fixtures";
import {
  approveWithManagerPin,
  addByName,
  cartLines,
  chargeButton,
  completeSale,
  currentSaleId,
  endRegister,
  openShiftWithFloat,
  minor,
  mnt,
  product,
  retireCreated,
  sql,
  stockOnHand,
  payCash,
  tenderDialog,
  ledgerSum,
  setAllowNegativeStock,
  type RegisterSession,
} from "./helpers/checkout";
import { insertSale } from "./helpers/refunds";
import {
  adminPage,
  anonymous,
  bootTill,
  chooseReason,
  closeDone,
  moveCash,
  openReturns,
  watchConsole,
  expectNoOverflow as noOverflow,
  countDrawer,
  reviewAndConfirmClose,
  continueExchange,
  startExchange,
  returnKg,
  returnPieces,
  refundPayments as payoutsOf,
  expectFullyRefundedExactly,
  expectRefundDone,
  fillCart,
  openShiftMenu,
  saleTotal,
  findSale,
  movementsOf,
  refundPayments,
  refundsOf,
  returnAll,
  ring,
  salePayments,
  submitReturn,
} from "./helpers/phase3";

/**
 * Phase 3 end to end against a production build: shifts, voids, refunds and
 * exchanges through the real register, with every number checked in the
 * database afterwards. Each test boots its own tablet, shift and products
 * (unique suffix), so the suite can run again on the same database.
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

test.describe("cash sale, full refund to cash", () => {
  test("stock restored, credit note + PDF + share link, X report and sales history agree", async ({
    page,
    browser,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const item = await product(loc, { label: "Cash", price: 4_000, stock: 50, suffix });

    const sale = await ring(page, [{ name: item.name, qty: 2 }], [{ cash: 10_000 }]);
    expect(await stockOnHand(item.variantId, loc)).toBe(48_000);

    await findSale(page, sale.number);
    await returnAll(page, item.name);
    await chooseReason(page, "DEFECTIVE");
    await submitReturn(page);
    const done = await expectRefundDone(page);
    await expect(done.getByTestId("done-total")).toHaveText(mnt(minor(8_000)));
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(minor(8_000)));

    // -- database: one refund on this shift, paid out in cash, stock back --------------
    const [refund] = await refundsOf(sale.saleId);
    expect(await refundsOf(sale.saleId)).toHaveLength(1);
    expect(refund!.total).toBe(minor(8_000));
    expect(refund!.shiftId).toBe(till.shiftId);
    expect(refund!.approvedById).not.toBeNull();
    expect(refund!.approvedById).not.toBe(session.cashierId);
    expect(refund!.processedById).toBe(session.cashierId);
    expect((await refundPayments(refund!.id)).map((p) => [p.method, p.amount])).toEqual([
      ["CASH", minor(8_000)],
    ]);
    await expectFullyRefundedExactly(sale.saleId);
    expect(await stockOnHand(item.variantId, loc)).toBe(50_000);
    expect(await ledgerSum(item.variantId, loc)).toBe(50_000);
    const restock = (await movementsOf(item.variantId, loc)).filter(
      (m) => m.type === "RETURN_RESTOCK",
    );
    expect(restock).toEqual([
      { type: "RETURN_RESTOCK", qtyDeltaMilli: 2_000, refundId: refund!.id, saleId: sale.saleId },
    ]);

    // -- credit note page, PDF and the anonymous share link -----------------------------
    await page.goto(`/receipt/refund/${refund!.id}`);
    const sheet = page.locator("article.receipt-sheet");
    await expect(sheet).toContainText(mn.receipt.refund.title);
    await expect(sheet).toContainText(refund!.number);
    await expect(sheet).toContainText(sale.number);
    const pdfHref = await page
      .getByRole("link", { name: mn.receipt.actions.downloadPdf })
      .getAttribute("href");
    const token = /\/api\/receipts\/refund\/([^/]+)\/pdf/.exec(pdfHref ?? "")?.[1];
    expect(token, pdfHref ?? "").toBeTruthy();
    const anon = await anonymous(browser);
    try {
      const pdf = await anon.request.get(`/api/receipts/refund/${token}/pdf`);
      expect(pdf.status()).toBe(200);
      expect(pdf.headers()["content-type"]).toBe("application/pdf");
      expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");
      const shared = await anon.request.get(`/r/refund/${token}`);
      expect(shared.status()).toBe(200);
      expect(await shared.text()).toContain(refund!.number);
      expect((await anon.request.get(`/api/receipts/refund/${token}x/pdf`)).status()).toBe(404);
    } finally {
      await anon.close();
    }

    // -- the shift's X report counts it; the till nets to nothing ------------------------
    await page.goto("/register");
    await page.getByTestId("shift-menu").click();
    await page.getByRole("menuitem", { name: mn.shifts.menu.xReport }).click();
    const x = page.getByRole("dialog", { name: mn.shifts.report.titleX });
    await expect(x.getByTestId("sales-total")).toHaveText(mnt(minor(8_000)));
    await expect(x.getByTestId("net-sales")).toHaveText(mnt(0));
    await expect(x.getByTestId("tender-CASH")).toHaveText(mnt(0));
    await expect(x).toContainText(mnt(-minor(8_000)));

    // -- sales history: REFUNDED chip, the sale links the credit note --------------------
    const admin = await adminPage(browser);
    try {
      await admin.page.goto(`/sales?q=${sale.number}`);
      await expect(
        admin.page.locator(`tr[data-sale-number="${sale.number}"] [data-status]`),
      ).toHaveAttribute("data-status", "REFUNDED");
      await admin.page.goto(`/sales/${sale.saleId}`);
      await expect(
        admin.page.getByRole("region", { name: mn.sales.detail.refunds.title }),
      ).toContainText(refund!.number);
    } finally {
      await admin.context.close();
    }
  });
});

test.describe("partial refunds", () => {
  test("several steps with a weighed item sum exactly; an exhausted line is refused", async ({
    page,
    context,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const milk = await product(loc, { label: "Milk", price: 3_333, stock: 30, suffix });
    const apples = await product(loc, {
      label: "Apples",
      price: 7_777,
      stock: 20,
      unit: "KG",
      suffix,
    });

    const sale = await ring(
      page,
      [
        { name: milk.name, qty: 3 },
        { name: apples.name, kg: "1.333" },
      ],
      [{ cash: 30_000 }],
    );
    expect(await stockOnHand(apples.variantId, loc)).toBe(20_000 - 1_333);

    // Step 1: one bottle and 0.4 kg.
    await findSale(page, sale.number);
    await returnPieces(page, milk.name, 1);
    await returnKg(page, apples.name, "0.4");
    await chooseReason(page);
    await submitReturn(page);
    await expectRefundDone(page);
    await closeDone(page);

    // Step 2: one bottle and 0.5 kg.
    await findSale(page, sale.number);
    await returnPieces(page, milk.name, 1);
    await returnKg(page, apples.name, "0.5");
    await chooseReason(page);
    await submitReturn(page);
    await expectRefundDone(page);
    await closeDone(page);
    expect(await refundsOf(sale.saleId)).toHaveLength(2);

    // A second till screen was prepared before step 3 and still shows the old remainder.
    const stale = await context.newPage();
    await stale.goto("/register");
    await findSale(stale, sale.number);
    await returnAll(stale, milk.name);
    await returnAll(stale, apples.name);
    await chooseReason(stale);

    // Step 3 on the first screen takes the last bottle.
    await findSale(page, sale.number);
    await returnAll(page, milk.name);
    await chooseReason(page);
    await submitReturn(page);
    await expectRefundDone(page);
    await closeDone(page);

    // The stale screen asks for the bottle again: the server refuses, nothing is written,
    // and the screen explains instead of failing silently.
    await submitReturn(stale);
    await expect(stale.getByTestId("refund-problem")).toBeVisible();
    await expect(stale.getByTestId("refund-problem")).toContainText(
      mn.refundErrors.refund.errors.ALREADY_REFUNDED,
    );
    expect(await refundsOf(sale.saleId)).toHaveLength(3);
    await stale.getByRole("button", { name: mn.refunds.panel.reload }).click();
    // Reloaded: the bottle is used up, only the rest of the apples can be returned.
    await expect(
      stale.getByRole("button", { name: mn.refunds.line.increase.replace("{name}", milk.name) }),
    ).toHaveCount(0);
    await returnAll(stale, apples.name);
    await chooseReason(stale);
    await submitReturn(stale);
    await expectRefundDone(stale);
    await stale.close();

    // Everything is back, to the möngö, in four refunds.
    expect(await refundsOf(sale.saleId)).toHaveLength(4);
    await expectFullyRefundedExactly(sale.saleId);
    expect(await stockOnHand(milk.variantId, loc)).toBe(30_000);
    expect(await stockOnHand(apples.variantId, loc)).toBe(20_000);
    expect(await ledgerSum(apples.variantId, loc)).toBe(20_000);

    // Over-refund and re-refund of a sale that is used up are impossible from the screen.
    await findSale(page, sale.number);
    await expect(page.getByText(mn.refunds.panel.refundedNote)).toBeVisible();
    await expect(page.getByTestId("refund-submit")).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});

test.describe("split tender", () => {
  test("pays back to the original methods; cash never exceeds what the till kept", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const item = await product(loc, { label: "Split", price: 6_000, stock: 20, suffix });

    // 12 000 ₮: card 5 000 + cash 7 000 (10 000 handed over, 3 000 change).
    const sale = await ring(
      page,
      [{ name: item.name, qty: 2 }],
      [{ card: 5_000 }, { cash: 10_000 }],
    );
    const original = await salePayments(sale.saleId);
    expect(original.map((p) => [p.method, p.amount])).toEqual([
      ["CARD", minor(5_000)],
      ["CASH", minor(7_000)],
    ]);

    await findSale(page, sale.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page);
    const summary = page.getByTestId("refund-payout");
    await expect(summary.getByTestId("payout-CARD")).toBeVisible();
    await expect(summary.getByTestId("payout-CASH")).toBeVisible();
    await submitReturn(page);
    const done = await expectRefundDone(page);
    const first = (await refundsOf(sale.saleId))[0]!;
    const firstPay = await payoutsOf(first.id);
    expect(firstPay.reduce((a, p) => a + p.amount, 0n)).toBe(minor(6_000));
    const cashOut = firstPay.find((p) => p.method === "CASH")!;
    const cardOut = firstPay.find((p) => p.method === "CARD")!;
    expect(cashOut.originalPaymentId).toBe(original[1]!.id);
    expect(cardOut.originalPaymentId).toBe(original[0]!.id);
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(cashOut.amount));
    await closeDone(page);

    await findSale(page, sale.number);
    await returnAll(page, item.name);
    await chooseReason(page);
    await submitReturn(page);
    await expectRefundDone(page);
    await closeDone(page);

    // Over both refunds each tender gives back exactly what it took, not the 10 000 handed over.
    const all = await sql<{ method: string; total: string }>(
      `SELECT rp.method::text, sum(rp.amount)::text AS total FROM "RefundPayment" rp
         JOIN "Refund" r ON r.id = rp."refundId" WHERE r."saleId" = $1 GROUP BY rp.method`,
      [sale.saleId],
    );
    expect(Object.fromEntries(all.map((r) => [r.method, BigInt(r.total)]))).toEqual({
      CARD: minor(5_000),
      CASH: minor(7_000),
    });
    await expectFullyRefundedExactly(sale.saleId);

    // The drawer is back to the float: expected cash = 50 000 + 7 000 - 7 000.
    await page.getByTestId("shift-menu").click();
    await page.getByRole("menuitem", { name: mn.shifts.menu.xReport }).click();
    const x = page.getByRole("dialog", { name: mn.shifts.report.titleX });
    await expect(x.getByTestId("tender-CASH")).toHaveText(mnt(0));
    await expect(x.getByTestId("tender-CARD")).toHaveText(mnt(0));
  });
});

test.describe("manager approval", () => {
  test("a cashier's refund needs a manager PIN; paying out another way needs a second approval", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const item = await product(session.locationId, {
      label: "Appr",
      price: 5_000,
      stock: 20,
      suffix,
    });
    const sale = await ring(page, [{ name: item.name, qty: 2 }], [{ cash: 10_000 }]);

    // Plain refund: one approval (the refund itself).
    await findSale(page, sale.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page, "WRONG_ITEM");
    await expect(page.getByTestId("approval-needed")).toBeVisible();
    await page.getByTestId("refund-submit").click();
    const pin = page.getByRole("dialog", { name: mn.pos.approval.title });
    await expect(pin.getByTestId("approval-items").locator("li")).toHaveCount(1);
    await pin.getByLabel(mn.pos.approval.pinLabel).fill("000000");
    await pin.getByRole("button", { name: mn.pos.approval.approve }).click();
    await expect(pin.getByRole("alert")).toHaveText(mn.pos.approval.invalidPin);
    expect(await refundsOf(sale.saleId)).toHaveLength(0);
    await approveWithManagerPin(page);
    await expectRefundDone(page);
    await closeDone(page);
    const [plain] = await refundsOf(sale.saleId);
    expect(plain!.approvedById).not.toBeNull();

    // Method override (all to bank transfer, which the sale did not use): two approvals.
    await findSale(page, sale.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page, "WRONG_ITEM");
    await page.getByTestId("payout-choice-BANK_TRANSFER").click();
    await expect(page.getByTestId("approval-needed")).toContainText(mn.refunds.approval.method);
    await page.getByTestId("refund-submit").click();
    const pin2 = page.getByRole("dialog", { name: mn.pos.approval.title });
    await expect(pin2.getByTestId("approval-items").locator("li")).toHaveCount(2);
    await approveWithManagerPin(page);
    const done = await expectRefundDone(page);
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(0));
    const refunds = await refundsOf(sale.saleId);
    expect(refunds).toHaveLength(2);
    const override = refunds[1]!;
    expect((await payoutsOf(override.id)).map((p) => [p.method, p.amount])).toEqual([
      ["BANK_TRANSFER", minor(5_000)],
    ]);
    const used = await sql<{ key: string }>(
      `SELECT meta->>'key' AS key FROM "AuditLog"
        WHERE action = 'refund.approval_used' AND "entityId" = $1 ORDER BY key`,
      [override.id],
    );
    expect(used.map((r) => r.key)).toEqual(["refund", "refund:method"]);
  });

  test("an approval minted for one amount is refused for another", async ({ page }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const item = await product(session.locationId, {
      label: "Scope",
      price: 5_000,
      stock: 20,
      suffix,
    });
    const sale = await ring(page, [{ name: item.name, qty: 3 }], [{ cash: 15_000 }]);

    // Hold the refund request back (the network "fails") but keep what the browser sent.
    let captured: { url: string; headers: Record<string, string>; body: string } | undefined;
    await page.route("**/register", async (route) => {
      const request = route.request();
      const body = request.postData() ?? "";
      if (
        request.method() === "POST" &&
        request.headers()["next-action"] &&
        body.includes('"expectedTotal"')
      ) {
        captured ??= { url: request.url(), headers: request.headers(), body };
        await route.abort("failed");
      } else {
        await route.continue();
      }
    });
    await findSale(page, sale.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page);
    await submitReturn(page);
    await expect.poll(() => captured).toBeDefined();
    const original = JSON.parse(captured!.body) as [Record<string, unknown>];
    expect((original[0]!.approvals as Record<string, string>).refund).toBeTruthy();

    const send = async (payload: unknown) => {
      const headers = { ...captured!.headers };
      delete headers["content-length"];
      delete headers.host;
      const response = await page.request.post(captured!.url, {
        headers,
        data: JSON.stringify(payload),
      });
      return response.text();
    };

    // Same refund id and token, but two bottles instead of one: the scope no longer matches.
    const doubled = structuredClone(original);
    const line = (doubled[0]!.lines as { qtyMilli: number }[])[0]!;
    line.qtyMilli = 2_000;
    doubled[0]!.expectedTotal = (BigInt(original[0]!.expectedTotal as string) * 2n).toString();
    expect(await send(doubled)).toMatch(/"refund":\["APPROVAL_INVALID"\]/);
    expect(await refundsOf(sale.saleId)).toHaveLength(0);

    // The refused attempt did not use the token up: the refund it was minted for goes through.
    const accepted = await send(original);
    expect(accepted).toContain('"ok":true');
    const refunds = await refundsOf(sale.saleId);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.total).toBe(minor(5_000));
    // ...and sending the identical request again replays it instead of refunding twice.
    expect(await send(original)).toContain('"ok":true');
    expect(await refundsOf(sale.saleId)).toHaveLength(1);
    expect(await stockOnHand(item.variantId, session.locationId)).toBe(18_000);
  });

  test("outside the refund window the cashier needs a third approval", async ({ page }) => {
    const till = await bootTill(page);
    session = till.session;
    const old = await insertSale(session, {
      shift: "open",
      occurredAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
    });
    await sql(`UPDATE "BusinessSettings" SET "refundWindowDays" = 3 WHERE id = 1`);
    try {
      await page.reload();
      await findSale(page, old.number);
      await returnPieces(page, "Сүү 1л", 1);
      await chooseReason(page);
      await expect(page.getByTestId("window-warning")).toBeVisible();
      await page.getByTestId("refund-submit").click();
      const pin = page.getByRole("dialog", { name: mn.pos.approval.title });
      await expect(pin.getByTestId("approval-items").locator("li")).toHaveCount(2);
      await approveWithManagerPin(page);
      await expectRefundDone(page);
      const [refund] = await refundsOf(old.id);
      const used = await sql<{ key: string }>(
        `SELECT meta->>'key' AS key FROM "AuditLog"
          WHERE action = 'refund.approval_used' AND "entityId" = $1 ORDER BY key`,
        [refund!.id],
      );
      expect(used.map((r) => r.key)).toEqual(["refund", "refund:window"]);
    } finally {
      await sql(`UPDATE "BusinessSettings" SET "refundWindowDays" = NULL WHERE id = 1`);
    }
  });

  test("a manager at the till refunds and overrides the payout without a PIN prompt", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const item = await product(session.locationId, {
      label: "Mgr",
      price: 5_000,
      stock: 20,
      suffix,
    });
    const sale = await ring(page, [{ name: item.name }], [{ card: 5_000 }]);

    await signOut(page, SEED.cashier.name, mn.auth.lock);
    await signInWithPassword(page, SEED.manager.email);
    await page.goto("/register");
    await findSale(page, sale.number);
    await returnAll(page, item.name);
    await chooseReason(page);
    await page.getByTestId("payout-choice-CASH").click();
    await expect(page.getByTestId("approval-needed")).toHaveCount(0);
    await page.getByTestId("refund-submit").click();
    await expect(page.getByRole("dialog", { name: mn.pos.approval.title })).toHaveCount(0);
    const done = await expectRefundDone(page);
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(minor(5_000)));
    const [refund] = await refundsOf(sale.saleId);
    expect(refund!.approvedById).toBeNull();
    expect(refund!.processedById).not.toBe(session.cashierId);
    expect((await payoutsOf(refund!.id)).map((p) => [p.method, p.amount])).toEqual([
      ["CASH", minor(5_000)],
    ]);
  });
});

test.describe("exchange", () => {
  test("net due: one atomic result, both receipts, stock right for both items", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const old = await product(loc, { label: "Old", price: 5_000, stock: 50, suffix });
    const fresh = await product(loc, { label: "New", price: 8_000, stock: 50, suffix });
    const sale = await ring(page, [{ name: old.name, qty: 2 }], [{ cash: 10_000 }]);
    const [salesBeforeRow] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM "Sale" WHERE "registerId" = $1`,
      [session.registerId],
    );

    await startExchange(page, sale.number, { name: old.name, pieces: 1 });
    await addByName(page, fresh.name);
    await expect(page.getByTestId("bar-credit")).toHaveText(mnt(minor(5_000)));
    await expect(page.getByTestId("bar-replacement")).toHaveText(mnt(minor(8_000)));
    await expect(page.getByTestId("bar-net")).toHaveText(mnt(minor(3_000)));
    await continueExchange(page);

    // Only the net due is tendered; 5 000 ₮ handed over, 2 000 ₮ change.
    const tender = tenderDialog(page);
    await expect(tender.getByTestId("tender-payable")).toHaveText(mnt(minor(3_000)));
    await payCash(page, 5_000);
    await completeSale(page);

    const done = await expectRefundDone(page);
    await expect(done.getByTestId("done-change")).toContainText(mnt(minor(2_000)));
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(0));
    await expect(done.getByTestId("done-refund-receipt")).toBeVisible();
    const saleReceipt = done.getByTestId("done-sale-receipt");
    await expect(saleReceipt).toBeVisible();

    // One refund, one replacement sale, written together.
    const refunds = await refundsOf(sale.saleId);
    expect(refunds).toHaveLength(1);
    const refund = refunds[0]!;
    expect(refund.total).toBe(minor(5_000));
    expect(refund.exchangeSaleId).not.toBeNull();
    const [salesAfterRow] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM "Sale" WHERE "registerId" = $1`,
      [session.registerId],
    );
    expect(Number(salesAfterRow!.n)).toBe(Number(salesBeforeRow!.n) + 1);
    await expect(saleReceipt).toHaveAttribute("href", `/receipt/${refund.exchangeSaleId}`);
    expect((await payoutsOf(refund.id)).map((p) => [p.method, p.amount])).toEqual([
      ["EXCHANGE_CREDIT", minor(5_000)],
    ]);
    const replacement = await salePayments(refund.exchangeSaleId!);
    expect(replacement.map((p) => [p.method, p.amount])).toEqual([
      ["CASH", minor(3_000)],
      ["EXCHANGE_CREDIT", minor(5_000)],
    ]);
    expect(await saleTotal(refund.exchangeSaleId!)).toBe(minor(8_000));
    const [replacementRow] = await sql<{ shiftId: string }>(
      `SELECT "shiftId" FROM "Sale" WHERE id = $1`,
      [refund.exchangeSaleId],
    );
    expect(replacementRow!.shiftId).toBe(till.shiftId);

    // Stock: the returned item is back, the new one is gone, ledgers agree.
    expect(await stockOnHand(old.variantId, loc)).toBe(49_000);
    expect(await ledgerSum(old.variantId, loc)).toBe(49_000);
    expect(await stockOnHand(fresh.variantId, loc)).toBe(49_000);
    expect(await ledgerSum(fresh.variantId, loc)).toBe(49_000);

    // The register is ready for the next sale (cart cleared) and shows both receipts.
    await closeDone(page);
    await expect(page.getByTestId("exchange-bar")).toHaveCount(0);
    await expect(cartLines(page)).toHaveCount(0);
    await page.goto(`/receipt/${refund.exchangeSaleId}`);
    await expect(page.locator("article.receipt-sheet")).toContainText(fresh.name);
    await page.goto(`/receipt/refund/${refund.id}`);
    await expect(page.locator("article.receipt-sheet")).toContainText(refund.number);

    // The X report: 18 000 sold, 5 000 returned; the credit nets out of the tenders.
    await page.goto("/register");
    await openShiftMenu(page, mn.shifts.menu.xReport);
    const x = page.getByRole("dialog", { name: mn.shifts.report.titleX });
    await expect(x.getByTestId("sales-total")).toHaveText(mnt(minor(18_000)));
    await expect(x.getByTestId("net-sales")).toHaveText(mnt(minor(13_000)));
    await expect(x.getByTestId("tender-CASH")).toHaveText(mnt(minor(13_000)));
  });

  test("net refund: the cheaper replacement is covered by the credit, the rest goes back in cash", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const old = await product(loc, { label: "Old", price: 5_000, stock: 50, suffix });
    const cheap = await product(loc, { label: "Cheap", price: 3_000, stock: 50, suffix });
    const sale = await ring(page, [{ name: old.name, qty: 2 }], [{ cash: 10_000 }]);

    await startExchange(page, sale.number, { name: old.name, pieces: 1 });
    await addByName(page, cheap.name);
    await expect(page.getByTestId("bar-net")).toHaveText(mnt(minor(2_000)));
    await continueExchange(page);

    const done = await expectRefundDone(page);
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(minor(2_000)));
    const [refund] = await refundsOf(sale.saleId);
    expect(refund!.total).toBe(minor(5_000));
    expect((await payoutsOf(refund!.id)).map((p) => [p.method, p.amount])).toEqual([
      ["CASH", minor(2_000)],
      ["EXCHANGE_CREDIT", minor(3_000)],
    ]);
    expect((await salePayments(refund!.exchangeSaleId!)).map((p) => [p.method, p.amount])).toEqual([
      ["EXCHANGE_CREDIT", minor(3_000)],
    ]);
    expect(await stockOnHand(old.variantId, loc)).toBe(49_000);
    expect(await stockOnHand(cheap.variantId, loc)).toBe(49_000);
    expect(await ledgerSum(cheap.variantId, loc)).toBe(49_000);
  });

  test("a replacement that cannot be sold leaves neither refund, sale nor stock movement", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const old = await product(loc, { label: "Old", price: 5_000, stock: 50, suffix });
    const scarce = await product(loc, { label: "Scarce", price: 4_000, stock: 1, suffix });
    const sale = await ring(page, [{ name: old.name, qty: 2 }], [{ cash: 10_000 }]);
    const restore = await setAllowNegativeStock(false);
    try {
      await startExchange(page, sale.number, { name: old.name, pieces: 1 });
      await fillCart(page, [{ name: scarce.name, qty: 2 }]);
      await continueExchange(page);
      await payCash(page, 3_000);
      await completeSale(page);

      await expect(page.getByTestId("exchange-problem")).toBeVisible({ timeout: 20_000 });
      expect(await refundsOf(sale.saleId)).toHaveLength(0);
      expect(await stockOnHand(old.variantId, loc)).toBe(48_000);
      expect(await stockOnHand(scarce.variantId, loc)).toBe(1_000);
      expect(await ledgerSum(old.variantId, loc)).toBe(48_000);
      const sold = await sql(`SELECT 1 FROM "SaleLine" WHERE "variantId" = $1`, [scarce.variantId]);
      expect(sold).toHaveLength(0);
    } finally {
      await restore();
    }
  });
});

/** The void panel for a sale found by number; the reason is chosen but nothing is sent. */
async function openVoidPanel(page: Page, number: string, reason = "ENTRY_ERROR") {
  await findSale(page, number);
  await page.getByTestId("void-sale").click();
  await expect(page.getByTestId("void-panel")).toBeVisible();
  await page.getByLabel(mn.refunds.void.reason).selectOption(reason);
}

async function sendVoid(page: Page) {
  await page.getByTestId("void-submit").click();
  await approveWithManagerPin(page);
}

test.describe("void", () => {
  test("within the open shift: stock, payments and reports follow; a voided sale cannot be returned", async ({
    page,
    browser,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const item = await product(loc, { label: "Void", price: 4_000, stock: 50, suffix });
    const sale = await ring(page, [{ name: item.name, qty: 2 }], [{ cash: 10_000 }]);
    expect(await stockOnHand(item.variantId, loc)).toBe(48_000);

    await openVoidPanel(page, sale.number);
    await expect(page.getByTestId("void-total")).toHaveText(mnt(minor(8_000)));
    await sendVoid(page);
    const done = page.getByTestId("void-done");
    await expect(done).toBeVisible({ timeout: 20_000 });
    await expect(done.getByTestId("void-done-cash")).toHaveText(mnt(minor(8_000)));

    const voids = await sql<{ reason: string; shiftId: string; approvedById: string | null }>(
      `SELECT reason::text, "shiftId", "approvedById" FROM "SaleVoid" WHERE "saleId" = $1`,
      [sale.saleId],
    );
    expect(voids).toHaveLength(1);
    expect(voids[0]).toMatchObject({ reason: "ENTRY_ERROR", shiftId: till.shiftId });
    expect(voids[0]!.approvedById).not.toBeNull();
    expect(await stockOnHand(item.variantId, loc)).toBe(50_000);
    expect(await ledgerSum(item.variantId, loc)).toBe(50_000);
    // The sale itself is append-only: its rows are untouched, the void is a row of its own.
    expect(await saleTotal(sale.saleId)).toBe(minor(8_000));
    expect(await refundsOf(sale.saleId)).toHaveLength(0);

    // Reports: the voided sale counts nowhere.
    await page.getByRole("button", { name: mn.refunds.done.done }).click();
    await openShiftMenu(page, mn.shifts.menu.xReport);
    const x = page.getByRole("dialog", { name: mn.shifts.report.titleX });
    await expect(x.getByTestId("sales-total")).toHaveText(mnt(0));
    await expect(x.getByTestId("tender-CASH")).toHaveCount(0);
    await page.keyboard.press("Escape");

    // It cannot be returned, and the void cannot be repeated.
    await findSale(page, sale.number);
    await expect(page.getByText(mn.refunds.panel.voidedNote)).toBeVisible();
    await expect(page.getByTestId("refund-submit")).toHaveCount(0);

    // Back office: VOIDED chip and the slip.
    const admin = await adminPage(browser);
    try {
      await admin.page.goto(`/sales?q=${sale.number}`);
      await expect(
        admin.page.locator(`tr[data-sale-number="${sale.number}"] [data-status]`),
      ).toHaveAttribute("data-status", "VOIDED");
      await admin.page.goto(`/receipt/void/${sale.saleId}`);
      await expect(admin.page.locator("article.receipt-sheet")).toContainText(
        mn.receipt.voidSlip.title,
      );
    } finally {
      await admin.context.close();
    }
  });

  test("refused once the sale has a refund (screen and server)", async ({ page, context }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const item = await product(session.locationId, {
      label: "VoidR",
      price: 4_000,
      stock: 50,
      suffix,
    });
    const sale = await ring(page, [{ name: item.name, qty: 2 }], [{ cash: 10_000 }]);

    // A void screen is prepared first...
    await openVoidPanel(page, sale.number);

    // ...then another screen refunds one piece.
    const other = await context.newPage();
    await other.goto("/register");
    await findSale(other, sale.number);
    await returnPieces(other, item.name, 1);
    await chooseReason(other);
    await submitReturn(other);
    await expectRefundDone(other);

    // The prepared void is refused by the server and nothing is voided.
    await sendVoid(page);
    await expect(page.getByTestId("void-problem")).toContainText(
      mn.refundErrors.void.errors.ALREADY_REFUNDED,
    );
    expect(await sql(`SELECT 1 FROM "SaleVoid" WHERE "saleId" = $1`, [sale.saleId])).toHaveLength(
      0,
    );
    expect(await stockOnHand(item.variantId, session.locationId)).toBe(49_000);

    // A fresh look explains it up front.
    await page.keyboard.press("Escape");
    await findSale(page, sale.number);
    await expect(page.getByTestId("void-sale")).toBeDisabled();
    await expect(page.getByTestId("void-blocked")).toBeVisible();
  });

  test("refused for a sale of another shift (screen and server)", async ({ page, context }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const item = await product(session.locationId, {
      label: "VoidS",
      price: 3_000,
      stock: 50,
      suffix,
    });
    const sale = await ring(page, [{ name: item.name, qty: 2 }], [{ cash: 6_000 }]);
    await openVoidPanel(page, sale.number);

    // Meanwhile the shift is closed (exact count: 50 000 float + 6 000) and a new one opened.
    const other = await context.newPage();
    await other.goto("/register");
    const dialog = await countDrawer(other, { 20000: 2, 10000: 1, 5000: 1, 1000: 1 });
    await reviewAndConfirmClose(dialog);
    // The dialog's name changes once the shift is closed: address it by role alone.
    await expect(other.getByTestId("close-result")).toBeVisible({ timeout: 20_000 });
    await other.getByRole("dialog").getByRole("button", { name: mn.shifts.close.done }).click();
    await openShiftWithFloat(other, 10_000);

    await sendVoid(page);
    await expect(page.getByTestId("void-problem")).toBeVisible();
    expect(await sql(`SELECT 1 FROM "SaleVoid" WHERE "saleId" = $1`, [sale.saleId])).toHaveLength(
      0,
    );

    await page.keyboard.press("Escape");
    await page.reload();
    await findSale(page, sale.number);
    await expect(page.getByTestId("void-sale")).toBeDisabled();
    await expect(page.getByTestId("void-blocked")).toHaveText(mn.refunds.void.blocked.otherShift);
  });

  test("QPay: a void and a refund pay back through the provider", async ({ page }) => {
    test.setTimeout(120_000);
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const item = await product(loc, { label: "Qpay", price: 5_000, stock: 50, suffix });
    const intentOf = async (saleId: string) => {
      const [row] = await sql<{ status: string; id: string }>(
        `SELECT i.status::text, i.id FROM "PaymentIntent" i
           JOIN "SalePayment" p ON p."paymentIntentId" = i.id WHERE p."saleId" = $1`,
        [saleId],
      );
      return row!;
    };

    // Void: cash 1 000 + QPay 9 000.
    const voided = await ring(
      page,
      [{ name: item.name, qty: 2 }],
      [{ cash: 1_000 }, { qpay: true }],
    );
    expect((await intentOf(voided.saleId)).status).toBe("PAID");
    await openVoidPanel(page, voided.number, "PAYMENT_PROBLEM");
    await sendVoid(page);
    await expect(page.getByTestId("void-done")).toBeVisible({ timeout: 20_000 });
    expect((await intentOf(voided.saleId)).status).toBe("REFUNDED");
    const [reversal] = await sql<{ reversals: unknown }>(
      `SELECT reversals FROM "SaleVoid" WHERE "saleId" = $1`,
      [voided.saleId],
    );
    expect(JSON.stringify(reversal!.reversals)).toContain("QPAY");
    expect(await stockOnHand(item.variantId, loc)).toBe(50_000);
    await page.getByRole("button", { name: mn.refunds.done.done }).click();

    // Refund in two steps of a sale paid entirely by QPay.
    const paid = await ring(page, [{ name: item.name, qty: 2 }], [{ qpay: true }]);
    await findSale(page, paid.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page);
    await expect(page.getByTestId("payout-QPAY")).toHaveText(mnt(minor(5_000)));
    await submitReturn(page);
    const done = await expectRefundDone(page);
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(0));
    await closeDone(page);
    const [first] = await refundsOf(paid.saleId);
    const firstPay = await payoutsOf(first!.id);
    expect(firstPay.map((p) => [p.method, p.amount])).toEqual([["QPAY", minor(5_000)]]);
    const [ref] = await sql<{ reference: string | null }>(
      `SELECT reference FROM "RefundPayment" WHERE "refundId" = $1`,
      [first!.id],
    );
    expect(ref!.reference).toBeTruthy();
    expect((await intentOf(paid.saleId)).status).toBe("PAID");

    await findSale(page, paid.number);
    await returnAll(page, item.name);
    await chooseReason(page);
    await submitReturn(page);
    await expectRefundDone(page);
    expect((await intentOf(paid.saleId)).status).toBe("REFUNDED");
    await expectFullyRefundedExactly(paid.saleId);
  });
});

test.describe("shifts", () => {
  test("cash movements, blind close, a frozen Z report, a refused late sale, a new shift and a cross-shift refund", async ({
    page,
    context,
    browser,
  }) => {
    test.setTimeout(120_000);
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const item = await product(loc, { label: "Shift", price: 3_000, stock: 50, suffix });

    const saleA = await ring(page, [{ name: item.name, qty: 2 }], [{ cash: 6_000 }]);
    await moveCash(page, { type: "in", amountMajor: 2_000, reason: "float top-up" });
    await moveCash(page, { type: "out", amountMajor: 1_000, reason: "courier" });
    const movements = await sql<{ type: string; amount: string; approvedById: string | null }>(
      `SELECT type::text, amount::text, "approvedById" FROM "CashMovement" WHERE "shiftId" = $1 ORDER BY "createdAt"`,
      [till.shiftId],
    );
    expect(movements.map((m) => [m.type, m.amount])).toEqual([
      ["CASH_IN", "200000"],
      ["CASH_OUT", "100000"],
    ]);
    expect(movements.every((m) => m.approvedById !== null)).toBe(true);

    // One piece goes back in this shift (3 000 ₮ out of the drawer).
    await findSale(page, saleA.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page);
    await submitReturn(page);
    await expectRefundDone(page);
    await closeDone(page);

    // A second screen of the same till, loaded while the shift is open, with a cart.
    // (own storage: two tabs with a cart on one register would trip the register's multi-tab guard)
    const lateContext = await browser.newContext({
      locale: "mn-MN",
      timezoneId: "Asia/Ulaanbaatar",
      storageState: { cookies: (await context.storageState()).cookies, origins: [] },
    });
    const late = await lateContext.newPage();
    await late.goto("/register");
    await fillCart(late, [{ name: item.name }]);
    const lateSaleId = await currentSaleId(late);

    // -- blind close: 52 500 ₮ counted against 54 000 ₮ expected needs a note ---------------
    const dialog = await countDrawer(page, { 20000: 2, 10000: 1, 1000: 2, 500: 1 });
    await expect(dialog.getByText(mnt(minor(54_000)))).toHaveCount(0);
    await reviewAndConfirmClose(dialog);
    await expect(
      dialog.getByRole("alert").filter({ hasText: mn.shifts.errors.VARIANCE_NOTE_REQUIRED }),
    ).toBeVisible();
    expect(
      await sql(`SELECT 1 FROM "Shift" WHERE id = $1 AND status = 'OPEN'`, [till.shiftId]),
    ).toHaveLength(1);
    await dialog.getByLabel(mn.shifts.close.note).fill("Short after the courier");
    await reviewAndConfirmClose(dialog);
    const result = page.getByTestId("close-result");
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.getByTestId("result-variance")).toHaveText(mnt(-minor(1_500)));

    // -- the Z report equals a recomputation from the rows and is frozen ----------------------
    const [shift] = await sql<{ expectedCash: string; countedCash: string; cashVariance: string }>(
      `SELECT "expectedCash"::text, "countedCash"::text, "cashVariance"::text FROM "Shift" WHERE id = $1`,
      [till.shiftId],
    );
    const [sums] = await sql<{
      expected: string;
      sales: string;
      refunds: string;
      refundCount: string;
    }>(
      `SELECT (s."openingFloat"
               + COALESCE((SELECT sum(p.amount) FROM "SalePayment" p JOIN "Sale" x ON x.id = p."saleId"
                            WHERE x."shiftId" = s.id AND p.method = 'CASH'
                              AND NOT EXISTS (SELECT 1 FROM "SaleVoid" v WHERE v."saleId" = x.id)), 0)
               - COALESCE((SELECT sum(rp.amount) FROM "RefundPayment" rp JOIN "Refund" r ON r.id = rp."refundId"
                            WHERE r."shiftId" = s.id AND rp.method = 'CASH'), 0)
               + COALESCE((SELECT sum(amount) FROM "CashMovement" WHERE "shiftId" = s.id AND type = 'CASH_IN'), 0)
               - COALESCE((SELECT sum(amount) FROM "CashMovement" WHERE "shiftId" = s.id AND type = 'CASH_OUT'), 0)
              )::text AS expected,
              COALESCE((SELECT sum("totalAmount") FROM "Sale" x WHERE x."shiftId" = s.id), 0)::text AS sales,
              COALESCE((SELECT sum("totalAmount") FROM "Refund" r WHERE r."shiftId" = s.id), 0)::text AS refunds,
              (SELECT count(*) FROM "Refund" r WHERE r."shiftId" = s.id)::text AS "refundCount"
         FROM "Shift" s WHERE s.id = $1`,
      [till.shiftId],
    );
    expect(sums!.expected).toBe(minor(54_000).toString());
    expect(shift).toEqual({
      expectedCash: minor(54_000).toString(),
      countedCash: minor(52_500).toString(),
      cashVariance: (-minor(1_500)).toString(),
    });
    const zRow = async () => {
      const [row] = await sql<{ data: Record<string, unknown> }>(
        `SELECT data FROM "ZReport" WHERE "shiftId" = $1`,
        [till.shiftId],
      );
      return row!.data;
    };
    const frozen = await zRow();
    expect(await sql(`SELECT 1 FROM "ZReport" WHERE "shiftId" = $1`, [till.shiftId])).toHaveLength(
      1,
    );
    expect(frozen).toMatchObject({
      kind: "Z",
      salesTotal: sums!.sales,
      refundCount: 1,
      refunds: { total: sums!.refunds },
      cash: { expected: sums!.expected, cashRefunds: minor(3_000).toString() },
    });

    // -- a sale from the screen that still believed in the shift is refused ------------------
    await chooseLateCharge(late);
    await expect(late.getByTestId("open-shift")).toBeVisible({ timeout: 20_000 });
    expect(await sql(`SELECT 1 FROM "Sale" WHERE id = $1`, [lateSaleId])).toHaveLength(0);
    await lateContext.close();

    // -- a new shift opens and sells --------------------------------------------------------
    await page.getByRole("dialog").getByRole("button", { name: mn.shifts.close.done }).click();
    await openShiftWithFloat(page, 20_000);
    const shiftB = await currentShiftIdOf(session.registerId);
    expect(shiftB).not.toBe(till.shiftId);
    const saleB = await ring(page, [{ name: item.name }], [{ cash: 3_000 }]);
    const [saleBRow] = await sql<{ shiftId: string }>(
      `SELECT "shiftId" FROM "Sale" WHERE id = $1`,
      [saleB.saleId],
    );
    expect(saleBRow!.shiftId).toBe(shiftB);

    // -- the rest of the earlier sale is returned now: it belongs to THIS shift --------------
    await findSale(page, saleA.number);
    await returnAll(page, item.name);
    await chooseReason(page);
    await submitReturn(page);
    await expectRefundDone(page);
    await closeDone(page);
    const refunds = await refundsOf(saleA.saleId);
    expect(refunds).toHaveLength(2);
    expect(refunds[0]!.shiftId).toBe(till.shiftId);
    expect(refunds[1]!.shiftId).toBe(shiftB);
    await openShiftMenu(page, mn.shifts.menu.xReport);
    const x = page.getByRole("dialog", { name: mn.shifts.report.titleX });
    await expect(x.getByTestId("sales-total")).toHaveText(mnt(minor(3_000)));
    await expect(x).toContainText(mnt(-minor(3_000)));
    await expect(x.getByTestId("net-sales")).toHaveText(mnt(0));
    await page.keyboard.press("Escape");

    // The closed shift's Z report did not move.
    expect(await zRow()).toEqual(frozen);
    const [after] = await sql<{ expectedCash: string }>(
      `SELECT "expectedCash"::text FROM "Shift" WHERE id = $1`,
      [till.shiftId],
    );
    expect(after!.expectedCash).toBe(minor(54_000).toString());

    // Back office shows the closed shift with its variance and the refund in the new one.
    const admin = await adminPage(browser);
    try {
      await admin.page.goto(`/shifts/${till.shiftId}`);
      await expect(admin.page.getByTestId("detail-variance")).toContainText(mnt(-minor(1_500)));
      await admin.page.goto(`/shifts/${shiftB}`);
      await expect(admin.page.locator(".shift-print")).toContainText(
        refunds[1]!.number.slice(0, 3),
      );
    } finally {
      await admin.context.close();
    }
  });
});

async function chooseLateCharge(late: Page) {
  await chargeButton(late).click();
  await expect(tenderDialog(late)).toBeVisible();
  await payCash(late, 3_000);
  await completeSale(late);
}

async function currentShiftIdOf(registerId: string): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `SELECT id FROM "Shift" WHERE "registerId" = $1 AND status = 'OPEN'`,
    [registerId],
  );
  return row!.id;
}

/**
 * The first request carrying `marker` reaches the server and commits, but its
 * answer is lost ("network failure after commit"); later ones go through.
 * Returns the bodies of every such request.
 */
async function loseFirstAnswer(page: Page, marker: string) {
  const bodies: string[] = [];
  let lost = false;
  await page.route("**/register", async (route) => {
    const request = route.request();
    const body = request.postData() ?? "";
    if (
      request.method() !== "POST" ||
      !request.headers()["next-action"] ||
      !body.includes(marker)
    ) {
      await route.continue();
      return;
    }
    bodies.push(body);
    if (lost) {
      await route.continue();
      return;
    }
    lost = true;
    await route.fetch(); // the server commits...
    await route.abort("failed"); // ...the browser never hears of it
  });
  return bodies;
}

test.describe("network failure after commit", () => {
  test("a refund whose answer is lost is retried into the same single refund", async ({ page }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const item = await product(loc, { label: "Net", price: 4_000, stock: 50, suffix });
    const sale = await ring(page, [{ name: item.name, qty: 2 }], [{ cash: 10_000 }]);

    const bodies = await loseFirstAnswer(page, '"expectedTotal"');
    await findSale(page, sale.number);
    await returnAll(page, item.name);
    await chooseReason(page);
    await submitReturn(page);
    const done = await expectRefundDone(page);
    await expect(done.getByTestId("done-cash")).toHaveText(mnt(minor(8_000)));

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(new Set(bodies.map((b) => JSON.parse(b)[0].refundId)).size).toBe(1);
    expect(await refundsOf(sale.saleId)).toHaveLength(1);
    expect(await stockOnHand(item.variantId, loc)).toBe(50_000);
    const restocks = (await movementsOf(item.variantId, loc)).filter(
      (m) => m.type === "RETURN_RESTOCK",
    );
    expect(restocks).toHaveLength(1);
    expect(await payoutsOf((await refundsOf(sale.saleId))[0]!.id)).toHaveLength(1);
  });

  test("an exchange whose answer is lost yields one refund and one replacement sale", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const old = await product(loc, { label: "Old", price: 5_000, stock: 50, suffix });
    const fresh = await product(loc, { label: "New", price: 8_000, stock: 50, suffix });
    const sale = await ring(page, [{ name: old.name, qty: 2 }], [{ cash: 10_000 }]);
    const bodies = await loseFirstAnswer(page, '"exchangeCheckout"');

    await startExchange(page, sale.number, { name: old.name, pieces: 1 });
    await addByName(page, fresh.name);
    await continueExchange(page);
    await payCash(page, 3_000);
    await completeSale(page);
    await expectRefundDone(page);

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    const refunds = await refundsOf(sale.saleId);
    expect(refunds).toHaveLength(1);
    const replacements = await sql(`SELECT 1 FROM "Sale" WHERE id = $1`, [
      refunds[0]!.exchangeSaleId,
    ]);
    expect(replacements).toHaveLength(1);
    const [count] = await sql<{ n: string }>(
      `SELECT count(*) AS n FROM "SaleLine" WHERE "variantId" = $1`,
      [fresh.variantId],
    );
    expect(count!.n).toBe("1");
    expect(await stockOnHand(old.variantId, loc)).toBe(49_000);
    expect(await stockOnHand(fresh.variantId, loc)).toBe(49_000);
    expect(await ledgerSum(fresh.variantId, loc)).toBe(49_000);
  });

  test("closing a shift whose answer is lost: confirming again gives the one stored result", async ({
    page,
  }) => {
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const item = await product(session.locationId, {
      label: "Close",
      price: 3_000,
      stock: 50,
      suffix,
    });
    await ring(page, [{ name: item.name }], [{ cash: 3_000 }]);
    await loseFirstAnswer(page, '"denominations"');

    // Exact count: 50 000 float + 3 000.
    const dialog = await countDrawer(page, { 20000: 2, 10000: 1, 1000: 3 });
    await reviewAndConfirmClose(dialog);
    await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 20_000 });
    expect(
      await sql(`SELECT 1 FROM "Shift" WHERE id = $1 AND status = 'CLOSED'`, [till.shiftId]),
    ).toHaveLength(1);

    await reviewAndConfirmClose(dialog);
    const result = page.getByTestId("close-result");
    await expect(result).toBeVisible({ timeout: 20_000 });
    await expect(result.getByTestId("result-variance")).toHaveText(mnt(0));
    expect(await sql(`SELECT 1 FROM "ZReport" WHERE "shiftId" = $1`, [till.shiftId])).toHaveLength(
      1,
    );
    const audit = await sql(
      `SELECT 1 FROM "AuditLog" WHERE action = 'shift.close' AND "entityId" = $1`,
      [till.shiftId],
    );
    expect(audit).toHaveLength(1);
  });
});

test.describe("390px phone", () => {
  test("the new screens do not overflow and raise no console errors", async ({
    page,
    context,
    browser,
  }) => {
    test.setTimeout(150_000);
    const suffix = uniq();
    const till = await bootTill(page);
    session = till.session;
    const loc = session.locationId;
    const item = await product(loc, { label: "Phone", price: 4_000, stock: 50, suffix });
    const other = await product(loc, { label: "Other", price: 6_000, stock: 50, suffix });
    const problems = watchConsole(page);
    const sale = await ring(
      page,
      [{ name: item.name, qty: 3 }],
      [{ card: 4_000 }, { cash: 10_000 }],
    );
    const second = await ring(page, [{ name: item.name }], [{ cash: 4_000 }]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();

    // Returns: find, lines, payout editor, approvals, void panel.
    await openReturns(page);
    await noOverflow(page, "returns: find");
    await findSale(page, sale.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page);
    await page.getByTestId("payout-choice-CUSTOM").click();
    await noOverflow(page, "returns: sale panel with custom payout");
    await page.getByTestId("payout-choice-ORIGINAL").click();
    await page.getByRole("button", { name: mn.refunds.panel.back }).click();

    // Refund it for real: the done screen and the approval dialog.
    await findSale(page, sale.number);
    await returnPieces(page, item.name, 1);
    await chooseReason(page);
    await page.getByTestId("refund-submit").click();
    await noOverflow(page, "approval dialog");
    await approveWithManagerPin(page);
    const done = await expectRefundDone(page);
    await expect(done).toBeVisible();
    await noOverflow(page, "refund done");
    const refund = (await refundsOf(sale.saleId))[0]!;
    await closeDone(page);

    // Void panel on a fresh sale.
    await openVoidPanel(page, second.number);
    await noOverflow(page, "void panel");
    await page.getByRole("button", { name: mn.refunds.panel.back }).click();
    await page.keyboard.press("Escape");

    // Exchange: bar, finish dialog, tender step.
    await startExchange(page, sale.number, { name: item.name, pieces: 1 });
    await addByName(page, other.name);
    await noOverflow(page, "exchange bar");
    await page.getByTestId("exchange-finish").click();
    await expect(page.getByTestId("exchange-finish-dialog")).toBeVisible();
    await noOverflow(page, "exchange finish");
    await page.keyboard.press("Escape");
    await page.getByTestId("exchange-cancel").click();

    // Shift screens.
    await openShiftMenu(page, mn.shifts.menu.cash);
    await expect(page.getByRole("dialog", { name: mn.shifts.cash.title })).toBeVisible();
    await noOverflow(page, "cash dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await openShiftMenu(page, mn.shifts.menu.xReport);
    await expect(page.getByRole("dialog", { name: mn.shifts.report.titleX })).toBeVisible();
    await noOverflow(page, "X report");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const close = await countDrawer(page, { 20000: 1 });
    await noOverflow(page, "close shift");
    await reviewAndConfirmClose(close);
    await expect(close.getByRole("alert")).toBeVisible();
    await noOverflow(page, "close shift: note required");
    await close.getByLabel(mn.shifts.close.note).fill("Counted on the phone");
    await reviewAndConfirmClose(close);
    await expect(page.getByTestId("close-result")).toBeVisible({ timeout: 20_000 });
    await noOverflow(page, "close result + Z report");
    expect(problems, problems.join("\n")).toEqual([]);

    // Back office and receipts at the same width.
    const admin = await adminPage(browser);
    try {
      await admin.page.setViewportSize({ width: 390, height: 844 });
      const adminProblems = watchConsole(admin.page);
      for (const path of [
        `/sales?q=${sale.number}`,
        `/sales/${sale.saleId}`,
        `/shifts?register=${session.registerId}`,
        `/shifts/${till.shiftId}`,
        `/receipt/refund/${refund.id}`,
      ]) {
        const before = adminProblems.length;
        await admin.page.goto(path);
        await expect(admin.page.getByRole("main").first()).toBeVisible();
        await noOverflow(admin.page, path);
        expect(adminProblems.slice(before), path).toEqual([]);
      }
    } finally {
      await admin.context.close();
    }
    void context;
  });
});
