import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { fromMajor } from "@/domain/money";
import type { PurchaseOrderInput } from "@/domain/purchasing";
import { units } from "@/domain/qty";
import { ActionError } from "@/server/errors";
import {
  deleteSupplier,
  receiveGoods,
  removeSupplierItem,
  savePurchaseOrder,
  saveSupplier,
  saveSupplierItem,
  setSupplierActive,
  transitionPurchaseOrder,
  type ReceiptRequest,
  type ReceiveOptions,
} from "@/server/services/purchasing";
import { findLedgerMismatches } from "@/server/services/stock";
import { db, resetDatabase } from "../support/db";
import { createLocation, createProduct, createUser } from "../support/fixtures";

const supplierInput = (name = "Supplier") => ({
  name,
  contactName: null,
  phone: null,
  email: null,
  taxId: null,
  address: null,
  notes: null,
});

async function setup() {
  const { location } = await createLocation();
  const user = await createUser({ role: "MANAGER", locationIds: [location.id] });
  const supplier = await db.$transaction((tx) => saveSupplier(tx, supplierInput(), user));
  return { location, user, supplierId: supplier.id };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function poInput(ctx: Ctx, lines: { variantId: string; qty: number; cost: bigint }[]) {
  return {
    supplierId: ctx.supplierId,
    locationId: ctx.location.id,
    expectedAt: null,
    note: null,
    lines: lines.map((l) => ({
      variantId: l.variantId,
      qtyMilli: units(l.qty),
      unitCost: l.cost,
    })),
  } satisfies PurchaseOrderInput;
}

async function orderedPo(ctx: Ctx, lines: { variantId: string; qty: number; cost: bigint }[]) {
  const po = await db.$transaction((tx) => savePurchaseOrder(tx, poInput(ctx, lines), ctx.user));
  await db.$transaction((tx) => transitionPurchaseOrder(tx, po.id, "ORDERED", ctx.user));
  return po;
}

const receive = (ctx: Ctx, input: ReceiptRequest, options?: ReceiveOptions) =>
  db.$transaction((tx) => receiveGoods(tx, input, ctx.user, {}, options));

const poLines = (poId: string) =>
  db.purchaseOrderLine.findMany({ where: { purchaseOrderId: poId }, orderBy: { id: "asc" } });

const onHand = async (variantId: string, locationId: string) =>
  (await db.stockLevel.findUnique({ where: { variantId_locationId: { variantId, locationId } } }))
    ?.onHandMilli ?? 0;

async function failure(promise: Promise<unknown>): Promise<ActionError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ActionError) return error;
    throw error;
  }
  throw new Error("expected an ActionError");
}

