import { v7 as uuidv7 } from "uuid";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildZReport, reportToJson } from "@/domain/report";
import {
  cashMovementApprovalScope,
  cashMovementInputSchema,
  closeShiftInputSchema,
  shiftApprovalKeys,
} from "@/domain/shift-contract";
import { shiftCodeFromFailure } from "@/domain/shift-failure";
import { signApproval } from "@/server/auth/approval";
import { checkoutSale, type CheckoutFailure } from "@/server/services/checkout";
import { loadExpectedCash, loadShiftReportInput } from "@/server/services/shift-report";
import {
  closeShift,
  MAX_FAILED_CLOSE_ATTEMPTS,
  recordCashMovement,
  ShiftFailure,
} from "@/server/services/shifts";
import { getShiftDetail, listShifts } from "@/server/queries/shifts";
import { db, resetDatabase } from "../support/db";
import {
  buildInput,
  createStockedProduct,
  createTill,
  lineOf,
  type Till,
} from "../support/checkout-fixtures";
import { createLocation, createUser, pairDevice } from "../support/fixtures";

const meta = { ip: null, userAgent: null };

/** Whole tögrög to möngö. */
const mnt = (major: number) => BigInt(major) * 100n;

async function cashSale(till: Till, variantId: string, amount = "100000") {
  const input = buildInput({
    lines: [lineOf(variantId)],
    expectedPayable: amount,
    tenders: [{ method: "CASH", amount }],
  });
  await checkoutSale(input, till.ctx());
  return input.saleId;
}

const closeInput = (shiftId: string, denominations: Record<string, number>, note?: string) =>
  closeShiftInputSchema.parse({ shiftId, denominations, ...(note ? { note } : {}) });

const movementInput = (
  overrides: Partial<{
    movementId: string;
    type: "CASH_IN" | "CASH_OUT";
    amount: string;
    reason: string;
    approvals: Record<string, string>;
  }> = {},
) =>
  cashMovementInputSchema.parse({
    movementId: uuidv7(),
    type: "CASH_IN",
    amount: "100000",
    reason: "change from the safe",
    approvals: {},
    createdAtClient: new Date().toISOString(),
    ...overrides,
  });

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ShiftFailure);
    return (error as ShiftFailure).failure;
  }
  throw new Error("expected a ShiftFailure");
}

function token(till: Till, input: ReturnType<typeof movementInput>, key: "movement" | "overdraw") {
  const k = shiftApprovalKeys[key];
  return signApproval({
    approverId: till.manager.id,
    permission: "pos.cash_movement",
    scope: cashMovementApprovalScope(input.movementId, k, input),
    deviceId: till.device.id,
  });
}

// Float 5 000 000 möngö = 50 000 ₮.
// One cash sale of 100 000 möngö (1 000 ₮) → expected 51 000 ₮.
const EXACT_51000 = { "20000": 2, "10000": 1, "1000": 1 };

