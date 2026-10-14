"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/**
 * Register error boundary. The cart is saved in the browser on every change,
 * so a crash here never loses a sale in progress: retry re-renders it.
 */
export default function RegisterError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations();
  return (
    <main id="main" className="flex min-h-dvh items-center justify-center p-4">
      <div role="alert" className="flex max-w-md flex-col items-center gap-4 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
          <AlertTriangle className="size-6 text-destructive" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold">{t("states.errorTitle")}</h1>
        <p className="text-muted-foreground">{t("pos.errorBoundary.cartSaved")}</p>
        {error.digest ? (
          <p className="font-mono text-xs text-muted-foreground">
            {t("states.errorReference", { digest: error.digest })}
          </p>
        ) : null}
        <Button size="lg" onClick={retry}>
          {t("common.retry")}
        </Button>
      </div>
    </main>
  );
}
