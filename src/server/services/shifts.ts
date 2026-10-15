import "server-only";
import { v7 as uuidv7 } from "uuid";
import { can } from "@/domain/access";
import { buildXReport, buildZReport, checkReportInvariants, reportToJson } from "@/domain/report";
import {
  classifyVariance,
  parseDenominations,
  validateCashMovement,
  validateCloseShift,
} from "@/domain/shift";
import {
  cashMovementApprovalScope,
  shiftApprovalKeys,
  shiftErrorFromIssues,
  type CashMovementInput,
  type CashMovementResult,
  type CloseShiftInput,
  type CloseShiftResult,
  type ShiftErrorCode,
} from "@/domain/shift-contract";
import { SHIFT_FAILURE_DETAILS_FIELD, SHIFT_FAILURE_FIELD } from "@/domain/shift-failure";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { audit } from "../audit";
import { verifyApproval } from "../auth/approval";
import type { CurrentUser } from "../auth/session";
import { db, type Db, type Tx } from "../db";
import { ActionError, type ActionErrorCode } from "../errors";
import type { RequestMeta } from "../request";
import type { RegisterContext } from "./register-context";
import { loadExpectedCash, loadShiftReportInput } from "./shift-report";

type UserLike = Pick<CurrentUser, "id" | "role" | "locationIds">;

/**
 * Open a shift with a cash float on a register.
 * One OPEN shift per register is enforced by the database (partial unique
 * index `Shift_one_open_per_register`); the pre-check only gives a clean error.
 */
export async function openShift(
  input: { openingFloat: bigint },
  user: UserLike,
  register: RegisterContext,
  meta: RequestMeta,
  client: typeof db = db,
): Promise<{ shiftId: string }> {
  if (!can(user, "pos.shift.open", register.locationId)) throw new ActionError("FORBIDDEN");
  try {
    return await client.$transaction(async (tx) => {
      const existing = await tx.shift.findFirst({
        where: { registerId: register.registerId, status: "OPEN" },
        select: { id: true },
      });
      if (existing) throw new ActionError("INVALID_STATE", "a shift is already open");
      const shift = await tx.shift.create({
        data: {
          id: uuidv7(),
          registerId: register.registerId,
          locationId: register.locationId,
          openedById: user.id,
          openingFloat: input.openingFloat,
        },
      });
      await audit(tx, {
        actorId: user.id,
        action: "shift.open",
        entityType: "Shift",
        entityId: shift.id,
        locationId: register.locationId,
        registerId: register.registerId,
        after: { openingFloat: input.openingFloat.toString() },
        meta: { deviceId: register.deviceId },
        ...meta,
      });
      return { shiftId: shift.id };
    });
  } catch (error) {
    // A concurrent opener lost the race on the partial unique index.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ActionError("INVALID_STATE", "a shift is already open");
    }
    throw error;
  }
}

export async function findOpenShift(client: Db, registerId: string) {
  return client.shift.findFirst({ where: { registerId, status: "OPEN" } });
}

// ---------------------------------------------------------------------------
// Close shift, cash movements
// ---------------------------------------------------------------------------

/**
 * A shift failure inside the generic action envelope: `fieldErrors.shift[0]`
 * is the `ShiftErrorCode` (read with `shiftCodeFromFailure`); the message is
 * `shifts.errors.<CODE>`.
 */
export class ShiftFailure extends ActionError {
  constructor(
    readonly failure: ShiftErrorCode,
    readonly details?: Record<string, unknown>,
  ) {
    super(genericCode(failure), failure, {
      [SHIFT_FAILURE_FIELD]: [failure],
      ...(details ? { [SHIFT_FAILURE_DETAILS_FIELD]: [JSON.stringify(details)] } : {}),
    });
    this.name = "ShiftFailure";
  }
}

function genericCode(failure: ShiftErrorCode): ActionErrorCode {
  switch (failure) {
    case "PERMISSION_DENIED":
      return "FORBIDDEN";
    case "SHIFT_NOT_FOUND":
      return "NOT_FOUND";
    case "SHIFT_NOT_OPEN":
    case "SHIFT_ALREADY_OPEN":
      return "INVALID_STATE";
    case "IDEMPOTENCY_CONFLICT":
      return "CONFLICT";
    case "INTERNAL":
      return "INTERNAL";
    default:
      return "VALIDATION";
  }
}

function failFromIssues(issues: Parameters<typeof shiftErrorFromIssues>[0]): never {
  const error = shiftErrorFromIssues(issues);
  throw new ShiftFailure(error.code, error.details);
}

function sameDenominations(stored: unknown, counts: Record<string, number>): boolean {
  if (stored === null || typeof stored !== "object") return false;
  const s = stored as Record<string, unknown>;
  return Object.keys(counts).every((k) => (s[k] ?? 0) === counts[k]);
}