describe("closeShift", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  async function tillWithSale() {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    await cashSale(till, variant.id);
    return { till, variant };
  }

  it("closes with an exact count, freezes the Z report and matches a recomputation", async () => {
    const { till } = await tillWithSale();
    const { user, device } = till.ctx();
    const result = await closeShift(closeInput(till.shift!.id, EXACT_51000), user, device, meta);
    expect(result).toMatchObject({
      zReportNumber: 1,
      expectedCash: mnt(51_000),
      countedCash: mnt(51_000),
      cashVariance: 0n,
      classification: "OK",
    });

    const shift = await db.shift.findUniqueOrThrow({ where: { id: till.shift!.id } });
    expect(shift).toMatchObject({
      status: "CLOSED",
      closedById: till.cashier.id,
      expectedCash: mnt(51_000),
      countedCash: mnt(51_000),
      cashVariance: 0n,
    });
    expect(shift.closedAt).not.toBeNull();
    expect(shift.denominations).toMatchObject(EXACT_51000);

    const z = await db.zReport.findUniqueOrThrow({ where: { shiftId: shift.id } });
    expect(z).toMatchObject({ number: 1, registerId: till.register.id });
    // Recomputing the report from the rows gives exactly the frozen JSON.
    const recomputed = buildZReport(await loadShiftReportInput(db, shift.id, shift.closedAt!), {
      closedAt: shift.closedAt!,
      countedCash: mnt(51_000),
      denominations: { ...EXACT_51000, "5000": 0, "500": 0, "100": 0, "50": 0, "20": 0, "10": 0 },
    });
    expect(z.data).toEqual(reportToJson(recomputed));
    expect(recomputed.saleCount).toBe(1);
    expect(recomputed.cash.expected).toBe((await loadExpectedCash(db, shift.id)).expected);

    expect(await db.auditLog.count({ where: { action: "shift.close", entityId: shift.id } })).toBe(
      1,
    );
  });

  it("numbers Z reports per register", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    await closeShift(closeInput(till.shift!.id, { "20000": 2, "10000": 1 }), user, device, meta);
    const second = await db.shift.create({
      data: {
        registerId: till.register.id,
        locationId: till.location.id,
        openedById: till.cashier.id,
        openingFloat: 0n,
      },
    });
    const result = await closeShift(closeInput(second.id, {}), user, device, meta);
    expect(result.zReportNumber).toBe(2);
  });

  it("requires a note beyond the variance threshold, then records the shortage", async () => {
    const { till } = await tillWithSale();
    const { user, device } = till.ctx();
    const short = { "20000": 2, "5000": 1, "1000": 4 }; // 49 000 ₮, 2 000 ₮ short
    const missing = await failure(
      closeShift(closeInput(till.shift!.id, short), user, device, meta),
    );
    expect(missing).toBe("VARIANCE_NOTE_REQUIRED");
    expect((await db.shift.findUniqueOrThrow({ where: { id: till.shift!.id } })).status).toBe(
      "OPEN",
    );

    const result = await closeShift(
      closeInput(till.shift!.id, short, "drawer short after the safe drop"),
      user,
      device,
      meta,
    );
    expect(result).toMatchObject({ cashVariance: -mnt(2000), classification: "SHORT" });
    const stored = await db.shift.findUniqueOrThrow({ where: { id: till.shift!.id } });
    expect(stored.closingNote).toBe("drawer short after the safe drop");
    const z = await db.zReport.findUniqueOrThrow({ where: { shiftId: till.shift!.id } });
    expect((z.data as { closing: { cashVariance: string } }).closing.cashVariance).toBe("-200000");
  });

  it("needs no note within the threshold and records an overage", async () => {
    const { till } = await tillWithSale();
    const { user, device } = till.ctx();
    const result = await closeShift(
      closeInput(till.shift!.id, { ...EXACT_51000, "500": 1 }),
      user,
      device,
      meta,
    );
    expect(result).toMatchObject({ cashVariance: mnt(500), classification: "OVER" });
  });

  it("rejects an invalid breakdown and leaves the shift open", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    expect(
      await failure(closeShift(closeInput(till.shift!.id, { "7": 3 }), user, device, meta)),
    ).toBe("DENOMINATIONS_INVALID");
    expect((await db.shift.findUniqueOrThrow({ where: { id: till.shift!.id } })).status).toBe(
      "OPEN",
    );
  });

  it("is idempotent: closing again returns the stored result, other content conflicts", async () => {
    const { till } = await tillWithSale();
    const { user, device } = till.ctx();
    const first = await closeShift(closeInput(till.shift!.id, EXACT_51000), user, device, meta);
    const again = await closeShift(closeInput(till.shift!.id, EXACT_51000), user, device, meta);
    expect(again).toEqual(first);
    expect(await db.zReport.count()).toBe(1);
    expect(await db.auditLog.count({ where: { action: "shift.close" } })).toBe(1);
    expect(
      await failure(closeShift(closeInput(till.shift!.id, { "20000": 1 }), user, device, meta)),
    ).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("lets exactly one of several concurrent closes win and the rest replay it", async () => {
    const { till } = await tillWithSale();
    const { user, device } = till.ctx();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        closeShift(closeInput(till.shift!.id, EXACT_51000), user, device, meta),
      ),
    );
    expect(new Set(results.map((r) => r.zReportNumber))).toEqual(new Set([1]));
    expect(await db.zReport.count()).toBe(1);
  });

  it("refuses a sale after the close and counts a racing sale on exactly one side", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    const { user, device } = till.ctx();
    const sales = Array.from({ length: 6 }, () =>
      cashSale(till, variant.id).then(
        () => "sold" as const,
        (error: unknown) => (error as CheckoutFailure).failure,
      ),
    );
    // Count 50 000 ₮ so the close succeeds whatever number of sales made it in: the
    // variance only matters for the note, which we always send.
    const closing = closeShift(
      closeInput(till.shift!.id, { "20000": 2, "10000": 1 }, "racing sales"),
      user,
      device,
      meta,
    );
    const [outcomes, closed] = await Promise.all([Promise.all(sales), closing]);

    const committed = await db.sale.count({ where: { shiftId: till.shift!.id } });
    expect(outcomes.filter((o) => o === "sold")).toHaveLength(committed);
    for (const outcome of outcomes) expect(["sold", "SHIFT_REQUIRED"]).toContain(outcome);
    // Every committed sale is in the frozen report, and expected cash covers all of them.
    const z = await db.zReport.findUniqueOrThrow({ where: { shiftId: till.shift!.id } });
    expect((z.data as { saleCount: number }).saleCount).toBe(committed);
    expect(closed.expectedCash).toBe(mnt(50_000) + BigInt(committed) * 100_000n);

    // After the close, selling is refused.
    expect(await cashSale(till, variant.id).catch((e: CheckoutFailure) => e.failure)).toBe(
      "SHIFT_REQUIRED",
    );
  });

  it("enforces permission, location and register scoping", async () => {
    const { till } = await tillWithSale();
    const { device } = till.ctx();
    const other = await createLocation();
    const stranger = await createUser({ role: "CASHIER", locationIds: [other.location.id] });
    expect(
      await failure(
        closeShift(
          closeInput(till.shift!.id, EXACT_51000),
          { id: stranger.id, role: "CASHIER", locationIds: [other.location.id] },
          device,
          meta,
        ),
      ),
    ).toBe("PERMISSION_DENIED");

    // Another register's device cannot close this shift: it looks missing.
    const manager = await createUser({ role: "MANAGER", locationIds: [other.location.id] });
    const otherDevice = await pairDevice(other.location.id, manager.id, other.register.id);
    expect(
      await failure(
        closeShift(
          closeInput(till.shift!.id, EXACT_51000),
          { id: manager.id, role: "MANAGER", locationIds: [other.location.id] },
          {
            deviceId: otherDevice.device.id,
            locationId: other.location.id,
            registerId: other.register.id,
          },
          meta,
        ),
      ),
    ).toBe("SHIFT_NOT_FOUND");
    expect((await db.shift.findUniqueOrThrow({ where: { id: till.shift!.id } })).status).toBe(
      "OPEN",
    );
  });

  it("carries the failure code through the action envelope", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    try {
      await closeShift(closeInput(till.shift!.id, { "20000": 1 }), user, device, meta);
      throw new Error("expected a failure");
    } catch (error) {
      const e = error as ShiftFailure;
      expect(shiftCodeFromFailure({ fieldErrors: e.fieldErrors })?.code).toBe(
        "VARIANCE_NOTE_REQUIRED",
      );
    }
  });
});

