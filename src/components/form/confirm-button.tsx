"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useRef } from "react";
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
import type { ActionResult } from "@/server/actions/define-action";

/**
 * A button that asks for confirmation, runs a server action, toasts the
 * outcome and refreshes the page. When the trigger may disappear after
 * success (a deleted row), pass `focusAfterId` so focus lands somewhere
 * sensible instead of on <body>.
 */
export function ConfirmButton<I>({
  action,
  input,
  label,
  title,
  description,
  successMessage,
  destructive,
  focusAfterId,
  variant = "outline",
  size = "default",
}: {
  action: (input: I) => Promise<ActionResult<unknown>>;
  input: I;
  label: string;
  title?: string;
  description: string;
  successMessage: string;
  destructive?: boolean;
  focusAfterId?: string;
  variant?: "outline" | "ghost" | "destructive" | "secondary";
  size?: "default" | "sm";
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const { run, pending } = useAction(action);
  const confirmed = useRef(false);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={variant} size={size}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!confirmed.current || !focusAfterId) return;
          confirmed.current = false;
          event.preventDefault();
          document.getElementById(focusAfterId)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title ?? label}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={
              destructive
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
            disabled={pending}
            onClick={() => {
              confirmed.current = true;
              run(input, {
                toastOnError: true,
                onSuccess: () => {
                  toast.success(successMessage);
                  router.refresh();
                },
              });
            }}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
