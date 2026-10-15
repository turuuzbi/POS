"use client";

import {
  Boxes,
  ClipboardCheck,
  ClipboardList,
  FileSpreadsheet,
  FolderTree,
  Grid3x3,
  LayoutDashboard,
  MonitorSmartphone,
  Package,
  PackageCheck,
  Percent,
  Receipt,
  ShoppingCart,
  SlidersHorizontal,
  Truck,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { NAV_HREF, type NavKey, type VisibleNav } from "./nav-config";

const ICONS: Record<NavKey, LucideIcon> = {
  dashboard: LayoutDashboard,
  register: ShoppingCart,
  salesHistory: Receipt,
  products: Package,
  categories: FolderTree,
  quickKeys: Grid3x3,
  importExport: FileSpreadsheet,
  stock: Boxes,
  adjustments: SlidersHorizontal,
  stocktakes: ClipboardCheck,
  purchaseOrders: ClipboardList,
  receiving: PackageCheck,
  suppliers: Truck,
  taxClasses: Percent,
  devices: MonitorSmartphone,
};

/** Navigation entries the server decided this user may see, grouped by section. */
export function NavLinks({ nav, onNavigate }: { nav: VisibleNav; onNavigate?: () => void }) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  return (
    <div className="flex flex-col gap-4 pb-6">
      {nav.map((section) => (
        <div key={section.key} className="flex flex-col gap-1">
          {section.key === "overview" ? null : (
            <h2
              id={`nav-${section.key}`}
              className="px-3 pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {t(`sections.${section.key}`)}
            </h2>
          )}
          <ul
            className="flex flex-col gap-1"
            aria-labelledby={section.key === "overview" ? undefined : `nav-${section.key}`}
          >
            {section.items.map((key) => {
              const href = NAV_HREF[key];
              const Icon = ICONS[key];
              const active = pathname === href || pathname.startsWith(`${href}/`);
              return (
                <li key={key}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground",
                      active &&
                        "bg-accent font-semibold text-accent-foreground before:absolute before:inset-y-2 before:start-0 before:w-1 before:rounded-full before:bg-ring",
                    )}
                  >
                    <Icon className="size-5" aria-hidden />
                    {t(key)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
