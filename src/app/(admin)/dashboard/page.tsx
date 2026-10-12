import { ArrowRight, MonitorSmartphone, ShoppingCart, Sparkles } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { hasPermission } from "@/domain/permissions";
import { requireUser } from "@/server/auth/session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("dashboard");
  return { title: t("title") };
}

export default async function DashboardPage() {
  const user = await requireUser();
  const t = await getTranslations();
  const shortcuts = [
    hasPermission(user.role, "pos.sell") && {
      href: "/register",
      icon: ShoppingCart,
      title: t("dashboard.openRegister"),
      description: t("dashboard.openRegisterDescription"),
    },
    hasPermission(user.role, "devices.manage") && {
      href: "/settings/devices",
      icon: MonitorSmartphone,
      title: t("dashboard.manageDevices"),
      description: t("dashboard.manageDevicesDescription"),
    },
  ].filter((item) => item !== false);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("dashboard.greeting", { name: user.name })}
        description={t("dashboard.signedInAs", { role: t(`roles.${user.role}`) })}
      />
      <ul className="grid gap-4 sm:grid-cols-2">
        {shortcuts.map(({ href, icon: Icon, title, description }) => (
          <li key={href}>
            <Link
              href={href}
              className="group block rounded-xl focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <Card className="h-full transition-colors group-hover:bg-accent/50">
                <CardHeader className="grid-cols-[auto_1fr_auto] items-center gap-4">
                  <Icon className="size-8 text-muted-foreground" aria-hidden />
                  <div className="space-y-1">
                    <CardTitle>{title}</CardTitle>
                    <CardDescription>{description}</CardDescription>
                  </div>
                  <ArrowRight className="size-5 text-muted-foreground" aria-hidden />
                </CardHeader>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
      <EmptyState
        icon={Sparkles}
        title={t("dashboard.comingSoonTitle")}
        description={t("dashboard.comingSoonDescription")}
      />
    </div>
  );
}
