"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { unlockDevicePin } from "@/server/actions/devices";

export function UnlockPinButton({ deviceId }: { deviceId: string }) {
  const t = useTranslations("devices");
  const router = useRouter();
  const { run, pending } = useAction(unlockDevicePin);
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        run(
          { deviceId },
          {
            toastOnError: true,
            onSuccess: () => {
              toast.success(t("pinUnlocked"));
              router.refresh();
            },
          },
        )
      }
    >
      {t("unlockPin")}
    </Button>
  );
}
