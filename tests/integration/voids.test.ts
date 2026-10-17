import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { voidApprovalScope } from "@/domain/void-contract";
import { voidCodeFromFailure } from "@/domain/refund-failure";
import { setFiscalProviderForTests } from "@/server/adapters/fiscal";
import type { FiscalProvider } from "@/server/adapters/fiscal/types";
import { createMockEbarimtProvider } from "@/server/adapters/fiscal/mock-ebarimt";
import { runVoidFiscal } from "@/server/services/post-refund";
import { runPostSale } from "@/server/services/post-sale";
import { voidSale } from "@/server/services/voids";
import { findLedgerMismatches } from "@/server/services/stock";
import { createStockedProduct, createTill } from "../support/checkout-fixtures";
import { db, resetDatabase } from "../support/db";
import {
  allLines,
  approvalToken,
  doVoid,
  onHand,
  paidQpayIntent,
  refundOk,
  sell,
  uuidv7,
  voidFailure,
  voidInputOf,
} from "../support/refund-fixtures";

describe("voidSale", () => {
  beforeEach(resetDatabase);
  afterAll(async () => {
    setFiscalProviderForTests(null);
    await db.$disconnect();
  });

  it("voids a sale of the open shift: SaleVoid row, stock back at the original cost, audit", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n, cost: 40_000n });
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 3000 }], (p) => [
      { method: "CASH", amount: "200000", tendered: "300000" },
      { method: "CARD", amount: (p - 200_000n).toString(), reference: "T-1" },
    ]);
    await db.productVariant.update({ where: { id: variant.id }, data: { cost: 99_000n } });

    const { result, created } = await doVoid(
      till,
      s.saleId,
      { reason: "CUSTOMER_CANCELLED" },
      till.manager,
    );
    expect(created).toBe(true);
    expect(result).toMatchObject({
      saleId: s.saleId,
      receiptNumber: s.sale.number,
      totalAmount: s.sale.totalAmount,
      cashReturned: 200_000n, // what the till kept, never the 300 000 handed over
      replayed: false,
    });
    const row = await db.saleVoid.findUniqueOrThrow({ where: { saleId: s.saleId } });
    expect(row).toMatchObject({
      shiftId: till.shift!.id,
      reason: "CUSTOMER_CANCELLED",
      voidedById: till.manager.id,
      approvedById: null,
    });
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(row.reversals).toEqual([
      expect.objectContaining({ method: "CASH", kind: "CASH_RETURN", amount: "200000" }),
      expect.objectContaining({ method: "CARD", kind: "CARD_REVERSAL", reference: "T-1" }),
    ]);

    const back = await db.stockMovement.findFirstOrThrow({
      where: { saleId: s.saleId, type: "SALE_VOID" },
    });
    expect(back).toMatchObject({ qtyDeltaMilli: 3000, unitCost: 40_000n });
    expect(await onHand(till, variant.id)).toBe(100_000);
  });

  it("restores stock at the sale's cost snapshot and keeps the ledger consistent", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n, cost: 40_000n });
    const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }]);
    await db.productVariant.update({ where: { id: variant.id }, data: { cost: 99_000n } });
    await doVoid(till, s.saleId, {}, till.manager);
    const movement = await db.stockMovement.findFirstOrThrow({
      where: { saleId: s.saleId, type: "SALE_VOID" },
    });
    expect(movement).toMatchObject({ qtyDeltaMilli: 2000, unitCost: 40_000n });
    expect(await onHand(till, variant.id)).toBe(100_000);
    expect(await findLedgerMismatches(db)).toEqual([]);
    const audit = await db.auditLog.findFirst({
      where: { action: "sale.void", entityId: s.saleId },
    });
    expect(audit?.actorId).toBe(till.manager.id);
  });

  it("replays the same void, and answers a different reason as IDEMPOTENCY_CONFLICT", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const s = await sell(till, [{ variantId: variant.id }]);
    const first = await doVoid(till, s.saleId, { reason: "ENTRY_ERROR" }, till.manager);
    const again = await doVoid(
      till,
      s.saleId,
      { reason: "ENTRY_ERROR", approvals: { x: "y" } },
      till.manager,
    );
    expect(again.created).toBe(false);
    expect(again.result).toEqual({ ...first.result, replayed: true });
    const conflict = await voidFailure(
      doVoid(till, s.saleId, { reason: "PAYMENT_PROBLEM" }, till.manager),
    );
    expect(conflict.failure).toBe("IDEMPOTENCY_CONFLICT");
    expect(await db.saleVoid.count()).toBe(1);
    expect(await db.stockMovement.count({ where: { type: "SALE_VOID" } })).toBe(1);
    expect(voidCodeFromFailure({ fieldErrors: conflict.fieldErrors! })?.messageKey).toBe(
      "void.errors.IDEMPOTENCY_CONFLICT",
    );
  });

  describe("rules", () => {
    it("refuses a sale from another shift, a closed shift and a sale with refunds", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const old = await sell(till, [{ variantId: variant.id }]);
      const refunded = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }]);
      await refundOk(
        till,
        refunded.saleId,
        [{ saleLineId: refunded.lines[0]!.id, qtyMilli: 1000, restock: true }],
        {},
        till.manager,
      );
      expect((await voidFailure(doVoid(till, refunded.saleId, {}, till.manager))).failure).toBe(
        "ALREADY_REFUNDED",
      );

      // Shift closes: nothing can be voided any more.
      await db.shift.update({
        where: { id: till.shift!.id },
        data: { status: "CLOSED", closedAt: new Date(), closedById: till.cashier.id },
      });
      expect((await voidFailure(doVoid(till, old.saleId, {}, till.manager))).failure).toBe(
        "SHIFT_NOT_OPEN",
      );
      // A new shift opens: the old shift's sale is "another shift".
      await db.shift.create({
        data: {
          registerId: till.register.id,
          locationId: till.location.id,
          openedById: till.cashier.id,
          openingFloat: 0n,
        },
      });
      expect((await voidFailure(doVoid(till, old.saleId, {}, till.manager))).failure).toBe(
        "SALE_IN_OTHER_SHIFT",
      );
      expect(await db.saleVoid.count()).toBe(0);
    });

    it("needs a reason note for OTHER, hides sales of other locations", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const s = await sell(till, [{ variantId: variant.id }]);
      expect(
        (await voidFailure(doVoid(till, s.saleId, { reason: "OTHER" }, till.manager))).failure,
      ).toBe("REASON_NOTE_REQUIRED");
      const other = await createTill();
      expect((await voidFailure(doVoid(other, s.saleId, {}, other.manager))).failure).toBe(
        "SALE_NOT_FOUND",
      );
      expect((await voidFailure(doVoid(till, uuidv7(), {}, till.manager))).failure).toBe(
        "SALE_NOT_FOUND",
      );
      const ok = await doVoid(
        till,
        s.saleId,
        { reason: "OTHER", note: "wrong customer" },
        till.manager,
      );
      expect(ok.created).toBe(true);
    });

    it("a cashier needs pos.void or an approval bound to this sale and amount", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const s = await sell(till, [{ variantId: variant.id }]);
      const none = await voidFailure(doVoid(till, s.saleId));
      expect(none.failure).toBe("APPROVAL_REQUIRED");

      const scope = voidApprovalScope(s.saleId, s.sale.totalAmount);
      const bad = [
        approvalToken(till, "pos.void", voidApprovalScope(s.saleId, s.sale.totalAmount + 1n)),
        approvalToken(till, "pos.void", voidApprovalScope(uuidv7(), s.sale.totalAmount)),
        approvalToken(till, "pos.refund.approve", scope),
        approvalToken(till, "pos.void", scope, undefined, till.cashier.id),
      ];
      for (const token of bad) {
        const failure = await voidFailure(doVoid(till, s.saleId, { approvals: { void: token } }));
        expect(failure.failure).toBe("APPROVAL_INVALID");
      }
      const done = await doVoid(till, s.saleId, {
        approvals: { void: approvalToken(till, "pos.void", scope) },
      });
      expect(done.created).toBe(true);
      const row = await db.saleVoid.findUniqueOrThrow({ where: { saleId: s.saleId } });
      expect(row.voidedById).toBe(till.cashier.id);
      expect(row.approvedById).toBe(till.manager.id);
    });

    it("a voided sale can no longer be refunded or voided into something else", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const s = await sell(till, [{ variantId: variant.id }]);
      await doVoid(till, s.saleId, {}, till.manager);
      const failure = await refundOk(till, s.saleId, allLines(s.lines), {}, till.manager).catch(
        (e: { failure: string }) => e,
      );
      expect((failure as { failure: string }).failure).toBe("SALE_NOT_COMPLETED");
    });
  });

  describe("payments", () => {
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
      await doVoid(till, s.saleId, {}, till.manager);
      expect((await db.paymentIntent.findUniqueOrThrow({ where: { id: intentId } })).status).toBe(
        "REFUNDED",
      );
      const row = await db.saleVoid.findUniqueOrThrow({ where: { saleId } });
      expect((row.reversals as { reference: string }[])[0]!.reference).toMatch(/^mockrefund_/);
    });

    it("rolls everything back (retryable) when the provider answers too late", async () => {
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
      const { getPaymentProvider, setPaymentProviderForTests } =
        await import("@/server/adapters/payments");
      const { setProviderRefundTimeoutForTests } = await import("@/server/services/provider-call");
      const real = getPaymentProvider();
      setProviderRefundTimeoutForTests(50);
      setPaymentProviderForTests({
        ...real,
        name: real.name,
        createInvoice: (i) => real.createInvoice(i),
        checkPayment: (r) => real.checkPayment(r),
        refund: async (input) => {
          const answer = await real.refund(input);
          await new Promise((r) => setTimeout(r, 400));
          return answer;
        },
      });
      try {
        const failure = await voidFailure(doVoid(till, s.saleId, {}, till.manager));
        expect(failure.failure).toBe("VOID_NOT_ALLOWED");
        expect(failure.details).toMatchObject({ timedOut: true, retryable: true });
        expect(await db.saleVoid.count()).toBe(0);
        expect(await onHand(till, variant.id)).toBe(100_000 - 1000);
      } finally {
        setPaymentProviderForTests(null);
        setProviderRefundTimeoutForTests(null);
      }
      // The retry (same key) goes through and does not pay out twice.
      await doVoid(till, s.saleId, {}, till.manager);
      expect(await db.saleVoid.count()).toBe(1);
    });

    it("rolls everything back when the provider refuses", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till, { price: 100_000n });
      const saleId = uuidv7();
      const { intentId, providerRef } = await paidQpayIntent(till, saleId, 100_000n);
      const s = await sell(
        till,
        [{ variantId: variant.id }],
        () => [{ method: "QPAY", amount: "100000", paymentIntentId: intentId }],
        { saleId },
      );
      const { getPaymentProvider } = await import("@/server/adapters/payments");
      // Refund it at the provider behind our back: a second refund must fail.
      await getPaymentProvider().refund({ providerRef, amount: 100_000n });
      const failure = await voidFailure(doVoid(till, s.saleId, {}, till.manager));
      expect(failure.failure).toBe("VOID_NOT_ALLOWED");
      expect(await db.saleVoid.count()).toBe(0);
      expect(await db.stockMovement.count({ where: { type: "SALE_VOID" } })).toBe(0);
      expect(await onHand(till, variant.id)).toBe(100_000 - 1000);
    });
  });

  describe("fiscal", () => {
    it("cancels a never-issued receipt, and returns an issued one", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const never = await sell(till, [{ variantId: variant.id }]);
      await doVoid(till, never.saleId, {}, till.manager);
      expect(await runVoidFiscal(never.saleId)).toBe("CANCELLED");
      // The retry queue must not issue a voided sale afterwards.
      await runPostSale(never.saleId);
      const receipt = await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: never.saleId } });
      expect(receipt).toMatchObject({ status: "CANCELLED", externalId: null });

      const returns: string[] = [];
      const mock = createMockEbarimtProvider();
      const spy: FiscalProvider = {
        ...mock,
        issueReturn: async (request) => {
          returns.push(request.originalExternalId);
          return mock.issueReturn(request);
        },
      };
      setFiscalProviderForTests(spy);
      const issued = await sell(till, [{ variantId: variant.id }]);
      await runPostSale(issued.saleId);
      const before = await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: issued.saleId } });
      expect(before.status).toBe("ISSUED");
      await doVoid(till, issued.saleId, {}, till.manager);
      expect(await runVoidFiscal(issued.saleId)).toBe("CANCELLED");
      expect(await runVoidFiscal(issued.saleId)).toBe("CANCELLED"); // idempotent
      expect(returns).toEqual([before.externalId]);
      const after = await db.fiscalReceipt.findUniqueOrThrow({ where: { saleId: issued.saleId } });
      expect(after.status).toBe("CANCELLED");
    });
  });

  describe("concurrency", () => {
    it("20 parallel identical voids write one void and restock once", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      const s = await sell(till, [{ variantId: variant.id, qtyMilli: 2000 }]);
      const input = voidInputOf(s.saleId);
      const results = await Promise.all(
        Array.from({ length: 20 }, () => voidSale(input, till.ctx(till.manager))),
      );
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await db.saleVoid.count()).toBe(1);
      expect(await db.stockMovement.count({ where: { type: "SALE_VOID" } })).toBe(1);
      expect(await onHand(till, variant.id)).toBe(100_000);
      expect(await findLedgerMismatches(db)).toEqual([]);
    });

    it("a void and a refund of the same sale never both succeed", async () => {
      const till = await createTill();
      const { variant } = await createStockedProduct(till);
      for (let i = 0; i < 5; i++) {
        const s = await sell(till, [{ variantId: variant.id }]);
        const refund = refundOk(till, s.saleId, allLines(s.lines), {}, till.manager).then(
          () => "refund",
          () => "refund-failed",
        );
        const voided = doVoid(till, s.saleId, {}, till.manager).then(
          () => "void",
          () => "void-failed",
        );
        const outcomes = await Promise.all([refund, voided]);
        expect(outcomes.filter((o) => !o.endsWith("failed"))).toHaveLength(1);
        const [voids, refunds] = await Promise.all([
          db.saleVoid.count({ where: { saleId: s.saleId } }),
          db.refund.count({ where: { saleId: s.saleId } }),
        ]);
        expect(voids + refunds).toBe(1);
      }
      expect(await findLedgerMismatches(db)).toEqual([]);
    });
  });

  it("void rows cannot be updated or deleted", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till);
    const s = await sell(till, [{ variantId: variant.id }]);
    await doVoid(till, s.saleId, {}, till.manager);
    await expect(
      db.saleVoid.update({ where: { saleId: s.saleId }, data: { note: "x" } }),
    ).rejects.toThrow();
    await expect(db.saleVoid.delete({ where: { saleId: s.saleId } })).rejects.toThrow();
  });
});
