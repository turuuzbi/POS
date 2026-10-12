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
import { revokeDevice } from "@/server/actions/devices";

export function RevokeDeviceButton({
  deviceId,
  name,
  label,
}: {
  deviceId: string;
  name: string;
  label: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const { run, pending } = useAction(revokeDevice);

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm" disabled={pending}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{t("devices.revokeConfirm", { name })}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() =>
              run(
                { deviceId },
                {
                  toastOnError: true,
                  onSuccess: () => {
                    toast.success(t("devices.revoked"));
                    router.refresh();
                  },
                },
              )
            }
          >
            {label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
