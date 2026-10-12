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
import { revokeDevice } from "@/server/actions/devices";

/** Element that receives focus after the dialog closes (the row may disappear). */
export const DEVICE_LIST_HEADING_ID = "device-list";

export function RevokeDeviceButton({
  deviceId,
  label,
  confirm,
  successMessage,
}: {
  deviceId: string;
  label: string;
  confirm: string;
  successMessage: string;
}) {
  const t = useTranslations("common");
  const router = useRouter();
  const { run, pending } = useAction(revokeDevice);
  // Only a confirmed revoke removes the trigger; Cancel/Escape keep Radix's
  // default of returning focus to it.
  const confirmed = useRef(false);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline">{label}</Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!confirmed.current) return;
          confirmed.current = false;
          // The trigger is about to be removed by the refresh: keep focus on the list.
          event.preventDefault();
          document.getElementById(DEVICE_LIST_HEADING_ID)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{confirm}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={pending}
            onClick={() => {
              confirmed.current = true;
              run(
                { deviceId },
                {
                  toastOnError: true,
                  onSuccess: () => {
                    toast.success(successMessage);
                    router.refresh();
                  },
                },
              );
            }}
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