describe("blind close and the close clock", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("refuses a cashier after 5 failed closes; a manager can still close", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    for (let i = 0; i < MAX_FAILED_CLOSE_ATTEMPTS; i++) {
      expect(
        await failure(closeShift(closeInput(till.shift!.id, { "20000": 1 }), user, device, meta)),
      ).toBe("VARIANCE_NOTE_REQUIRED");
    }
    // Even a count that would pass is refused now: the cashier has had their tries.
    expect(
      await failure(
        closeShift(closeInput(till.shift!.id, { "20000": 1 }, "n"), user, device, meta),
      ),
    ).toBe("CLOSE_ATTEMPTS_EXCEEDED");
    expect(await db.shift.count({ where: { status: "OPEN" } })).toBe(1);
    const manager = till.ctx(till.manager);
    const closed = await closeShift(
      closeInput(till.shift!.id, { "20000": 1 }, "manager count"),
      manager.user,
      manager.device,
      meta,
    );
    expect(closed.classification).toBe("SHORT");
  });

  it("hides the expected cash and its components from a cashier's view of the open shift", async () => {
    const till = await createTill();
    const { variant } = await createStockedProduct(till, { price: 100_000n });
    await cashSale(till, variant.id);
    const manager = till.ctx(till.manager);
    await recordCashMovement(
      movementInput({ amount: "200000", reason: "float top-up" }),
      manager.user,
      manager.device,
      meta,
    );
    const asCashier = {
      id: till.cashier.id,
      role: "CASHIER" as const,
      locationIds: [till.location.id],
    };
    const blind = await getShiftDetail(
      { user: asCashier, registerId: till.register.id },
      till.shift!.id,
    );
    expect(blind).toMatchObject({ blind: true, movements: [] });
    expect(blind!.report.cash).toEqual({
      openingFloat: 0n,
      cashSales: 0n,
      cashRefunds: 0n,
      cashIn: 0n,
      cashOut: 0n,
      changeGiven: 0n,
      expected: 0n,
    });
    expect(blind!.shift).toMatchObject({
      openingFloat: 0n,
      expectedCash: null,
      cashVariance: null,
    });
    // Sales and tenders stay.
    expect(blind!.report.saleCount).toBe(1);
    expect(blind!.report.tenders.find((t) => t.method === "CASH")?.net).toBe(100_000n);
    const wire = JSON.stringify(reportToJson(blind as never));
    expect(wire).not.toContain("5100000"); // float + sale
    expect(wire).not.toContain("5300000"); // + the pay-in
    expect(wire).not.toContain("5000000"); // the float

    const open = await getShiftDetail({ user: manager.user }, till.shift!.id);
    expect(open).toMatchObject({ blind: false });
    expect(open!.report.cash.expected).toBe(5_300_000n);
    // The cash-movement result carries the drawer total for managers only.
    const cashierCtx = till.ctx();
    const input = movementInput({ amount: "100000", reason: "change" });
    const asApproved = movementInput({
      movementId: input.movementId,
      amount: "100000",
      reason: "change",
      approvals: { [shiftApprovalKeys.movement]: token(till, input, "movement") },
    });
    const result = await recordCashMovement(asApproved, cashierCtx.user, cashierCtx.device, meta);
    expect(result.expectedCashAfter).toBeNull();
    const replay = await recordCashMovement(asApproved, cashierCtx.user, cashierCtx.device, meta);
    expect(replay.expectedCashAfter).toBeNull();
    const byManager = await recordCashMovement(movementInput(), manager.user, manager.device, meta);
    expect(byManager.expectedCashAfter).toBe(5_500_000n);
    // After the close the Z report is open to the cashier again.
    await closeShift(closeInput(till.shift!.id, {}, "closed"), manager.user, manager.device, meta);
    const z = await getShiftDetail(
      { user: asCashier, registerId: till.register.id },
      till.shift!.id,
    );
    expect(z).toMatchObject({ blind: false });
    expect(z!.report.cash.expected).toBe(5_500_000n);
  });

  it("stamps closedAt after the shift row lock, never before a sale it includes", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    const id = till.shift!.id;
    let release = 0;
    const holder = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Shift" WHERE "id" = ${id}::uuid FOR SHARE`;
        await new Promise((r) => setTimeout(r, 500));
        release = Date.now();
      },
      { timeout: 10_000 },
    );
    await new Promise((r) => setTimeout(r, 150));
    const closing = closeShift(closeInput(id, { "20000": 1 }, "note"), user, device, meta);
    await holder;
    await closing;
    const shift = await db.shift.findUniqueOrThrow({ where: { id } });
    expect(shift.closedAt!.getTime()).toBeGreaterThanOrEqual(release);
    const z = await db.zReport.findFirstOrThrow({ where: { shiftId: id } });
    expect((z.data as { closing: { closedAt: string } }).closing.closedAt).toBe(
      shift.closedAt!.toISOString(),
    );
  });
});

