"use client";

import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { approvalScope, type ApprovalRequirement } from "@/domain/discounts";
import type { ApprovalGrant } from "@/lib/pos/pos-state";
import { requestApproval } from "@/server/actions/auth";
import { KeypadField } from "./keypad";
import { PosDialog } from "./pos-dialog";

const PIN_MIN = 4;
const PIN_MAX = 8;

/**
 * A manager types their PIN on this device. One PIN approves every pending
 * requirement: the server issues one token per requirement, bound to the sale,
 * the requirement key and the approved value (`approvalScope`), which checkout
 * recomputes and verifies.
 */
export function ApprovalDialog({
  open,
  onClose,
  saleId,
  pending,
  fingerprintOf,
  describe,
  onGranted,
}: {
  open: boolean;
  onClose: () => void;
  saleId: string;
  pending: readonly ApprovalRequirement[];
  fingerprintOf: (requirement: ApprovalRequirement) => string;
  /** Short human text for a requirement ("Price change: Coffee"). */
  describe: (requirement: ApprovalRequirement) => string;
  /** `complete`: every pending requirement was granted. */
  onGranted: (grants: Record<string, ApprovalGrant>, complete: boolean) => void;
}) {
  const t = useTranslations("pos.approval");
  const te = useTranslations("errors");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const submit = async () => {
    if (busy || pin.length < PIN_MIN) return;
    setBusy(true);
    setError(null);
    const grants: Record<string, ApprovalGrant> = {};
    try {
      for (const requirement of pending) {
        const result = await requestApproval({
          pin,
          permission: requirement.permission,
          scope: approvalScope(saleId, requirement),
        });
        if (!result.ok) {
          setError(
            result.error.code === "INVALID_CREDENTIALS" || result.error.code === "VALIDATION"
              ? t("invalidPin")
              : te(result.error.code),
          );
          setPin("");
          // Keep what was already granted (the manager need not re-approve it) but
          // stay open on the error: the parent advances only when none is pending.
          if (Object.keys(grants).length) onGranted(grants, false);
          return;
        }
        grants[requirement.key] = {
          token: result.data.token,
          approverName: result.data.approverName,
          fingerprint: fingerprintOf(requirement),
          grantedAt: Date.now(),
        };
      }
      onGranted(grants, true);
    } catch {
      setError(te("INTERNAL"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <PosDialog
      open={open}
      onClose={onClose}
      title={t("title")}
      description={t("description")}
      locked={busy}
    >
      <ul className="space-y-1 rounded-md bg-muted px-3 py-2 text-sm" aria-label={t("pendingList")}>
        {pending.map((requirement) => (
          <li key={requirement.key} className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>{describe(requirement)}</span>
          </li>
        ))}
      </ul>
      <KeypadField
        value={pin}
        onChange={(next) => {
          setError(null);
          setPin(next.slice(0, PIN_MAX));
        }}
        label={t("pinLabel")}
        maxLength={PIN_MAX}
        mask
        leadingZeros
        invalid={error !== null}
        describedBy={error ? errorId : undefined}
        onEnter={submit}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={busy}>
          {t("cancel")}
        </Button>
        <Button onClick={submit} disabled={busy || pin.length < PIN_MIN}>
          {busy ? t("checking") : t("approve")}
        </Button>
      </DialogFooter>
    </PosDialog>
  );
}
