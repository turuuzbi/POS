import { MapPinOff } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { formatMoney } from "@/domain/money";
import { MAX_QUICK_KEYS_PER_TAB } from "@/domain/quick-keys";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { resolveLocation } from "@/server/queries/locations";
import { listQuickKeys, listQuickKeyTabs } from "@/server/queries/quick-keys";
import { LocationPicker } from "./location-picker";
import { QuickKeyEditor } from "./quick-key-editor";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("quickKeys");
  return { title: t("title") };
}

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || undefined;

export default async function QuickKeysPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("catalog.edit");
  const sp = await searchParams;
  const [t, locale, { locations, location }] = await Promise.all([
    getTranslations("quickKeys"),
    getLocale(),
    resolveLocation(user, first(sp.location)),
  ]);

  const header = <PageHeader title={t("title")} description={t("description")} />;
  if (!location) {
    return (
      <div className="space-y-6">
        {header}
        <EmptyState
          icon={MapPinOff}
          title={t("noLocations")}
          description={t("noLocationsDescription")}
        />
      </div>
    );
  }

  const tabs = await listQuickKeyTabs(location.id);
  const tab = tabs.find((x) => x.categoryId === first(sp.tab)) ?? tabs[0]!;
  const keys = (await listQuickKeys(location.id, tab.categoryId)).map((key) => ({
    id: key.id,
    productId: key.productId,
    name: key.name,
    color: key.color,
    isActive: key.isActive,
    variantCount: key.variantCount,
    priceLabel: key.price === null ? null : formatMoney(key.price, { locale }),
  }));
  const tabName = tab.name ?? t("favourites");
  const href = (categoryId: string | null) =>
    `/catalog/quick-keys?location=${location.id}${categoryId ? `&tab=${categoryId}` : ""}`;

  return (
    <div className="space-y-6">
      {header}

      {locations.length > 1 ? (
        <LocationPicker locations={locations} current={location.id} label={t("location")} />
      ) : null}

      <nav aria-label={t("tabsLabel")}>
        <ul className="flex flex-wrap gap-2">
          {tabs.map((x) => {
            const current = x.categoryId === tab.categoryId;
            return (
              <li key={x.categoryId ?? "favourites"}>
                <Link
                  href={href(x.categoryId)}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center gap-2 rounded-md border px-3 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                    current
                      ? "border-primary bg-primary text-primary-foreground"
                      : "bg-background hover:bg-accent dark:bg-input/30",
                  )}
                >
                  <span>{x.name ?? t("favourites")}</span>
                  <span className={cn("text-xs", current ? "opacity-90" : "text-muted-foreground")}>
                    {x.keyCount}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <QuickKeyEditor
        // A new grid starts with fresh local state.
        key={`${location.id}:${tab.categoryId ?? "fav"}`}
        locationId={location.id}
        categoryId={tab.categoryId}
        tabName={tabName}
        keys={keys}
        max={MAX_QUICK_KEYS_PER_TAB}
      />
    </div>
  );
}