describe("recordCashMovement", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("lets a manager pay in and out; expected cash follows and the close counts it", async () => {
    const till = await createTill();
    const { user, device } = till.ctx(till.manager);
    const paidIn = await recordCashMovement(
      movementInput({ amount: "200000", reason: "float top-up" }),
      user,
      device,
      meta,
    );
    expect(paidIn).toMatchObject({
      type: "CASH_IN",
      expectedCashAfter: 5_200_000n,
      replayed: false,
    });
    const paidOut = await recordCashMovement(
      movementInput({ type: "CASH_OUT", amount: "50000", reason: "courier" }),
      user,
      device,
      meta,
    );
    expect(paidOut.expectedCashAfter).toBe(5_150_000n);
    const row = await db.cashMovement.findUniqueOrThrow({ where: { id: paidOut.movementId } });
    expect(row).toMatchObject({ createdById: till.manager.id, approvedById: null });
    expect(await db.auditLog.count({ where: { action: "shift.cash_out" } })).toBe(1);

    expect((await loadExpectedCash(db, till.shift!.id)).expected).toBe(5_150_000n);
    // 51 500 ₮ expected: 2×20000 + 1×10000 + 1×1000 + 1×500
    const closed = await closeShift(
      closeInput(till.shift!.id, { "20000": 2, "10000": 1, "1000": 1, "500": 1 }),
      user,
      device,
      meta,
    );
    expect(closed).toMatchObject({ expectedCash: 5_150_000n, cashVariance: 0n });
  });

  it("makes a cashier get a manager approval bound to type and amount", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    const input = movementInput({ type: "CASH_OUT", amount: "100000", reason: "supplies" });
    expect(await failure(recordCashMovement(input, user, device, meta))).toBe("APPROVAL_REQUIRED");

    const signed = movementInput({
      movementId: input.movementId,
      type: "CASH_OUT",
      amount: "100000",
      reason: "supplies",
      approvals: { [shiftApprovalKeys.movement]: token(till, input, "movement") },
    });
    // The same token cannot approve a larger pay-out.
    const bigger = movementInput({
      movementId: input.movementId,
      type: "CASH_OUT",
      amount: "200000",
      reason: "supplies",
      approvals: { [shiftApprovalKeys.movement]: token(till, input, "movement") },
    });
    expect(await failure(recordCashMovement(bigger, user, device, meta))).toBe("APPROVAL_INVALID");
    expect(await db.cashMovement.count()).toBe(0);

    const result = await recordCashMovement(signed, user, device, meta);
    expect(result.replayed).toBe(false);
    const row = await db.cashMovement.findUniqueOrThrow({ where: { id: input.movementId } });
    expect(row).toMatchObject({ createdById: till.cashier.id, approvedById: till.manager.id });
  });

  it("needs a second approval to pay out more than the drawer holds", async () => {
    const till = await createTill();
    const cashier = till.ctx();
    const input = movementInput({ type: "CASH_OUT", amount: "6000000", reason: "owner draw" });
    const withMovement = movementInput({
      movementId: input.movementId,
      type: "CASH_OUT",
      amount: "6000000",
      reason: "owner draw",
      approvals: { [shiftApprovalKeys.movement]: token(till, input, "movement") },
    });
    expect(
      await failure(recordCashMovement(withMovement, cashier.user, cashier.device, meta)),
    ).toBe("APPROVAL_REQUIRED");

    const both = movementInput({
      movementId: input.movementId,
      type: "CASH_OUT",
      amount: "6000000",
      reason: "owner draw",
      approvals: {
        [shiftApprovalKeys.movement]: token(till, input, "movement"),
        [shiftApprovalKeys.overdraw]: token(till, input, "overdraw"),
      },
    });
    const result = await recordCashMovement(both, cashier.user, cashier.device, meta);
    expect(result.expectedCashAfter).toBeNull(); // a cashier never sees the drawer total
    expect(await loadExpectedCash(db, till.shift!.id)).toMatchObject({ expected: -1_000_000n });

    // A manager approves their own overdraw (permission held), but only for a real overdraw.
    const manager = till.ctx(till.manager);
    const another = movementInput({ type: "CASH_OUT", amount: "100000", reason: "more" });
    const overdrawn = await recordCashMovement(another, manager.user, manager.device, meta);
    expect(overdrawn.expectedCashAfter).toBe(-1_100_000n);
    const row = await db.cashMovement.findUniqueOrThrow({ where: { id: another.movementId } });
    expect(row.approvedById).toBe(till.manager.id);
  });

  it("replays an identical request and rejects other content for the same id", async () => {
    const till = await createTill();
    const { user, device } = till.ctx(till.manager);
    const input = movementInput({ amount: "300000" });
    const first = await recordCashMovement(input, user, device, meta);
    // A later movement must not change what a replay reports.
    await recordCashMovement(movementInput({ amount: "100000" }), user, device, meta);
    const replay = await recordCashMovement(input, user, device, meta);
    expect(replay).toMatchObject({ movementId: first.movementId, replayed: true });
    expect(replay.expectedCashAfter).toBe(first.expectedCashAfter);
    expect(await db.cashMovement.count()).toBe(2);

    const changed = movementInput({ movementId: input.movementId, amount: "400000" });
    expect(await failure(recordCashMovement(changed, user, device, meta))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
    const reworded = movementInput({
      movementId: input.movementId,
      amount: "300000",
      reason: "something else",
    });
    expect(await failure(recordCashMovement(reworded, user, device, meta))).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("serialises concurrent duplicates into one row", async () => {
    const till = await createTill();
    const { user, device } = till.ctx(till.manager);
    const input = movementInput();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => recordCashMovement(input, user, device, meta)),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(await db.cashMovement.count()).toBe(1);
  });

  it("validates amounts and needs an open shift", async () => {
    const till = await createTill();
    const { user, device } = till.ctx(till.manager);
    expect(
      await failure(recordCashMovement(movementInput({ amount: "1500" }), user, device, meta)),
    ).toBe("AMOUNT_NOT_IN_UNITS");
    await closeShift(closeInput(till.shift!.id, { "20000": 2, "10000": 1 }), user, device, meta);
    expect(await failure(recordCashMovement(movementInput(), user, device, meta))).toBe(
      "SHIFT_NOT_OPEN",
    );
  });
});

