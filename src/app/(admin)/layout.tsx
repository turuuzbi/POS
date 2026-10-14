import type * as React from "react";
import { getTranslations } from "next-intl/server";
import { MobileNav } from "@/components/app/mobile-nav";
import { visibleNav } from "@/components/app/nav-config";
import { NavLinks } from "@/components/app/nav-links";
import { PreferencesMenu } from "@/components/app/preferences-menu";
import { UserMenu } from "@/components/app/user-menu";
import { hasPermission } from "@/domain/permissions";
import { requireUser } from "@/server/auth/session";

/** Back-office shell. Navigation lists only what this role can open. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const t = await getTranslations();
  const nav = visibleNav((permission) => hasPermission(user.role, permission));

  return (
    <div className="flex min-h-dvh">
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 overflow-y-auto border-r bg-sidebar text-sidebar-foreground md:block">
        <div className="flex h-14 items-center px-5 text-lg font-semibold">
          {t("common.appName")}
        </div>
        <nav aria-label={t("nav.label")} className="px-2">
          <NavLinks nav={nav} />
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <MobileNav nav={nav} />
          <span className="font-semibold md:hidden">{t("common.appName")}</span>
          <div className="ml-auto flex items-center gap-1">
            <PreferencesMenu />
            <UserMenu name={user.name} role={user.role} onDevice={user.deviceId !== null} />
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