describe("purchasing", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  describe("suppliers", () => {
    it("creates, archives and deletes unused suppliers; refuses to delete used ones", async () => {
      const ctx = await setup();
      const { variant } = await createProduct();
      await db.$transaction((tx) => setSupplierActive(tx, ctx.supplierId, false, ctx.user));
      expect(
        (await db.supplier.findUniqueOrThrow({ where: { id: ctx.supplierId } })).isActive,
      ).toBe(false);
      await db.$transaction((tx) => setSupplierActive(tx, ctx.supplierId, true, ctx.user));
      await orderedPo(ctx, [{ variantId: variant.id, qty: 1, cost: 100n }]);
      expect(
        (await failure(db.$transaction((tx) => deleteSupplier(tx, ctx.supplierId, ctx.user)))).code,
      ).toBe("IN_USE");
      const other = await db.$transaction((tx) =>
        saveSupplier(tx, supplierInput("Other"), ctx.user),
      );
      await db.$transaction((tx) => deleteSupplier(tx, other.id, ctx.user));
      expect(await db.supplier.count()).toBe(1);
      expect(await db.auditLog.count({ where: { action: "supplier.delete" } })).toBe(1);
    });

    it("keeps supplier SKUs and costs per variant", async () => {
      const ctx = await setup();
      const { variant } = await createProduct();
      const item = {
        supplierId: ctx.supplierId,
        variantId: variant.id,
        supplierSku: "S-1",
        cost: fromMajor(500),
        isPreferred: true,
      };
      await db.$transaction((tx) => saveSupplierItem(tx, item, ctx.user));
      await db.$transaction((tx) => saveSupplierItem(tx, { ...item, cost: null }, ctx.user));
      const rows = await db.supplierItem.findMany();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ supplierSku: "S-1", cost: null, isPreferred: true });
      await db.$transaction((tx) => removeSupplierItem(tx, ctx.supplierId, variant.id, ctx.user));
      expect(await db.supplierItem.count()).toBe(0);
    });
  });

  describe("purchase orders", () => {
    it("numbers orders, edits only drafts and follows the lifecycle", async () => {
      const ctx = await setup();
      const { variant: a } = await createProduct();
      const { variant: b } = await createProduct();
      const po = await db.$transaction((tx) =>
        savePurchaseOrder(tx, poInput(ctx, [{ variantId: a.id, qty: 2, cost: 100n }]), ctx.user),
      );
      expect(po.number).toBe("PO-000001");

      // Draft edit replaces the lines and keeps the number.
      const edited = await db.$transaction((tx) =>
        savePurchaseOrder(
          tx,
          { ...poInput(ctx, [{ variantId: b.id, qty: 5, cost: 300n }]), id: po.id },
          ctx.user,
        ),
      );
      expect(edited.number).toBe(po.number);
      expect((await poLines(po.id)).map((l) => l.variantId)).toEqual([b.id]);

      // An empty order cannot be sent.
      const empty = await db.$transaction((tx) =>
        savePurchaseOrder(tx, poInput(ctx, []), ctx.user),
      );
      expect(
        (
          await failure(
            db.$transaction((tx) => transitionPurchaseOrder(tx, empty.id, "ORDERED", ctx.user)),
          )
        ).code,
      ).toBe("VALIDATION");

      await db.$transaction((tx) => transitionPurchaseOrder(tx, po.id, "ORDERED", ctx.user));
      const sent = await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
      expect(sent.status).toBe("ORDERED");
      expect(sent.orderedAt).not.toBeNull();

      const locked = await failure(
        db.$transaction((tx) =>
          savePurchaseOrder(
            tx,
            { ...poInput(ctx, [{ variantId: a.id, qty: 1, cost: 1n }]), id: po.id },
            ctx.user,
          ),
        ),
      );
      expect(locked.code).toBe("INVALID_STATE");

      await db.$transaction((tx) => transitionPurchaseOrder(tx, po.id, "CANCELLED", ctx.user));
      expect(
        (
          await failure(
            db.$transaction((tx) => transitionPurchaseOrder(tx, po.id, "ORDERED", ctx.user)),
          )
        ).code,
      ).toBe("INVALID_STATE");
      expect(
        (
          await failure(
            receive(ctx, {
              purchaseOrderId: po.id,
              lines: [
                {
                  purchaseOrderLineId: (await poLines(po.id))[0]!.id,
                  qtyMilli: 1000,
                  unitCost: 1n,
                },
              ],
            }),
          )
        ).code,
      ).toBe("INVALID_STATE");
    });

    it("rejects untracked products, fractional pieces and archived suppliers", async () => {
      const ctx = await setup();
      const { variant: service } = await createProduct({ type: "SERVICE", trackStock: false });
      const { variant: piece } = await createProduct();
      const bad = (lines: PurchaseOrderInput["lines"]) =>
        failure(
          db.$transaction((tx) => savePurchaseOrder(tx, { ...poInput(ctx, []), lines }, ctx.user)),
        );
      expect((await bad([{ variantId: service.id, qtyMilli: 1000, unitCost: 1n }])).code).toBe(
        "VALIDATION",
      );
      expect((await bad([{ variantId: piece.id, qtyMilli: 1500, unitCost: 1n }])).code).toBe(
        "VALIDATION",
      );
      await db.$transaction((tx) => setSupplierActive(tx, ctx.supplierId, false, ctx.user));
      expect((await bad([])).code).toBe("VALIDATION");
    });

    it("keeps users out of locations they are not assigned to", async () => {
      const ctx = await setup();
      const { location: elsewhere } = await createLocation();
      const scope = (id: string) => id === ctx.location.id;
      const code = await failure(
        db.$transaction((tx) =>
          savePurchaseOrder(
            tx,
            { ...poInput(ctx, []), locationId: elsewhere.id },
            ctx.user,
            {},
            scope,
          ),
        ),
      );
      expect(code.code).toBe("FORBIDDEN");
    });
  });

  describe("receiving", () => {
    it("receives partially, then completes; ledger, cost and last supplier cost follow", async () => {
      const ctx = await setup();
      const { variant } = await createProduct({ cost: 0n });
      const po = await orderedPo(ctx, [{ variantId: variant.id, qty: 10, cost: fromMajor(1000) }]);
      const [line] = await poLines(po.id);
      const lineInput = (qty: number, cost: bigint) => ({
        purchaseOrderId: po.id,
        note: null,
        lines: [{ purchaseOrderLineId: line!.id, qtyMilli: units(qty), unitCost: cost }],
      });

      const first = await receive(ctx, lineInput(4, fromMajor(1000)));
      expect(first.number).toBe("GR-000001");
      expect(first.orderStatus).toBe("PARTIALLY_RECEIVED");
      expect((await poLines(po.id))[0]!.qtyReceivedMilli).toBe(units(4));
      expect(await onHand(variant.id, ctx.location.id)).toBe(units(4));
      expect((await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).cost).toBe(
        fromMajor(1000),
      );

      // The supplier delivered the rest at a different price: moving average.
      const second = await receive(ctx, lineInput(6, fromMajor(2000)));
      expect(second.orderStatus).toBe("RECEIVED");
      // (4 x 1000 + 6 x 2000) / 10 = 1600
      expect((await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).cost).toBe(
        fromMajor(1600),
      );
      expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe(
        "RECEIVED",
      );
      expect(
        (
          await db.supplierItem.findUniqueOrThrow({
            where: { supplierId_variantId: { supplierId: ctx.supplierId, variantId: variant.id } },
          })
        ).cost,
      ).toBe(fromMajor(2000));

      const movements = await db.stockMovement.findMany({ orderBy: { seq: "asc" } });
      expect(
        movements.map((m) => [m.type, m.qtyDeltaMilli, m.unitCost, m.balanceAfterMilli]),
      ).toEqual([
        ["PURCHASE_RECEIPT", units(4), fromMajor(1000), units(4)],
        ["PURCHASE_RECEIPT", units(6), fromMajor(2000), units(10)],
      ]);
      expect(movements.map((m) => m.goodsReceiptId)).toEqual([first.id, second.id]);
      expect(await findLedgerMismatches(db)).toEqual([]);
      expect((await failure(receive(ctx, lineInput(1, 1n)))).code).toBe("INVALID_STATE");
    });

    it("refuses over-receipt unless the tolerance allows it, and rolls everything back", async () => {
      const ctx = await setup();
      const { variant } = await createProduct();
      const po = await orderedPo(ctx, [{ variantId: variant.id, qty: 10, cost: 100n }]);
      const [line] = await poLines(po.id);
      const input = (qty: number) => ({
        purchaseOrderId: po.id,
        note: null,
        lines: [{ purchaseOrderLineId: line!.id, qtyMilli: units(qty), unitCost: 100n }],
      });
      const refused = await failure(receive(ctx, input(11)));
      expect(refused.code).toBe("VALIDATION");
      expect(refused.fieldErrors).toEqual({ lines: ["overReceipt"] });
      expect(await db.goodsReceipt.count()).toBe(0);
      expect(await db.stockMovement.count()).toBe(0);
      // The refused receipt gave its number back (gap-free).
      const ok = await receive(ctx, input(11), { overReceiptBps: 1000 });
      expect(ok.number).toBe("GR-000001");
      expect(ok.orderStatus).toBe("RECEIVED");
      expect(await onHand(variant.id, ctx.location.id)).toBe(units(11));
    });

    it("receives ad hoc without an order, with and without a supplier", async () => {
      const ctx = await setup();
      const { variant } = await createProduct({ cost: fromMajor(100) });
      await db.$transaction((tx) =>
        // 10 on hand at cost 100 via an earlier receipt
        receiveGoods(
          tx,
          {
            locationId: ctx.location.id,
            lines: [{ variantId: variant.id, qtyMilli: units(10), unitCost: fromMajor(100) }],
          },
          ctx.user,
        ),
      );
      const second = await receive(ctx, {
        locationId: ctx.location.id,
        supplierId: ctx.supplierId,
        note: "walk-in",
        lines: [{ variantId: variant.id, qtyMilli: units(10), unitCost: fromMajor(200) }],
      });
      expect(second.orderStatus).toBeNull();
      expect((await db.productVariant.findUniqueOrThrow({ where: { id: variant.id } })).cost).toBe(
        fromMajor(150),
      );
      const receipts = await db.goodsReceipt.findMany({ orderBy: { number: "asc" } });
      expect(receipts.map((r) => [r.number, r.purchaseOrderId, r.supplierId])).toEqual([
        ["GR-000001", null, null],
        ["GR-000002", null, ctx.supplierId],
      ]);
      expect(await db.supplierItem.count()).toBe(1);
      expect(await findLedgerMismatches(db)).toEqual([]);
    });

    it("ignores typed costs for users who cannot see costs", async () => {
      const ctx = await setup();
      const { variant } = await createProduct({ cost: fromMajor(300) });
      const po = await orderedPo(ctx, [{ variantId: variant.id, qty: 2, cost: fromMajor(400) }]);
      const [line] = await poLines(po.id);
      await receive(
        ctx,
        {
          purchaseOrderId: po.id,
          note: null,
          lines: [{ purchaseOrderLineId: line!.id, qtyMilli: units(1), unitCost: 1n }],
        },
        { trustInputCost: false },
      );
      expect((await db.goodsReceiptLine.findFirstOrThrow()).unitCost).toBe(fromMajor(400));
      await receive(
        ctx,
        {
          locationId: ctx.location.id,
          lines: [{ variantId: variant.id, qtyMilli: units(1), unitCost: 1n }],
        },
        { trustInputCost: false },
      );
      expect(await db.goodsReceiptLine.count({ where: { unitCost: 1n } })).toBe(0);
    });

    it("rejects a PO line that belongs to another order and out-of-scope locations", async () => {
      const ctx = await setup();
      const { variant } = await createProduct();
      const po = await orderedPo(ctx, [{ variantId: variant.id, qty: 1, cost: 100n }]);
      const other = await orderedPo(ctx, [{ variantId: variant.id, qty: 1, cost: 100n }]);
      const [otherLine] = await poLines(other.id);
      const line = [{ purchaseOrderLineId: otherLine!.id, qtyMilli: units(1), unitCost: 100n }];
      expect((await failure(receive(ctx, { purchaseOrderId: po.id, lines: line }))).code).toBe(
        "NOT_FOUND",
      );
      const denied = await failure(
        receive(ctx, { purchaseOrderId: other.id, lines: line }, { scope: () => false }),
      );
      expect(denied.code).toBe("FORBIDDEN");
      expect(await db.goodsReceipt.count()).toBe(0);
    });

    it("serialises concurrent receipts: never over-receives, numbers are unique, ledger agrees", async () => {
      const ctx = await setup();
      const { variant } = await createProduct();
      const po = await orderedPo(ctx, [{ variantId: variant.id, qty: 10, cost: fromMajor(500) }]);
      const [line] = await poLines(po.id);
      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          receive(ctx, {
            purchaseOrderId: po.id,
            note: null,
            lines: [
              { purchaseOrderLineId: line!.id, qtyMilli: units(3), unitCost: fromMajor(500) },
            ],
          }),
        ),
      );
      const ok = attempts.filter((a) => a.status === "fulfilled");
      const refused = attempts.filter((a) => a.status === "rejected");
      expect(ok).toHaveLength(3); // 3 x 3 = 9 of 10; a fourth would exceed
      expect(refused).toHaveLength(3);
      for (const r of refused) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "VALIDATION" });
      }
      expect((await poLines(po.id))[0]!.qtyReceivedMilli).toBe(units(9));
      expect(await onHand(variant.id, ctx.location.id)).toBe(units(9));
      const numbers = (await db.goodsReceipt.findMany()).map((r) => r.number).sort();
      expect(numbers).toEqual(["GR-000001", "GR-000002", "GR-000003"]);
      expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe(
        "PARTIALLY_RECEIVED",
      );
      expect(await findLedgerMismatches(db)).toEqual([]);
    });

    it("handles concurrent ad-hoc receipts of the same variants in opposite line order", async () => {
      const ctx = await setup();
      const { variant: a } = await createProduct();
      const { variant: b } = await createProduct();
      const lines = (ids: string[]) =>
        ids.map((variantId) => ({ variantId, qtyMilli: units(1), unitCost: fromMajor(10) }));
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          receive(ctx, {
            locationId: ctx.location.id,
            supplierId: ctx.supplierId,
            lines: lines(i % 2 ? [a.id, b.id] : [b.id, a.id]),
          }),
        ),
      );
      expect(await onHand(a.id, ctx.location.id)).toBe(units(8));
      expect(await onHand(b.id, ctx.location.id)).toBe(units(8));
      expect(await findLedgerMismatches(db)).toEqual([]);
    });

    it("closing a partially received order short ends it", async () => {
      const ctx = await setup();
      const { variant } = await createProduct();
      const po = await orderedPo(ctx, [{ variantId: variant.id, qty: 5, cost: 100n }]);
      const [line] = await poLines(po.id);
      await receive(ctx, {
        purchaseOrderId: po.id,
        lines: [{ purchaseOrderLineId: line!.id, qtyMilli: units(2), unitCost: 100n }],
      });
      expect(
        (
          await failure(
            db.$transaction((tx) => transitionPurchaseOrder(tx, po.id, "CANCELLED", ctx.user)),
          )
        ).code,
      ).toBe("INVALID_STATE");
      await db.$transaction((tx) => transitionPurchaseOrder(tx, po.id, "RECEIVED", ctx.user));
      expect((await db.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe(
        "RECEIVED",
      );
    });
  });
});
