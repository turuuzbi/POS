"use client";

import { AlertTriangle } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";

/** Body of every error boundary: explain, offer a retry, never leak details. */
export function ErrorState({ digest, onRetry }: { digest?: string; onRetry: () => void }) {
  const t = useTranslations();
  return (
    <div
      role="alert"
      className="mx-auto flex max-w-md flex-col items-center gap-4 px-6 py-16 text-center"
    >
      <div className="flex size-12 items-center justify-center rounded-full bg-destructive/10">
        <AlertTriangle className="size-6 text-destructive" aria-hidden />
      </div>
      <h1 className="text-xl font-semibold">{t("states.errorTitle")}</h1>
      <p className="text-muted-foreground">{t("states.errorDescription")}</p>
      {digest ? (
        <p className="font-mono text-xs text-muted-foreground">
          {t("states.errorReference", { digest })}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button onClick={onRetry}>{t("common.retry")}</Button>
        <Button variant="outline" asChild>
          <Link href="/">{t("common.goHome")}</Link>
        </Button>
      </div>
    </div>
  );
}