/**
 * Close the register's open shift: count by denomination, compare with the
 * expected cash, freeze the Z report and mark the shift CLOSED in one
 * transaction. The Shift row is locked FOR UPDATE: a sale holds it FOR SHARE,
 * so a racing sale either commits before the close (and is in the report) or
 * waits and then finds no OPEN shift (SHIFT_REQUIRED). Closing a closed shift
 * with the same count returns the stored result.
 */
export async function closeShift(
  input: CloseShiftInput,
  user: UserLike,
  register: RegisterContext,
  meta: RequestMeta,
  client: PrismaClient = db,
  now: Date = new Date(),
): Promise<CloseShiftResult> {
  if (!can(user, "pos.shift.close", register.locationId)) {
    throw new ShiftFailure("PERMISSION_DENIED");
  }
  return client.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      { id: string; registerId: string; locationId: string; status: "OPEN" | "CLOSED" }[]
    >`SELECT "id", "registerId", "locationId", "status" FROM "Shift"
      WHERE "id" = ${input.shiftId}::uuid FOR UPDATE`;
    const row = locked[0];
    // Another register's (or location's) shift looks exactly like a missing one.
    if (!row || row.registerId !== register.registerId || row.locationId !== register.locationId) {
      throw new ShiftFailure("SHIFT_NOT_FOUND");
    }

    const parsed = parseDenominations(input.denominations);
    if (!parsed.ok) {
      failFromIssues([{ code: "DENOMINATIONS_INVALID", denominationIssues: parsed.issues }]);
    }

    if (row.status === "CLOSED") {
      const closed = await tx.shift.findUniqueOrThrow({
        where: { id: row.id },
        include: { zReport: { select: { number: true } } },
      });
      if (!sameDenominations(closed.denominations, parsed.counts) || !closed.zReport) {
        throw new ShiftFailure("IDEMPOTENCY_CONFLICT");
      }
      return storedResult(closed, closed.zReport.number);
    }

    const reportInput = await loadShiftReportInput(tx, row.id, now);
    const expected = buildXReport(reportInput).cash.expected;
    const validated = validateCloseShift({
      status: "OPEN",
      expectedCash: expected,
      denominations: input.denominations,
      note: input.note,
    });
    if (!validated.ok) failFromIssues(validated.issues);

    const z = buildZReport(reportInput, {
      closedAt: now,
      countedCash: validated.countedCash,
      denominations: validated.denominations,
      note: validated.note,
    });
    const problems = checkReportInvariants(reportInput, z);
    if (problems.length > 0) console.error("[shifts.close] report invariants", row.id, problems);

    const last = await tx.zReport.aggregate({
      _max: { number: true },
      where: { registerId: register.registerId },
    });
    const number = (last._max.number ?? 0) + 1;
    await tx.zReport.create({
      data: {
        id: uuidv7(),
        shiftId: row.id,
        registerId: register.registerId,
        number,
        data: reportToJson(z) as Prisma.InputJsonValue,
      },
    });
    await tx.shift.update({
      where: { id: row.id },
      data: {
        status: "CLOSED",
        closedById: user.id,
        closedAt: now,
        expectedCash: expected,
        countedCash: validated.countedCash,
        cashVariance: validated.cashVariance,
        denominations: validated.denominations,
        closingNote: validated.note ?? null,
      },
    });
    await audit(tx, {
      actorId: user.id,
      action: "shift.close",
      entityType: "Shift",
      entityId: row.id,
      locationId: register.locationId,
      registerId: register.registerId,
      after: {
        expectedCash: expected.toString(),
        countedCash: validated.countedCash.toString(),
        cashVariance: validated.cashVariance.toString(),
        classification: validated.classification,
        zReportNumber: number,
      },
      meta: { deviceId: register.deviceId, invariantProblems: problems.length },
      ...meta,
    });
    return {
      shiftId: row.id,
      zReportNumber: number,
      expectedCash: expected,
      countedCash: validated.countedCash,
      cashVariance: validated.cashVariance,
      classification: validated.classification,
    };
  });
}

function storedResult(
  shift: {
    id: string;
    expectedCash: bigint | null;
    countedCash: bigint | null;
    cashVariance: bigint | null;
  },
  zReportNumber: number,
): CloseShiftResult {
  const variance = shift.cashVariance ?? 0n;
  return {
    shiftId: shift.id,
    zReportNumber,
    expectedCash: shift.expectedCash ?? 0n,
    countedCash: shift.countedCash ?? 0n,
    cashVariance: variance,
    classification: classifyVariance(variance),
  };
}

/**
 * Record a pay-in / pay-out on the register's open shift. The client's
 * `movementId` is the row id: a replay with the same content returns the
 * stored movement, other content is IDEMPOTENCY_CONFLICT (the row is compared
 * field by field; there is no fingerprint column). A cashier without
 * `pos.cash_movement` needs a manager approval bound to the type and amount;
 * paying out more than the drawer should hold needs a second one (a manager
 * approves their own).
 */
