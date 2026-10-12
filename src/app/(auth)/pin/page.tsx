import { MonitorX } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { Button } from "@/components/ui/button";
import { findActiveDevice, readDeviceToken } from "@/server/auth/device";
import { getCurrentUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { PinPad } from "./pin-pad";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("pinTitle") };
}

export default async function PinPage() {
  const user = await getCurrentUser();
  // Already signed in on this device: "Switch user" signs out first, so only
  // a stale visit lands here.
  if (user) redirect("/");
  const t = await getTranslations("auth");
  const device = await findActiveDevice(db, await readDeviceToken());

  if (!device) {
    return (
      <EmptyState
        icon={MonitorX}
        title={t("notPairedTitle")}
        description={t("notPairedDescription")}
        action={
          <Button asChild>
            <Link href="/login">{t("usePassword")}</Link>
          </Button>
        }
        className="w-full max-w-md bg-background"
      />
    );
  }

  return (
    <div className="flex w-full max-w-xs flex-col items-center gap-6">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">{t("pinTitle")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("pinDevice", { device: device.name, location: device.location.name })}
        </p>
      </div>
      <PinPad />
      <Button variant="link" asChild>
        <Link href="/login">{t("usePassword")}</Link>
      </Button>
    </div>
  );
}
