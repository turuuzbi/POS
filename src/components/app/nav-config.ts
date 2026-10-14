import type { Permission } from "@/domain/permissions";

/**
 * Back-office navigation (pure data, shared by the server layout, which
 * filters by permission, and the client menu, which renders it).
 */
export const NAV_SECTIONS = [
  {
    key: "overview",
    items: [
      { key: "dashboard", href: "/dashboard", permission: null },
      { key: "register", href: "/register", permission: "pos.sell" },
    ],
  },
  {
    key: "catalog",
    items: [
      { key: "products", href: "/catalog/products", permission: "catalog.view" },
      { key: "categories", href: "/catalog/categories", permission: "catalog.view" },
      { key: "importExport", href: "/catalog/import-export", permission: "catalog.edit" },
    ],
  },
  {
    key: "inventory",
    items: [
      { key: "stock", href: "/inventory/stock", permission: "inventory.view" },
      { key: "adjustments", href: "/inventory/adjustments", permission: "inventory.adjust" },
      { key: "stocktakes", href: "/inventory/stocktakes", permission: "inventory.stocktake" },
    ],
  },
  {
    key: "purchasing",
    items: [
      { key: "purchaseOrders", href: "/purchasing/orders", permission: "purchasing.manage" },
      { key: "receiving", href: "/purchasing/receipts", permission: "inventory.receive" },
      { key: "suppliers", href: "/purchasing/suppliers", permission: "purchasing.manage" },
    ],
  },
  {
    key: "settings",
    items: [
      { key: "taxClasses", href: "/settings/tax-classes", permission: "settings.manage" },
      { key: "devices", href: "/settings/devices", permission: "devices.manage" },
    ],
  },
] as const satisfies readonly {
  key: string;
  items: readonly { key: string; href: string; permission: Permission | null }[];
}[];

export type NavSectionKey = (typeof NAV_SECTIONS)[number]["key"];
export type NavKey = (typeof NAV_SECTIONS)[number]["items"][number]["key"];

/** Sections and items this permission check allows, empty sections dropped. */
export function visibleNav(allowed: (permission: Permission) => boolean) {
  return NAV_SECTIONS.map((section) => ({
    key: section.key as NavSectionKey,
    items: section.items
      .filter((item) => item.permission === null || allowed(item.permission))
      .map((item) => item.key as NavKey),
  })).filter((section) => section.items.length > 0);
}

export type VisibleNav = ReturnType<typeof visibleNav>;

export const NAV_HREF: Record<NavKey, string> = Object.fromEntries(
  NAV_SECTIONS.flatMap((section) => section.items.map((item) => [item.key, item.href])),
) as Record<NavKey, string>;
