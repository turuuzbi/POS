"use client";

import { LayoutDashboard, MonitorSmartphone, ShoppingCart, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

export type NavKey = "dashboard" | "register" | "devices";

const ITEMS: Record<NavKey, { href: string; icon: LucideIcon }> = {
  dashboard: { href: "/dashboard", icon: LayoutDashboard },
  register: { href: "/register", icon: ShoppingCart },
  devices: { href: "/settings/devices", icon: MonitorSmartphone },
};

/** Navigation entries the server decided this user may see. */
export function NavLinks({ items, onNavigate }: { items: NavKey[]; onNavigate?: () => void }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <ul className="flex flex-col gap-1">
      {items.map((key) => {
        const { href, icon: Icon } = ITEMS[key];
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <li key={key}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                active && "bg-accent text-accent-foreground",
              )}
            >
              <Icon className="size-5" aria-hidden />
              {t(key)}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
