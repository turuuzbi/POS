import { describe, expect, it } from "vitest";
import { fromMajor } from "./money";
import {
  canReceive,
  canTransition,
  isEditable,
  lineTotal,
  maxReceivableMilli,
  orderTotal,
  outstandingMilli,
  purchaseOrderInputSchema,
  receiptInputSchema,
  statusAfterReceiving,
  supplierItemInputSchema,
} from "./purchasing";
import { units } from "./qty";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("status transitions", () => {
  it("allows the documented forward moves only", () => {
    expect(canTransition("DRAFT", "ORDERED")).toBe(true);
    expect(canTransition("DRAFT", "CANCELLED")).toBe(true);
    expect(canTransition("DRAFT", "RECEIVED")).toBe(false);
    expect(canTransition("ORDERED", "PARTIALLY_RECEIVED")).toBe(true);
    expect(canTransition("ORDERED", "CANCELLED")).toBe(true);
    expect(canTransition("PARTIALLY_RECEIVED", "RECEIVED")).toBe(true);
    expect(canTransition("PARTIALLY_RECEIVED", "CANCELLED")).toBe(false);
    expect(canTransition("RECEIVED", "ORDERED")).toBe(false);
    expect(canTransition("CANCELLED", "DRAFT")).toBe(false);
  });

  it("edits only drafts and receives only open orders", () => {
    expect(isEditable("DRAFT")).toBe(true);
    expect(isEditable("ORDERED")).toBe(false);
    expect(canReceive("ORDERED")).toBe(true);
    expect(canReceive("PARTIALLY_RECEIVED")).toBe(true);
    expect(canReceive("DRAFT")).toBe(false);
    expect(canReceive("RECEIVED")).toBe(false);
    expect(canReceive("CANCELLED")).toBe(false);
  });
});

describe("receiving math", () => {
  const line = { qtyOrderedMilli: units(10), qtyReceivedMilli: units(4) };

  it("computes what is outstanding and receivable", () => {
    expect(outstandingMilli(line)).toBe(units(6));
    expect(maxReceivableMilli(line, 0)).toBe(units(6));
    expect(maxReceivableMilli(line, 1000)).toBe(units(7));
    expect(maxReceivableMilli({ ...line, qtyReceivedMilli: units(12) }, 0)).toBe(0);
  });

  it("derives the status from the lines", () => {
    const o = units(5);
    expect(statusAfterReceiving([{ qtyOrderedMilli: o, qtyReceivedMilli: 0 }])).toBe("ORDERED");
    expect(
      statusAfterReceiving([
        { qtyOrderedMilli: o, qtyReceivedMilli: o },
        { qtyOrderedMilli: o, qtyReceivedMilli: 1000 },
      ]),
    ).toBe("PARTIALLY_RECEIVED");
    expect(
      statusAfterReceiving([
        { qtyOrderedMilli: o, qtyReceivedMilli: o },
        { qtyOrderedMilli: o, qtyReceivedMilli: o + 1000 },
      ]),
    ).toBe("RECEIVED");
  });

  it("totals with a single rounding per line", () => {
    expect(lineTotal(fromMajor(1000), 1500)).toBe(fromMajor(1500));
    // 0.333 kg at 1,000.01 = 333.00333 -> 333.00
    expect(lineTotal(100_001n, 333)).toBe(33_300n);
    expect(
      orderTotal([
        { unitCost: fromMajor(100), qtyMilli: units(3) },
        { unitCost: fromMajor(250), qtyMilli: units(2) },
      ]),
    ).toBe(fromMajor(800));
  });
});

describe("input schemas", () => {
  const base = { supplierId: id(1), locationId: id(2), lines: [] as unknown[] };

  it("parses typed costs to mongo and rejects duplicate variants", () => {
    const ok = purchaseOrderInputSchema.parse({
      ...base,
      lines: [{ variantId: id(3), qtyMilli: 2000, unitCost: "12,500.50" }],
    });
    expect(ok.lines[0]!.unitCost).toBe(1_250_050n);
    const dup = purchaseOrderInputSchema.safeParse({
      ...base,
      lines: [
        { variantId: id(3), qtyMilli: 1000, unitCost: "1" },
        { variantId: id(3), qtyMilli: 1000, unitCost: "1" },
      ],
    });
    expect(dup.success).toBe(false);
  });

  it("rejects bad quantities and costs", () => {
    for (const line of [
      { variantId: id(3), qtyMilli: 0, unitCost: "1" },
      { variantId: id(3), qtyMilli: 1.5, unitCost: "1" },
      { variantId: id(3), qtyMilli: 1000, unitCost: "-1" },
      { variantId: id(3), qtyMilli: 1000, unitCost: "abc" },
    ]) {
      expect(purchaseOrderInputSchema.safeParse({ ...base, lines: [line] }).success).toBe(false);
    }
  });

  it("requires PO line ids against a PO, and variant + location when ad hoc", () => {
    const line = { qtyMilli: 1000, unitCost: "5" };
    expect(
      receiptInputSchema.safeParse({
        purchaseOrderId: id(1),
        lines: [{ ...line, variantId: id(2) }],
      }).success,
    ).toBe(false);
    expect(
      receiptInputSchema.safeParse({
        purchaseOrderId: id(1),
        lines: [{ ...line, purchaseOrderLineId: id(2) }],
      }).success,
    ).toBe(true);
    expect(
      receiptInputSchema.safeParse({ locationId: id(9), lines: [{ ...line, variantId: id(2) }] })
        .success,
    ).toBe(true);
    expect(receiptInputSchema.safeParse({ lines: [{ ...line, variantId: id(2) }] }).success).toBe(
      false,
    );
  });

  it("supplier item cost is optional", () => {
    const blank = supplierItemInputSchema.parse({ supplierId: id(1), variantId: id(2), cost: "" });
    expect(blank.cost).toBeNull();
    const set = supplierItemInputSchema.parse({ supplierId: id(1), variantId: id(2), cost: "50" });
    expect(set.cost).toBe(5000n);
  });
});
