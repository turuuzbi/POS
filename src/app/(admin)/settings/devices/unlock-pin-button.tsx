"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { unlockDevicePin } from "@/server/actions/devices";
import { DEVICE_LIST_HEADING_ID } from "./revoke-device-button";

export function UnlockPinButton({ deviceId }: { deviceId: string }) {
  const t = useTranslations("devices");
  const router = useRouter();
  const { run, pending } = useAction(unlockDevicePin);
  return (
    <Button
      variant="secondary"
      // aria-disabled (not disabled) so keyboard focus isn't dropped mid-request.
      aria-disabled={pending || undefined}
      onClick={() => {
        if (pending) return;
        run(
          { deviceId },
          {
            toastOnError: true,
            onSuccess: () => {
              toast.success(t("pinUnlocked"));
              // This button disappears once the device is unlocked.
              document.getElementById(DEVICE_LIST_HEADING_ID)?.focus();
              router.refresh();
            },
          },
        );
      }}
    >
      {t("unlockPin")}
    </Button>
  );
}
