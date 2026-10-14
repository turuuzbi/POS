import { LayoutDashboard } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { PreferencesMenu } from "@/components/app/preferences-menu";
import { UserMenu } from "@/components/app/user-menu";
import { RegisterApp } from "@/components/pos/register-app";
import { Button } from "@/components/ui/button";
import { hasPermission } from "@/domain/permissions";
import { requirePermission } from "@/server/auth/session";
import { getRegisterContext } from "@/server/queries/register";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("pos");
  return { title: t("title") };
}

export default async function RegisterPage() {
  const user = await requirePermission("pos.sell");
  const [t, context] = await Promise.all([getTranslations("pos"), getRegisterContext(user)]);

  return (
    <RegisterApp
      user={{ id: user.id, name: user.name, role: user.role }}
      context={context}
      headerActions={
        <>
          {hasPermission(user.role, "reports.view") ? (
            <Button variant="ghost" asChild>
              <Link href="/dashboard" aria-label={t("backOffice")}>
                <LayoutDashboard aria-hidden />
                <span className="hidden md:inline">{t("backOffice")}</span>
              </Link>
            </Button>
          ) : null}
          <PreferencesMenu />
          <UserMenu name={user.name} role={user.role} onDevice={user.deviceId !== null} />
        </>
      }
    />
  );
}
