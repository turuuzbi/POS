"use client";

import { useTranslations } from "next-intl";
import { useCallback, useState, useTransition } from "react";
import { toast } from "sonner";
import type { ActionFailure, ActionResult } from "@/server/actions/define-action";

/**
 * When a server action calls redirect()/notFound(), Next.js rejects the
 * client-side promise with a control-flow signal (digest "NEXT_…") while it
 * performs the navigation. That is not a failure.
 */
function isNavigationSignal(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && digest.startsWith("NEXT_");
}

interface RunOptions<R> {
  onSuccess?: (data: R) => void;
  /** Also surface failures as a toast (for actions without an inline error slot). */
  toastOnError?: boolean;
}

/**
 * Call a server action from a client component with pending state and a
 * translated error message. Server-side redirects navigate as usual.
 */
export function useAction<I, R>(action: (input: I) => Promise<ActionResult<R>>) {
  const t = useTranslations("errors");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<ActionFailure | null>(null);

  const run = useCallback(
    (input: I, options: RunOptions<R> = {}) => {
      startTransition(async () => {
        let result: ActionResult<R> | undefined;
        try {
          result = await action(input);
        } catch (error) {
          if (isNavigationSignal(error)) return; // the action redirected
          result = { ok: false, error: { code: "INTERNAL" } }; // network failure
        }
        if (!result) return;
        if (result.ok) {
          setError(null);
          options.onSuccess?.(result.data);
        } else {
          setError(result.error);
          if (options.toastOnError) toast.error(t(result.error.code));
        }
      });
    },
    [action, t],
  );

  return {
    run,
    pending,
    error,
    errorMessage: error ? t(error.code) : null,
    fieldErrors: error?.fieldErrors ?? {},
    reset: () => setError(null),
  };
}
