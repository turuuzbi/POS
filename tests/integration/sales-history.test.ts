import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parseSalesFilter } from "@/domain/sales-filter";
import {
  getSaleDetail,
  getSalesFilterOptions,
  iterateSales,
  listSales,
  type SaleListRow,
} from "@/server/queries/sales";
import { db, resetDatabase } from "../support/db";
import { createUser } from "../support/fixtures";
import { createReceiptRefund } from "../support/sales-refund-fixtures";
import { createReceiptContext, createReceiptSale } from "../support/receipt-fixtures";

const ALL = { locationIds: "ALL" as const };
const filterOf = (params: Record<string, string>) => parseSalesFilter(params);
const numbers = (rows: SaleListRow[]) => rows.map((r) => r.number).sort();

const ONE_LINE = [
  { name: "Цай", qtyMilli: 1000, unitPrice: 100_000n, total: 100_000n, vat: 9_091n },
];
const TWO_LINES = [
  { name: "Сүү", qtyMilli: 1000, unitPrice: 60_000n, total: 60_000n, vat: 5_455n },
  { name: "Талх", qtyMilli: 1000, unitPrice: 40_000n, total: 40_000n, vat: 3_636n },
];

describe("sales history", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  async function seed() {
    const context = await createReceiptContext({ locationName: "Төв" });
    const make = (number: string, options: Parameters<typeof createReceiptSale>[0] = {}) =>
      createReceiptSale({
        context,
        number,
        lines: ONE_LINE,
        payments: [{ method: "CASH", amount: 100_000n, tendered: 100_000n }],
        roundingAmount: 0n,
        ...options,
      });
    const completed = await make("A-COMPLETED");
    const voided = await make("A-VOIDED", { voided: true });
    const partial = await make("A-PARTIAL", {
      lines: TWO_LINES,
      payments: [{ method: "QPAY", amount: 100_000n }],
    });
    await createReceiptRefund(
      { ...partial, context },
      { lines: [{ lineNo: 1, qtyMilli: 1000, total: 60_000n, vat: 5_455n }] },
    );
    const full = await make("A-FULL", { lines: TWO_LINES });
    await createReceiptRefund(
      { ...full, context },
      { lines: [{ lineNo: 1, qtyMilli: 1000, total: 60_000n, vat: 5_455n }] },
    );
    await createReceiptRefund(
      { ...full, context },
      { lines: [{ lineNo: 2, qtyMilli: 1000, total: 40_000n, vat: 3_636n }] },
    );
    return { context, completed, voided, partial, full };
  }

  it("derives each sale's status from voids and refunds", async () => {
    await seed();
    const { rows } = await listSales(ALL, filterOf({}));
    const status = Object.fromEntries(rows.map((r) => [r.number, r.status]));
    expect(status).toEqual({
      "A-COMPLETED": "COMPLETED",
      "A-VOIDED": "VOIDED",
      "A-PARTIAL": "PARTIALLY_REFUNDED",
      "A-FULL": "REFUNDED",
    });
    const partial = rows.find((r) => r.number === "A-PARTIAL")!;
    expect(partial.refundedAmount).toBe(60_000n);
    expect(partial.refundCount).toBe(1);
  });

  it.each([
    ["COMPLETED", ["A-COMPLETED"]],
    ["VOIDED", ["A-VOIDED"]],
    ["REFUNDED", ["A-FULL"]],
    ["PARTIALLY_REFUNDED", ["A-PARTIAL"]],
  ])("filters by status %s", async (status, expected) => {
    await seed();
    const { rows, total } = await listSales(ALL, filterOf({ status }));
    expect(numbers(rows)).toEqual(expected);
    expect(total).toBe(expected.length);
  });

  it("totals: voided sales are not sales, refunds net off", async () => {
    await seed();
    const { totals } = await listSales(ALL, filterOf({}));
    expect(totals).toEqual({
      count: 4,
      gross: 300_000n, // completed + partial + full (voided excluded)
      voided: 100_000n,
      refunded: 160_000n, // 60 000 + 60 000 + 40 000
      net: 140_000n,
    });
  });

  it("filters by payment method, receipt number (literally) and amount range", async () => {
    const { context } = await seed();
    await createReceiptSale({
      context,
      number: "X%_100",
      lines: [{ name: "Том", qtyMilli: 1000, unitPrice: 900_000n, total: 900_000n, vat: 81_818n }],
      payments: [{ method: "CARD", amount: 900_000n }],
      roundingAmount: 0n,
    });
    expect(numbers((await listSales(ALL, filterOf({ method: "QPAY" }))).rows)).toEqual([
      "A-PARTIAL",
    ]);
    expect(numbers((await listSales(ALL, filterOf({ method: "CARD" }))).rows)).toEqual(["X%_100"]);
    // `%` and `_` are matched literally, not as wildcards.
    expect(numbers((await listSales(ALL, filterOf({ q: "%" }))).rows)).toEqual(["X%_100"]);
    expect(numbers((await listSales(ALL, filterOf({ q: "x%_" }))).rows)).toEqual(["X%_100"]);
    expect((await listSales(ALL, filterOf({ q: "a_c" }))).rows).toHaveLength(0);
    expect(numbers((await listSales(ALL, filterOf({ q: "partial" }))).rows)).toEqual(["A-PARTIAL"]);
    // 100 000 möngö = 1 000 ₮; 9 000 ₮ = 900 000
    expect(numbers((await listSales(ALL, filterOf({ min: "5000" }))).rows)).toEqual(["X%_100"]);
    expect((await listSales(ALL, filterOf({ max: "999.99" }))).rows).toHaveLength(0);
    expect((await listSales(ALL, filterOf({ min: "1000", max: "1000" }))).rows).toHaveLength(4);
  });

  it("filters by Ulaanbaatar calendar day, inclusive of the end day", async () => {
    const context = await createReceiptContext();
    const make = (number: string, at: string) =>
      createReceiptSale({ context, number, lines: ONE_LINE, occurredAt: new Date(at) });
    await make("D-1400", "2026-10-14T10:00:00Z"); // 18:00 on the 14th, local
    await make("D-1500", "2026-10-14T17:30:00Z"); // 01:30 on the 15th, local
    await make("D-1599", "2026-10-15T15:59:59Z"); // 23:59:59 on the 15th, local
    await make("D-1600", "2026-10-15T16:00:00Z"); // 00:00 on the 16th, local
    const on = async (from: string, to: string) =>
      numbers((await listSales(ALL, filterOf({ from, to }))).rows);
    expect(await on("2026-10-14", "2026-10-14")).toEqual(["D-1400"]);
    expect(await on("2026-10-15", "2026-10-15")).toEqual(["D-1500", "D-1599"]);
    expect(await on("2026-10-14", "2026-10-16")).toHaveLength(4);
    expect(numbers((await listSales(ALL, filterOf({ from: "2026-10-16" }))).rows)).toEqual([
      "D-1600",
    ]);
  });

  it("filters by location, register and cashier, and scopes to the user's locations", async () => {
    const a = await createReceiptContext({ locationName: "A" });
    const b = await createReceiptContext({ locationName: "B" });
    await createReceiptSale({ context: a, number: "LOC-A", lines: ONE_LINE, roundingAmount: 0n });
    await createReceiptSale({ context: b, number: "LOC-B", lines: ONE_LINE, roundingAmount: 0n });

    expect(numbers((await listSales(ALL, filterOf({}))).rows)).toEqual(["LOC-A", "LOC-B"]);
    expect(numbers((await listSales(ALL, filterOf({ location: b.locationId }))).rows)).toEqual([
      "LOC-B",
    ]);
    expect(numbers((await listSales(ALL, filterOf({ register: a.registerId }))).rows)).toEqual([
      "LOC-A",
    ]);
    expect(numbers((await listSales(ALL, filterOf({ cashier: b.cashierId }))).rows)).toEqual([
      "LOC-B",
    ]);

    // Scoped to A: B's sales vanish from rows, counts and totals, even when asked for by id.
    const scopeA = { locationIds: [a.locationId] };
    const scoped = await listSales(scopeA, filterOf({}));
    expect(numbers(scoped.rows)).toEqual(["LOC-A"]);
    expect(scoped.total).toBe(1);
    expect(scoped.totals.gross).toBe(100_000n);
    const asked = await listSales(scopeA, filterOf({ location: b.locationId }));
    expect(asked.rows).toHaveLength(0);
    expect(asked.totals.count).toBe(0);
    // No locations at all means nothing.
    expect((await listSales({ locationIds: [] }, filterOf({}))).rows).toHaveLength(0);
    // Filter options are scoped too.
    const options = await getSalesFilterOptions(scopeA);
    expect(options.locations.map((l) => l.id)).toEqual([a.locationId]);
    expect(options.registers.map((r) => r.id)).toEqual([a.registerId]);
  });

  it("pages newest first and exports every row exactly once in keyset batches", async () => {
    const context = await createReceiptContext();
    for (let i = 0; i < 27; i++) {
      await createReceiptSale({
        context,
        number: `P-${String(i).padStart(2, "0")}`,
        lines: ONE_LINE,
        // Two sales share a timestamp to exercise the id tiebreak.
        occurredAt: new Date(Date.UTC(2026, 9, 10, 0, i - (i % 9 === 8 ? 1 : 0))),
      });
    }
    const first = await listSales(ALL, filterOf({}));
    expect(first.total).toBe(27);
    expect(first.pages).toBe(2);
    expect(first.rows).toHaveLength(25);
    const second = await listSales(ALL, filterOf({ page: "2" }));
    expect(second.rows).toHaveLength(2);
    const paged = [...first.rows, ...second.rows].map((r) => r.number);
    expect(new Set(paged).size).toBe(27);
    expect(
      [...first.rows, ...second.rows].every(
        (r, i, all) => i === 0 || all[i - 1]!.occurredAt >= r.occurredAt,
      ),
    ).toBe(true);
    // A page beyond the end clamps to the last one.
    expect((await listSales(ALL, filterOf({ page: "99" }))).page).toBe(2);

    const exported: string[] = [];
    for await (const batch of iterateSales(ALL, filterOf({}), 4)) {
      exported.push(...batch.map((r) => r.number));
    }
    expect(exported).toEqual(paged);
  });

  describe("detail", () => {
    it("returns lines, payments, taxes, approvals, refunds and the audit trail", async () => {
      const context = await createReceiptContext();
      const manager = await createUser({ role: "MANAGER", locationIds: [context.locationId] });
      const sale = await createReceiptSale({
        context,
        number: "DET-1",
        lines: [{ ...TWO_LINES[0]!, discount: 1_000n }, TWO_LINES[1]!],
        payments: [
          { method: "CARD", amount: 50_000n, cardBrand: "VISA", cardLast4: "4242" },
          { method: "CASH", amount: 50_000n, tendered: 60_000n, change: 10_000n },
        ],
        roundingAmount: 0n,
      });
      const refund = await createReceiptRefund(
        { ...sale, context },
        {
          lines: [{ lineNo: 2, qtyMilli: 1000, total: 40_000n, vat: 3_636n }],
          approvedById: manager.id,
          reason: "CHANGED_MIND",
        },
      );
      await db.auditLog.create({
        data: {
          actorId: context.cashierId,
          action: "refund.create",
          entityType: "Refund",
          entityId: refund.id,
        },
      });

      const detail = await getSaleDetail(ALL, sale.id);
      expect(detail).not.toBeNull();
      expect(detail!.status).toBe("PARTIALLY_REFUNDED");
      expect(detail!.refundedAmount).toBe(40_000n);
      expect(detail!.sale.lines.map((l) => l.name)).toEqual(["Сүү", "Талх"]);
      expect(detail!.sale.payments.map((p) => p.method)).toEqual(["CARD", "CASH"]);
      expect(detail!.sale.payments[0]).toMatchObject({ cardBrand: "VISA", cardLast4: "4242" });
      expect(detail!.sale.refunds).toHaveLength(1);
      expect(detail!.sale.refunds[0]).toMatchObject({
        totalAmount: 40_000n,
        reason: "CHANGED_MIND",
        approvedBy: { name: manager.name },
        processedBy: { name: context.cashierName },
      });
      expect(detail!.taxRows.reduce((s, r) => s + r.vat, 0n)).toBe(9_091n);
      expect(detail!.approvals).toEqual([
        { kind: "refund", approverName: manager.name, ref: detail!.sale.refunds[0]!.number },
      ]);
      expect(detail!.audit.map((a) => a.action)).toEqual(["refund.create"]);
      expect(detail!.audit[0]!.actorName).toBe(context.cashierName);
      // No cost data on the detail model.
      expect(
        JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      ).not.toContain("unitCost");
    });

    it("includes void approvals and a voided status", async () => {
      const context = await createReceiptContext();
      const manager = await createUser({ role: "MANAGER", locationIds: [context.locationId] });
      const sale = await createReceiptSale({
        context,
        lines: ONE_LINE,
        voided: true,
        voidApprovedById: manager.id,
      });
      const detail = await getSaleDetail(ALL, sale.id);
      expect(detail!.status).toBe("VOIDED");
      expect(detail!.sale.void?.voidedBy.name).toBe(context.cashierName);
      expect(detail!.approvals).toEqual([{ kind: "void", approverName: manager.name, ref: null }]);
    });

    it("hides sales outside the user's locations and rejects junk ids", async () => {
      const a = await createReceiptContext();
      const b = await createReceiptContext();
      const inB = await createReceiptSale({ context: b, lines: ONE_LINE });
      expect(await getSaleDetail({ locationIds: [a.locationId] }, inB.id)).toBeNull();
      expect(await getSaleDetail({ locationIds: [b.locationId] }, inB.id)).not.toBeNull();
      expect(await getSaleDetail(ALL, "not-a-uuid")).toBeNull();
      expect(await getSaleDetail(ALL, "00000000-0000-4000-8000-000000000000")).toBeNull();
    });
  });
});
