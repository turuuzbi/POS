"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import type { RefundIssue } from "@/domain/refund";
import { messageCandidates, type FailureView } from "@/lib/refunds/errors";

/** Loose `t` for namespaces other slices own (`refundErrors`, `errors`). */
type LooseT = {
  (key: string, values?: Record<string, string | number>): string;
  has(key: string): boolean;
};

/**
 * Translate a refund / void failure. The service slice owns `refundErrors.*`
 * (keys from the contracts' *_ERROR_MESSAGE_KEYS); when a key is missing the
 * UI's own `refunds.issues.<CODE>` text is used, then a generic message, so a
 * code the catalog does not know yet never shows as a raw key.
 */
export function useFailureMessage() {
  const t = useTranslations() as unknown as LooseT;
  const failure = useCallback(
    (view: FailureView): string => {
      for (const key of messageCandidates(view)) if (t.has(key)) return t(key);
      return t("refunds.errors.generic");
    },
    [t],
  );
  /** A planner issue found on the client (the same codes the server raises). */
  const issue = useCallback(
    (item: Pick<RefundIssue, "code">): string => {
      const key = `refunds.issues.${item.code}`;
      return t.has(key) ? t(key) : t("refunds.errors.generic");
    },
    [t],
  );
  return { failure, issue };
}
