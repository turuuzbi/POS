"use client";

import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { KeypadField } from "@/components/pos/keypad";
import { PosDialog } from "@/components/pos/pos-dialog";
import type { ApprovablePermission } from "@/domain/permissions";
import type { HeldApproval } from "@/lib/refunds/plan";
import { requestApproval } from "@/server/actions/auth";

const PIN_MIN = 4;
const PIN_MAX = 8;

export interface ApprovalItem {
  key: string;
  permission: ApprovablePermission;
  /** The exact scope the token will carry (recomputed and verified by the server). */
  scope: string;
  /** What the manager is approving, in words. */
  label: string;
}

/**
 * A manager types their PIN on this device. One PIN approves every pending
 * item; the server issues one token per item, bound to that item's scope
 * (sale / lines / amount for a refund, sale / amount for a void), so a token
 * cannot be reused for a different amount.
 */
export function ApprovalPinDialog({
  open,
  onClose,
  items,
  onGranted,
}: {
  open: boolean;
  onClose: () => void;
  items: readonly ApprovalItem[];
  /** `complete`: every item was granted. Partial grants are kept by the caller. */
  onGranted: (grants: Record<string, HeldApproval>, complete: boolean) => void;
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
    const grants: Record<string, HeldApproval> = {};
    try {
      for (const item of items) {
        const result = await requestApproval({
          pin,
          permission: item.permission,
          scope: item.scope,
        });
        if (!result.ok) {
          setError(
            result.error.code === "INVALID_CREDENTIALS" || result.error.code === "VALIDATION"
              ? t("invalidPin")
              : te(result.error.code),
          );
          setPin("");
          if (Object.keys(grants).length) onGranted(grants, false);
          return;
        }
        grants[item.key] = {
          token: result.data.token,
          scope: item.scope,
          approverName: result.data.approverName,
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
      <ul
        className="space-y-1 rounded-md bg-muted px-3 py-2 text-sm"
        aria-label={t("pendingList")}
        data-testid="approval-items"
      >
        {items.map((item) => (
          <li key={item.key} className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span>{item.label}</span>
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
