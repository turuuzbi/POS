import { LayoutDashboard, ScanBarcode } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PreferencesMenu } from "@/components/app/preferences-menu";
import { UserMenu } from "@/components/app/user-menu";
import { Button } from "@/components/ui/button";
import { hasPermission } from "@/domain/permissions";
import { requirePermission } from "@/server/auth/session";
import { currentDevice } from "@/server/queries/devices";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pos");
  return { title: t("title") };
}

export default async function RegisterPage() {
  const user = await requirePermission("pos.sell");
  const [t, device] = await Promise.all([getTranslations(), currentDevice()]);

  return (
    <>
      <header className="flex h-14 items-center gap-2 border-b bg-background px-3">
        <div className="min-w-0">
          <h1 className="truncate font-semibold">
            {device
              ? `${device.locationName} · ${device.registerName ?? device.name}`
              : t("pos.title")}
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            {device ? t("pos.cashier", { name: user.name }) : t("pos.unassigned")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {hasPermission(user.role, "reports.view") ? (
            <Button variant="ghost" asChild>
              <Link href="/dashboard">
                <LayoutDashboard aria-hidden />
                <span className="hidden sm:inline">{t("pos.backOffice")}</span>
              </Link>
            </Button>
          ) : null}
          <PreferencesMenu />
          <UserMenu name={user.name} role={user.role} onDevice={user.deviceId !== null} />
        </div>
      </header>
      <main id="main" className="flex flex-1 items-center justify-center p-4">
        <EmptyState
          icon={ScanBarcode}
          title={t("pos.checkoutComingTitle")}
          description={t("pos.checkoutComingDescription")}
          className="w-full max-w-lg bg-background"
        />
      </main>
    </>
  );
}