describe("shift queries", () => {
  beforeEach(resetDatabase);
  afterAll(() => db.$disconnect());

  it("scopes detail and list to the viewer and summarises variances", async () => {
    const till = await createTill();
    const { user, device } = till.ctx();
    await closeShift(
      closeInput(till.shift!.id, { "20000": 2, "5000": 1, "1000": 4 }, "short"),
      user,
      device,
      meta,
    );

    const owner = {
      id: till.manager.id,
      role: "MANAGER" as const,
      locationIds: [till.location.id],
    };
    const detail = await getShiftDetail({ user: owner }, till.shift!.id);
    expect(detail?.report.kind).toBe("Z");
    expect(detail?.shift.zReportNumber).toBe(1);
    // A cashier sees it only from the register that owns it.
    const cashierUser = {
      id: till.cashier.id,
      role: "CASHIER" as const,
      locationIds: [till.location.id],
    };
    expect(await getShiftDetail({ user: cashierUser }, till.shift!.id)).toBeNull();
    expect(
      await getShiftDetail({ user: cashierUser, registerId: till.register.id }, till.shift!.id),
    ).not.toBeNull();
    // A manager of another location sees nothing.
    const other = await createLocation();
    const outsider = {
      id: till.manager.id,
      role: "MANAGER" as const,
      locationIds: [other.location.id],
    };
    expect(await getShiftDetail({ user: outsider }, till.shift!.id)).toBeNull();

    const list = await listShifts(owner, { status: "CLOSED" });
    expect(list.rows).toHaveLength(1);
    expect(list.summary).toMatchObject({ closedCount: 1, exactCount: 0, shortCount: 1 });
    expect((await listShifts(outsider, {})).rows).toHaveLength(0);
  });
});