export async function recordCashMovement(
  input: CashMovementInput,
  user: UserLike,
  register: RegisterContext,
  meta: RequestMeta,
  client: PrismaClient = db,
  now: Date = new Date(),
): Promise<CashMovementResult> {
  if (!can(user, "pos.sell", register.locationId)) throw new ShiftFailure("PERMISSION_DENIED");
  return client.$transaction(async (tx) => {
    // Serialise duplicates of this movement id; a loser replays the winner.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${input.movementId}, 1))`;
    const existing = await tx.cashMovement.findUnique({
      where: { id: input.movementId },
      include: { shift: { select: { registerId: true } } },
    });
    if (existing) {
      if (
        existing.shift.registerId !== register.registerId ||
        existing.createdById !== user.id ||
        existing.type !== input.type ||
        existing.amount !== input.amount ||
        existing.reason !== input.reason.trim()
      ) {
        throw new ShiftFailure("IDEMPOTENCY_CONFLICT");
      }
      const after = await loadExpectedCash(tx, existing.shiftId, existing.createdAt);
      return {
        movementId: existing.id,
        type: existing.type,
        amount: existing.amount,
        expectedCashAfter: after.expected,
        replayed: true,
      };
    }

    const open = await tx.$queryRaw<{ id: string; locationId: string }[]>`
      SELECT "id", "locationId" FROM "Shift"
      WHERE "registerId" = ${register.registerId}::uuid AND "status" = 'OPEN'::"ShiftStatus"
      FOR UPDATE`;
    const shift = open[0];
    if (!shift || shift.locationId !== register.locationId) {
      throw new ShiftFailure("SHIFT_NOT_OPEN");
    }

    const { expected } = await loadExpectedCash(tx, shift.id);
    const base = {
      shiftStatus: "OPEN" as const,
      type: input.type,
      amount: input.amount,
      reason: input.reason,
      expectedCashOnHand: expected,
    };
    let checked = validateCashMovement(base);
    const hard = checked.ok ? [] : checked.issues.filter((i) => i.code !== "PAYOUT_EXCEEDS_CASH");
    if (hard.length > 0) failFromIssues(hard);

    // Approvals: the permission itself, or a manager's token bound to type and amount.
    const holds = can(user, "pos.cash_movement", register.locationId);
    let approvedById: string | null = null;
    if (!holds) {
      approvedById = await resolveCashApproval(
        tx,
        shiftApprovalKeys.movement,
        input,
        register,
        now,
      );
    }
    if (!checked.ok) {
      // Only PAYOUT_EXCEEDS_CASH is left.
      approvedById = holds
        ? user.id
        : await resolveCashApproval(tx, shiftApprovalKeys.overdraw, input, register, now);
      checked = validateCashMovement({ ...base, overdrawApproved: true });
    }
    if (!checked.ok) failFromIssues(checked.issues);

    const created = await tx.cashMovement.create({
      data: {
        id: input.movementId,
        shiftId: shift.id,
        type: input.type,
        amount: input.amount,
        reason: checked.reason,
        createdById: user.id,
        approvedById,
      },
    });
    await audit(tx, {
      actorId: user.id,
      action: input.type === "CASH_IN" ? "shift.cash_in" : "shift.cash_out",
      entityType: "CashMovement",
      entityId: created.id,
      locationId: register.locationId,
      registerId: register.registerId,
      after: {
        shiftId: shift.id,
        amount: input.amount.toString(),
        reason: checked.reason,
        approvedById,
      },
      meta: { deviceId: register.deviceId },
      ...meta,
    });
    return {
      movementId: created.id,
      type: created.type,
      amount: created.amount,
      expectedCashAfter: checked.expectedCashAfter,
      replayed: false,
    };
  });
}

/** The approving user's id for one cash-movement approval key, or a ShiftFailure. */
async function resolveCashApproval(
  tx: Tx,
  key: (typeof shiftApprovalKeys)[keyof typeof shiftApprovalKeys],
  input: CashMovementInput,
  register: RegisterContext,
  now: Date,
): Promise<string> {
  const token = input.approvals[key];
  if (!token) throw new ShiftFailure("APPROVAL_REQUIRED", { key });
  const claims = verifyApproval(
    token,
    {
      permission: "pos.cash_movement",
      scope: cashMovementApprovalScope(input.movementId, key, input),
      deviceId: register.deviceId,
    },
    now,
  );
  if (!claims) throw new ShiftFailure("APPROVAL_INVALID", { key });
  const approver = await tx.user.findUnique({
    where: { id: claims.approverId },
    include: { locations: { select: { locationId: true } } },
  });
  if (
    !approver ||
    !approver.isActive ||
    !can(
      {
        role: approver.role,
        locationIds:
          approver.role === "OWNER" ? "ALL" : approver.locations.map((l) => l.locationId),
      },
      "pos.cash_movement",
      register.locationId,
    )
  ) {
    throw new ShiftFailure("APPROVAL_INVALID", { key });
  }
  return approver.id;
}
