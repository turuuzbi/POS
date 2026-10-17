import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getPaymentProvider, setPaymentProviderForTests } from "@/server/adapters/payments";
import { setProviderRefundTimeoutForTests } from "@/server/services/provider-call";
import { refundApprovalKeys } from "@/domain/refund-contract";
import { refundCodeFromFailure } from "@/domain/refund-failure";
import { runRefundFiscal } from "@/server/services/post-refund";
import { runPostSale } from "@/server/services/post-sale";
import { refundSale } from "@/server/services/refunds";
import { findLedgerMismatches } from "@/server/services/stock";
import { createStockedProduct, createTill } from "../support/checkout-fixtures";
import { createLocation, createUser } from "../support/fixtures";
import { db, resetDatabase } from "../support/db";
import {
  allLines,
  approvalToken,
  doVoid,
  loadSale,
  onHand,
  paidQpayIntent,
  refundFailure,
  refundInputOf,
  refundOk,
  sell,
  uuidv7,
  withTotal,
} from "../support/refund-fixtures";

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe("refundSale", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("refunds a whole sale once, restocks at the original cost, and refuses a second refund", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 99_900n, cost: 40_000n });
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 3000, discountBps: 500 }]);
    expect(await onHand(till, variant.id)).toBe(100_000 - 3000);
    // The catalog cost moves on; the refund must still use the sale's snapshot.
    await db.productVariant.update({ where: { id: variant.id }, data: { cost: 77_000n } });

    const { result, input } = await refundOk(till, s.saleId, allLines(s.lines), {}, till.manager);
    expect(result.replayed).toBe(false);
    expect(result.completesSale).toBe(true);
    expect(result.receiptNumber).toBe(`${till.location.code}-R-000001`);
    expect(result.totals.totalAmount).toBe(s.sale.totalAmount);
    expect(result.cashRefund).toBe(s.sale.totalAmount);

    const refund = await db.refund.findUniqueOrThrow({
      where: { id: input.refundId },
      include: { lines: true, payments: true },
    });
    expect(refund.shiftId).toBe(till.shift!.id);
    expect(refund.registerId).toBe(till.register.id);
    expect(refund.processedById).toBe(till.manager.id);
    expect(refund.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(refund.netAmount + refund.vatAmount + refund.cityTaxAmount).toBe(
      s.sale.netAmount + s.sale.vatAmount + s.sale.cityTaxAmount,
    );
    expect(refund.lines).toHaveLength(1);
    expect(refund.payments).toEqual([
      expect.objectContaining({
        method: "CASH",
        amount: s.sale.totalAmount,
        originalPaymentId: s.payments[0]!.id,
      }),
    ]);

    const movement = await db.stockMovement.findFirstOrThrow({
      where: { refundId: input.refundId },
    });
    expect(movement).toMatchObject({
      type: "RETURN_RESTOCK",
      qtyDeltaMilli: 3000,
      unitCost: 40_000n,
    });
    expect(await onHand(till, variant.id)).toBe(100_000);
    expect(await findLedgerMismatches(db)).toEqual([]);

    const audits = await db.auditLog.findMany({ where: { entityId: input.refundId } });
    expect(audits.map((a) => a.action)).toContain("refund.create");

    const second = await refundFailure(
      refundOk(till, s.saleId, allLines(s.lines), {}, till.manager),
    );
    expect(second.failure).toBe("ALREADY_REFUNDED");
    expect(
      refundCodeFromFailure(second.fieldErrors ? { fieldErrors: second.fieldErrors } : {})?.code,
    ).toBe("ALREADY_REFUNDED");
    expect(await db.refund.count()).toBe(1);
  });

  it("partial refunds in any partition add up to the sale exactly", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 33_333n, cost: 10_000n });
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 7000, discountBps: 700 }]);
    const line = s.lines[0]!;
    const totals: bigint[] = [];
    // 1 + 3 + 2 + 1 units, every step through the real service.
    for (const units of [1, 3, 2, 1]) {
      const { result } = await refundOk(
        till,
        s.saleId,
        [{ saleLineId: line.id, qtyMilli: units * 1000, restock: true }],
        {},
        till.manager,
      );
      totals.push(result.totals.totalAmount);
      expect(result.completesSale).toBe(units === 1 && totals.length === 4);
    }
    const refunds = await db.refund.findMany({ include: { lines: true } });
    expect(sum(refunds.map((r) => r.totalAmount))).toBe(s.sale.totalAmount);
    const rl = refunds.flatMap((r) => r.lines);
    expect(sum(rl.map((l) => l.totalAmount))).toBe(line.totalAmount);
    expect(sum(rl.map((l) => l.vatAmount))).toBe(line.vatAmount);
    expect(sum(rl.map((l) => l.netAmount))).toBe(line.netAmount);
    expect(sum(rl.map((l) => BigInt(l.qtyMilli)))).toBe(BigInt(line.qtyMilli));
    expect(await onHand(till, variant.id)).toBe(100_000);
    expect(await findLedgerMismatches(db)).toEqual([]);
    expect(
      (
        await refundFailure(
          refundOk(
            till,
            s.saleId,
            [{ saleLineId: line.id, qtyMilli: 1000, restock: true }],
            {},
            till.manager,
          ),
        )
      ).failure,
    ).toBe("ALREADY_REFUNDED");
  });

  it("refunds a weighed item by any weight and refuses pieces in fractions", async () => {
    const till = await createTill();
    const weighed = await createStockedProduct(till, { unit: "KG", price: 12_345n, cost: 5_000n });
    const piece = await createStockedProduct(till, { price: 50_000n });
    const s = await sell(till, [
      { variantId: weighed.variant.id, qtyMilli: 1250 },
      { variantId: piece.variant.id, qtyMilli: 2000 },
    ]);
    const [w, p] = s.lines;
    const failure = await refundFailure(
      refundOk(
        till,
        s.saleId,
        [{ saleLineId: p!.id, qtyMilli: 500, restock: true }],
        {},
        till.manager,
      ),
    );
    expect(failure.failure).toBe("INVALID_QUANTITY");
    const a = await refundOk(
      till,
      s.saleId,
      [{ saleLineId: w!.id, qtyMilli: 400, restock: true }],
      {},
      till.manager,
    );
    const b = await refundOk(
      till,
      s.saleId,
      [{ saleLineId: w!.id, qtyMilli: 850, restock: true }],
      {},
      till.manager,
    );
    const partsOf = (r: { result: { lines: { totalAmount: bigint }[] } }) =>
      r.result.lines[0]!.totalAmount;
    expect(partsOf(a) + partsOf(b)).toBe(w!.totalAmount);
    expect(await onHand(till, weighed.variant.id)).toBe(100_000);
    expect(await findLedgerMismatches(db)).toEqual([]);
  });

  it("splits a refund across the original tenders; cash never exceeds what the till kept", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    // 40 000 cash (handed over 50 000, change 10 000) + card for the rest.
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }], (p) => [
      { method: "CASH", amount: "80000", tendered: "100000" },
      { method: "CARD", amount: (p - 80_000n).toString(), reference: "TERM-123" },
    ]);
    const cash = s.payments.find((x) => x.method === "CASH")!;
    expect(cash.change).toBe(20_000n);

    const { result } = await refundOk(till, s.saleId, allLines(s.lines), {}, till.manager);
    const byMethod = Object.fromEntries(result.payments.map((p) => [p.method, p]));
    expect(byMethod.CASH!.amount).toBe(80_000n); // not the 100 000 tendered
    expect(byMethod.CARD!.amount).toBe(s.payable - 80_000n);
    expect(byMethod.CASH!.originalPaymentId).toBe(cash.id);
    const rows = await db.refundPayment.findMany({ where: { refundId: result.refundId } });
    expect(rows.find((r) => r.method === "CARD")!.reference).toBe("TERM-123");
    expect(result.cashRefund).toBe(80_000n);
  });

  it("refunds a QPay payment through the provider and marks the intent refunded", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    const saleId = uuidv7();
    const { intentId } = await paidQpayIntent(till, saleId, 100_000n);
    const s = await sell(
      till,
      [{ variantId: variant.id }],
      () => [{ method: "QPAY", amount: "100000", paymentIntentId: intentId }],
      { saleId },
    );
    const { result } = await refundOk(till, s.saleId, allLines(s.lines), {}, till.manager);
    expect(result.payments).toEqual([
      expect.objectContaining({ method: "QPAY", amount: 100_000n }),
    ]);
    const row = await db.refundPayment.findFirstOrThrow({ where: { refundId: result.refundId } });
    expect(row.reference).toMatch(/^mockrefund_/);
    expect((await db.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe(
      "REFUNDED",
    );
  });

  it("a provider that answers too late rolls the refund back (retryable); the retry reuses the key", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    const saleId = uuidv7();
    const { intentId } = await paidQpayIntent(till, saleId, 100_000n);
    const s = await sell(
      till,
      [{ variantId: variant.id }],
      () => [{ method: "QPAY", amount: "100000", paymentIntentId: intentId }],
      { saleId },
    );
    const real = getPaymentProvider();
    const keys: (string | undefined)[] = [];
    let slow = true;
    setProviderRefundTimeoutForTests(50);
    setPaymentProviderForTests({
      ...real,
      name: real.name,
      createInvoice: (i) => real.createInvoice(i),
      checkPayment: (r) => real.checkPayment(r),
      refund: async (input) => {
        keys.push(input.idempotencyKey);
        const answer = await real.refund(input);
        if (slow) await new Promise((r) => setTimeout(r, 400));
        return answer;
      },
    });
    try {
      const ctx = till.ctx(till.manager);
      const draft = await withTotal(refundInputOf(s.saleId, allLines(s.lines)), ctx);
      const failure = await refundFailure(refundSale(draft, ctx));
      expect(failure.failure).toBe("PAYMENT_PROVIDER_FAILED");
      expect(failure.details).toMatchObject({ timedOut: true, retryable: true });
      expect(await db.refund.count()).toBe(0);
      expect(await db.stockMovement.count({ where: { type: "RETURN_RESTOCK" } })).toBe(0);
      expect(await onHand(till, variant.id)).toBe(100_000 - 1000);
      expect(
        (await db.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status,
      ).not.toBe("REFUNDED");

      slow = false;
      const retried = await refundSale(draft, ctx);
      expect(retried.created).toBe(true);
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]); // the provider replays the first answer, no second payout
      expect(await db.refund.count()).toBe(1);
      expect(await onHand(till, variant.id)).toBe(100_000);
    } finally {
      setPaymentProviderForTests(null);
      setProviderRefundTimeoutForTests(null);
    }
  });

  describe("approvals", () => {
    it("a cashier needs a manager approval bound to the exact refund", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }]);
      const ctx = till.ctx();
      const line = s.lines[0]!;
      const draft = await withTotal(
        refundInputOf(s.saleId, [{ saleLineId: line.id, qtyMilli: 1000, restock: true }]),
        ctx,
      );

      const missing = await refundFailure(refundSale(draft, ctx));
      expect(missing.failure).toBe("APPROVAL_REQUIRED");
      const required = (missing.details as { required: { key: string; scope: string }[] }).required;
      expect(required.map((r) => r.key)).toEqual([refundApprovalKeys.refund]);
      const scope = required[0]!.scope;

      // A token for another refund / amount / permission is rejected.
      const wrongScope = approvalToken(till, "pos.refund.approve", scope.replace(/:\d+:/, ":999:"));
      expect(
        (await refundFailure(refundSale({ ...draft, approvals: { refund: wrongScope } }, ctx)))
          .failure,
      ).toBe("APPROVAL_INVALID");
      const wrongPermission = approvalToken(till, "pos.void", scope);
      expect(
        (await refundFailure(refundSale({ ...draft, approvals: { refund: wrongPermission } }, ctx)))
          .failure,
      ).toBe("APPROVAL_INVALID");
      // An approver who is only a cashier is no approver.
      const forged = approvalToken(till, "pos.refund.approve", scope, undefined, till.cashier.id);
      expect(
        (await refundFailure(refundSale({ ...draft, approvals: { refund: forged } }, ctx))).failure,
      ).toBe("APPROVAL_INVALID");
      // The same token for a different quantity does not carry over.
      const other = await withTotal(
        refundInputOf(s.saleId, [{ saleLineId: line.id, qtyMilli: 2000, restock: true }], {
          refundId: draft.refundId,
        }),
        ctx,
      );
      expect(
        (
          await refundFailure(
            refundSale(
              { ...other, approvals: { refund: approvalToken(till, "pos.refund.approve", scope) } },
              ctx,
            ),
          )
        ).failure,
      ).toBe("APPROVAL_INVALID");
      expect(await db.refund.count()).toBe(0);

      const token = approvalToken(till, "pos.refund.approve", scope);
      const ok = await refundSale({ ...draft, approvals: { refund: token } }, ctx);
      expect(ok.created).toBe(true);
      const refund = await db.refund.findUniqueOrThrow({ where: { id: draft.refundId } });
      expect(refund.processedById).toBe(till.cashier.id);
      expect(refund.approvedById).toBe(till.manager.id);
      const used = await db.auditLog.findFirst({ where: { action: "refund.approval_used" } });
      expect(used?.actorId).toBe(till.manager.id);
    });

    it("paying out cross-method needs the override approval; card cannot be paid back as cash by a cashier", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }], (p) => [
        { method: "CARD", amount: p.toString() },
      ]);
      const ctx = till.ctx();
      const lines = allLines(s.lines);
      const draft = await withTotal(
        refundInputOf(s.saleId, lines, { payments: [{ method: "CASH", amount: "100000" }] }),
        ctx,
      );
      const first = await refundFailure(refundSale(draft, ctx));
      const required = (first.details as { required: { key: string; scope: string }[] }).required;
      expect(required.map((r) => r.key).sort()).toEqual(["refund", "refund:method"]);
      const tokens = Object.fromEntries(
        required.map((r) => [r.key, approvalToken(till, "pos.refund.approve", r.scope)]),
      );
      // Only the refund approval: still missing the method override.
      const half = await refundFailure(
        refundSale({ ...draft, approvals: { refund: tokens.refund! } }, ctx),
      );
      expect(half.failure).toBe("APPROVAL_REQUIRED");
      expect((half.details as { key: string }).key).toBe("refund:method");

      const done = await refundSale({ ...draft, approvals: tokens }, ctx);
      expect(done.result.payments).toEqual([
        expect.objectContaining({ method: "CASH", amount: 100_000n }),
      ]);
      expect(done.result.cashRefund).toBe(100_000n);
    });

    it("a manager may override the payout split within the original tenders without extra approval", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }], () => [
        { method: "CASH", amount: "100000" },
        { method: "CARD", amount: "100000" },
      ]);
      const line = s.lines[0]!;
      const { result } = await refundOk(
        till,
        s.saleId,
        [{ saleLineId: line.id, qtyMilli: 1000, restock: true }],
        { payments: [{ method: "CARD", amount: "100000" }] },
        till.manager,
      );
      // The default would be half cash, half card.
      expect(result.payments.map((p) => [p.method, p.amount])).toEqual([["CARD", 100_000n]]);
      expect(result.cashRefund).toBe(0n);
    });

    it("refuses card and QPay beyond what they paid even for a manager", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }], () => [
        { method: "CASH", amount: "100000" },
      ]);
      const failure = await refundFailure(
        refundOk(
          till,
          s.saleId,
          allLines(s.lines),
          { payments: [{ method: "CARD", amount: "100000" }] },
          till.manager,
        ),
      );
      expect(failure.failure).toBe("REFUND_METHOD_NOT_ALLOWED");
    });

    it("refunds outside the window need the window approval (manager holds it implicitly)", async () => {
      const till = await createTill();
      await db.businessSettings.upsert({
        where: { id: 1 },
        update: { refundWindowDays: 7 },
        create: { id: 1, businessName: "Test", refundWindowDays: 7 },
      });
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }]);
      const later = new Date(Date.now() + 10 * 86_400_000);
      const ctx = { ...till.ctx(), now: later };
      const line = s.lines[0]!;
      const draft = await withTotal(
        refundInputOf(s.saleId, [{ saleLineId: line.id, qtyMilli: 1000, restock: true }]),
        ctx,
      );
      const refused = await refundFailure(refundSale(draft, ctx));
      expect(refused.failure).toBe("REFUND_WINDOW_EXCEEDED");
      const required = (refused.details as { required: { key: string; scope: string }[] }).required;
      expect(required.map((r) => r.key).sort()).toEqual(["refund", "refund:window"]);
      const tokens = Object.fromEntries(
        required.map((r) => [r.key, approvalToken(till, "pos.refund.approve", r.scope, later)]),
      );
      const done = await refundSale({ ...draft, approvals: tokens }, ctx);
      expect(done.created).toBe(true);

      // Inside the window nothing special is needed beyond the refund approval.
      const fresh = await sell(till, [{ variantId: variant.id }]);
      const ok = await refundOk(till, fresh.saleId, allLines(fresh.lines), {}, till.manager);
      expect(ok.result.completesSale).toBe(true);
      // A manager refunds the old sale on their own authority.
      const rest = await refundOk(
        till,
        s.saleId,
        [{ saleLineId: line.id, qtyMilli: 1000, restock: true }],
        {},
        till.manager,
        {},
        later,
      );
      expect(rest.result.completesSale).toBe(true);
    });
  });

  describe("stock", () => {
    it("restock off moves no stock and no cost; restock on keeps the ledger consistent", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n, cost: 30_000n });
      const s = await sell(till, [{ variantId: variant.id, qtyMilli: 4000 }]);
      const line = s.lines[0]!;
      const off = await refundOk(
        till,
        s.saleId,
        [{ saleLineId: line.id, qtyMilli: 1000, restock: false }],
        {},
        till.manager,
      );
      expect(await db.stockMovement.count({ where: { refundId: off.result.refundId } })).toBe(0);
      expect(await onHand(till, variant.id)).toBe(100_000 - 4000);
      const rl = await db.refundLine.findFirstOrThrow({ where: { refundId: off.result.refundId } });
      expect(rl.restock).toBe(false);

      await refundOk(
        till,
        s.saleId,
        [{ saleLineId: line.id, qtyMilli: 3000, restock: true }],
        {},
        till.manager,
      );
      expect(await onHand(till, variant.id)).toBe(100_000 - 4000 + 3000);
      expect(await findLedgerMismatches(db)).toEqual([]);
    });

    it("an untracked service line is refunded without any stock movement", async () => {
      const till = await createTill();
      const svc = await createStockedProduct(till, {
        type: "SERVICE",
        trackStock: false,
        price: 80_000n,
      });
      const s = await sell(till, [{ variantId: svc.variant.id }]);
      const { result } = await refundOk(till, s.saleId, allLines(s.lines), {}, till.manager);
      expect(result.completesSale).toBe(true);
      expect(await db.stockMovement.count()).toBe(0);
    });
  });

  describe("idempotency and scoping", () => {
    it("replays the same refund id, and answers different content as IDEMPOTENCY_CONFLICT", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id, qtyMilli: 3000 }]);
      const line = s.lines[0]!;
      const ctx = till.ctx(till.manager);
      const input = await withTotal(
        refundInputOf(s.saleId, [{ saleLineId: line.id, qtyMilli: 1000, restock: true }]),
        ctx,
      );
      const first = await refundSale(input, ctx);
      const again = await refundSale(
        { ...input, approvals: { x: "fresh" }, createdAtClient: new Date().toISOString() },
        ctx,
      );
      expect(again.result.replayed).toBe(true);
      expect(again.created).toBe(false);
      expect({ ...again.result, replayed: false }).toEqual(first.result);
      expect(await db.refund.count()).toBe(1);
      expect(await db.stockMovement.count({ where: { type: "RETURN_RESTOCK" } })).toBe(1);

      const different = {
        ...input,
        lines: [{ ...input.lines[0]!, qtyMilli: 2000 }],
      };
      expect((await refundFailure(refundSale(different, ctx))).failure).toBe(
        "IDEMPOTENCY_CONFLICT",
      );
      expect(await db.refund.count()).toBe(1);
    });

    it("needs an open shift (SHIFT_NOT_OPEN) and books on the new one after a handover", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }]);
      const old = till.shift!;
      await db.shift.update({
        where: { id: old.id },
        data: { status: "CLOSED", closedAt: new Date(), closedById: till.cashier.id },
      });
      const line = s.lines[0]!;
      const one = [{ saleLineId: line.id, qtyMilli: 1000, restock: true }];
      expect((await refundFailure(refundOk(till, s.saleId, one, {}, till.manager))).failure).toBe(
        "SHIFT_NOT_OPEN",
      );
      const next = await db.shift.create({
        data: {
          registerId: till.register.id,
          locationId: till.location.id,
          openedById: till.cashier.id,
          openingFloat: 0n,
        },
      });
      const { input } = await refundOk(till, s.saleId, one, {}, till.manager);
      const refund = await db.refund.findUniqueOrThrow({ where: { id: input.refundId } });
      expect(refund.shiftId).toBe(next.id);
      expect(refund.shiftId).not.toBe(old.id);
    });

    it("hides sales of other locations, and refuses a voided sale", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }]);
      const other = await createTill();
      expect(
        (await refundFailure(refundOk(other, s.saleId, allLines(s.lines), {}, other.manager)))
          .failure,
      ).toBe("SALE_NOT_FOUND");

      await doVoid(till, s.saleId, {}, till.manager);
      expect(
        (await refundFailure(refundOk(till, s.saleId, allLines(s.lines), {}, till.manager)))
          .failure,
      ).toBe("SALE_NOT_COMPLETED");
    });

    it("rejects a changed total, unknown lines and a missing exchange checkout", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }]);
      const ctx = till.ctx(till.manager);
      const input = refundInputOf(s.saleId, allLines(s.lines), { expectedTotal: "12345" });
      const mismatch = await refundFailure(refundSale(input, ctx));
      expect(mismatch.failure).toBe("TOTAL_MISMATCH");
      expect(mismatch.details).toMatchObject({ expected: "12345", actual: "100000" });
      const unknown = refundInputOf(s.saleId, [
        { saleLineId: uuidv7(), qtyMilli: 1000, restock: true },
      ]);
      expect((await refundFailure(refundSale(unknown, ctx))).failure).toBe("UNKNOWN_LINE");
      const exchange = refundInputOf(s.saleId, allLines(s.lines), {
        exchange: { saleId: uuidv7(), expectedPayable: "50000" },
      });
      expect((await refundFailure(refundSale(exchange, ctx))).failure).toBe("EXCHANGE_INVALID");
      expect(await db.refund.count()).toBe(0);
    });

    it("a cashier of another location cannot refund here", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }]);
      const { location } = await createLocation();
      const stranger = await createUser({ role: "MANAGER", locationIds: [location.id] });
      const input = refundInputOf(s.saleId, allLines(s.lines));
      const ctx = {
        ...till.ctx(),
        user: { id: stranger.id, role: stranger.role, locationIds: [location.id] },
      };
      expect((await refundFailure(refundSale(input, ctx))).failure).toBe("PERMISSION_DENIED");
    });
  });

  describe("fiscal and append-only", () => {
    it("issues the fiscal return after the original receipt, and retries when the original is missing", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }]);
      const { result } = await refundOk(till, s.saleId, allLines(s.lines), {}, till.manager);
      await runRefundFiscal(result.refundId);
      const failed = await db.fiscalReceipt.findUniqueOrThrow({
        where: { refundId: result.refundId },
      });
      expect(failed.status).toBe("FAILED");
      expect(failed.error).toMatch(/original/);

      await runPostSale(s.saleId);
      expect(
        (await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: s.saleId } })).status,
      ).toBe("ISSUED");
      await runRefundFiscal(result.refundId);
      const issued = await db.fiscalReceipt.findUniqueOrThrow({
        where: { refundId: result.refundId },
      });
      expect(issued.status).toBe("ISSUED");
      expect(issued.externalId).toMatch(/^MOCK-R-/);
    });

    it("refund rows cannot be updated or deleted", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }]);
      const { result } = await refundOk(till, s.saleId, allLines(s.lines), {}, till.manager);
      await expect(
        db.refund.update({ where: { id: result.refundId }, data: { note: "tamper" } }),
      ).rejects.toThrow();
      await expect(
        db.refundLine.deleteMany({ where: { refundId: result.refundId } }),
      ).rejects.toThrow();
      await expect(
        db.refundPayment.updateMany({ where: { refundId: result.refundId }, data: { amount: 1n } }),
      ).rejects.toThrow();
      const { sale } = await loadSale(s.saleId);
      expect(sale.totalAmount).toBe(s.sale.totalAmount);
    });
  });
});
