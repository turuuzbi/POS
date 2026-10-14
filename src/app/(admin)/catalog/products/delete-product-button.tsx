"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
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
import { useAction } from "@/hooks/use-action";
import { deleteProductAction } from "@/server/actions/products";

/** Delete an unused product, then go back to the list (the page it was on is gone). */
export function DeleteProductButton({ id, name }: { id: string; name: string }) {
  const t = useTranslations("products");
  const tc = useTranslations("common");
  const router = useRouter();
  const { run, pending, errorMessage } = useAction(deleteProductAction);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost">{tc("delete")}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tc("delete")}</AlertDialogTitle>
          <AlertDialogDescription>{tc("confirmDelete", { name })}</AlertDialogDescription>
        </AlertDialogHeader>
        {errorMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{tc("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault(); // stay open to show IN_USE
              run(
                { id },
                {
                  onSuccess: () => {
                    toast.success(t("deleted"));
                    router.push("/catalog/products");
                  },
                },
              );
            }}
          >
            {tc("delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
