/**
 * Void eligibility for the register: the same `planVoid` the server runs, so
 * the screen can say WHY a sale cannot be voided (other shift, already
 * refunded, ...) before anyone types a PIN.
 */
import type { z } from "zod";
import { hasPermission, type Role } from "@/domain/permissions";
import {
  MAX_VOID_NOTE_LENGTH,
  planVoid,
  type VoidIssueCode,
  type VoidPlan,
  type VoidReason,
} from "@/domain/void";
import { voidApprovalKey, voidApprovalScope, type voidInputSchema } from "@/domain/void-contract";
import type { RecentSale, ReturnSale } from "./sale-wire";
import { toVoidSnapshot } from "./sale-wire";

export type VoidInputWire = z.input<typeof voidInputSchema>;

/** Why a void is impossible, most fundamental first (this order is the display order). */
export type VoidBlock =
  "SALE_NOT_COMPLETED" | "SHIFT_NOT_OPEN" | "SALE_IN_OTHER_SHIFT" | "HAS_REFUNDS" | "NOT_SUPPORTED";

const BLOCK_ORDER: readonly VoidBlock[] = [
  "SALE_NOT_COMPLETED",
  "SHIFT_NOT_OPEN",
  "SALE_IN_OTHER_SHIFT",
  "HAS_REFUNDS",
  "NOT_SUPPORTED",
];

/** The first structural reason a sale cannot be voided right now, from a list row. */
export function voidBlockForRow(
  row: Pick<RecentSale, "state" | "shiftId">,
  currentShiftId: string | null,
): VoidBlock | null {
  if (row.state === "VOIDED") return "SALE_NOT_COMPLETED";
  if (currentShiftId === null) return "SHIFT_NOT_OPEN";
  if (row.shiftId !== currentShiftId) return "SALE_IN_OTHER_SHIFT";
  if (row.state !== "OK") return "HAS_REFUNDS";
  return null;
}

/** Message key (under `refunds.void.blocked`) per block. */
export const VOID_BLOCK_KEY = {
  SALE_NOT_COMPLETED: "alreadyVoided",
  SHIFT_NOT_OPEN: "noShift",
  SALE_IN_OTHER_SHIFT: "otherShift",
  HAS_REFUNDS: "hasRefunds",
  NOT_SUPPORTED: "notSupported",
} as const satisfies Record<VoidBlock, string>;

export type VoidCheck =
  | { ok: true; plan: VoidPlan; needsApproval: boolean; scope: string; key: string }
  | {
      ok: false;
      blocks: VoidBlock[];
      /** Reason / note still to be entered (the plan is then the preview of what a void does). */
      pending: boolean;
      plan?: VoidPlan;
    };

/**
 * Full check against the loaded sale. `reason` may still be unset: a missing
 * reason or note is `pending` (fixable on the form), not a block.
 */
export function checkVoid(input: {
  sale: ReturnSale;
  currentShiftId: string | null;
  reason: VoidReason | null;
  note: string;
  role: Role;
}): VoidCheck {
  const { sale, currentShiftId } = input;
  const shift = {
    id: currentShiftId ?? "none",
    status: currentShiftId ? ("OPEN" as const) : ("CLOSED" as const),
  };
  const snapshot = toVoidSnapshot(sale);
  const blocksOf = (issues: readonly { code: VoidIssueCode }[]) => {
    const codes = new Set<VoidIssueCode>(issues.map((i) => i.code));
    return BLOCK_ORDER.filter((b) => codes.has(b));
  };
  // The structural rules first, with a neutral reason: what the void would do is
  // shown before the cashier has chosen a reason.
  const base = planVoid(snapshot, { shift, reason: "ENTRY_ERROR", grants: { void: true } });
  if (!base.ok) return { ok: false, blocks: blocksOf(base.issues), pending: false };

  const note = input.note.trim();
  if (
    input.reason === null ||
    (input.reason === "OTHER" && note === "") ||
    note.length > MAX_VOID_NOTE_LENGTH
  ) {
    return { ok: false, blocks: [], pending: true, plan: base.plan };
  }
  const result = planVoid(snapshot, {
    shift,
    reason: input.reason,
    note,
    grants: { void: true },
  });
  if (!result.ok) return { ok: false, blocks: blocksOf(result.issues), pending: false };
  return {
    ok: true,
    plan: result.plan,
    needsApproval: !hasPermission(input.role, "pos.void"),
    scope: voidApprovalScope(sale.id, sale.totalAmount),
    key: voidApprovalKey,
  };
}

export function buildVoidInput(input: {
  saleId: string;
  reason: VoidReason;
  note: string;
  token: string | null;
  now?: Date;
}): VoidInputWire {
  const note = input.note.trim();
  return {
    saleId: input.saleId,
    reason: input.reason,
    ...(note ? { note } : {}),
    approvals: input.token ? { [voidApprovalKey]: input.token } : {},
    createdAtClient: (input.now ?? new Date()).toISOString(),
  };
}
