"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmButton } from "@/components/form/confirm-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useAction } from "@/hooks/use-action";
import { cancelStocktakeAction, finalizeStocktakeAction } from "@/server/actions/stocktakes";

/** Finish (post the counts to the ledger and lock) or cancel an open stocktake. */
export function FinalizePanel({
  stocktakeId,
  counted,
  uncounted,
}: {
  stocktakeId: string;
  counted: number;
  uncounted: number;
}) {
  const t = useTranslations("stocktakes");
  const tc = useTranslations("common");
  const router = useRouter();
  const checkboxId = useId();
  const [countAll, setCountAll] = useState(false);
  const { run, pending, errorMessage } = useAction(finalizeStocktakeAction);
  const affected = countAll ? counted + uncounted : counted;

  return (
    <div className="space-y-4 rounded-xl border p-4">
      {uncounted > 0 ? (
        <div className="flex items-start gap-3">
          <Checkbox
            id={checkboxId}
            checked={countAll}
            onCheckedChange={(checked) => setCountAll(checked === true)}
            aria-describedby={`${checkboxId}-help`}
          />
          <div className="space-y-1">
            <Label htmlFor={checkboxId}>{t("countAll")}</Label>
            <p id={`${checkboxId}-help`} className="text-sm text-muted-foreground">
              {t("countAllHelp", { count: uncounted })}
            </p>
          </div>
        </div>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="default">{t("finalize")}</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("finalizeTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {countAll && uncounted > 0
                  ? t("finalizeConfirmAll", { count: affected, uncounted })
                  : t("finalizeConfirm", { count: affected })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
              <AlertDialogAction
                disabled={pending}
                onClick={() =>
                  run(
                    { id: stocktakeId, countAll },
                    {
                      toastOnError: true,
                      onSuccess: (result) => {
                        toast.success(
                          t("finalized", { posted: result.posted, unchanged: result.unchanged }),
                        );
                        router.refresh();
                      },
                    },
                  )
                }
              >
                {t("finalize")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <ConfirmButton
          action={cancelStocktakeAction}
          input={{ id: stocktakeId }}
          label={t("cancel")}
          description={t("cancelConfirm")}
          successMessage={t("cancelled")}
          destructive
          variant="ghost"
        />
      </div>
    </div>
  );
}
