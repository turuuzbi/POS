import { MapPinOff, PackageSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Pager } from "@/components/inventory/pager";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/domain/money";
import { formatQty } from "@/domain/qty";
import { isLowStock } from "@/domain/stock-levels";
import { can, requirePermission } from "@/server/auth/session";
import { resolveLocation } from "@/server/queries/locations";
import { listStock } from "@/server/queries/stock";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("inventory");
  return { title: t("title") };
}

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || undefined;

export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("inventory.view");
  const sp = await searchParams;
  const q = first(sp.q)?.slice(0, 100);
  const lowOnly = first(sp.low) === "1";
  const showCosts = can(user, "reports.view_costs");
  const [t, tu, locale, { locations, location }] = await Promise.all([
    getTranslations("inventory"),
    getTranslations("units"),
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

  const { rows, total, page, pages } = await listStock(user, {
    locationId: location.id,
    q,
    lowOnly,
    page: Number(first(sp.page)) || 1,
    showCosts,
  });
  const filtered = Boolean(q) || lowOnly;

  return (
    <div className="space-y-6">
      {header}

      <form method="get" className="flex flex-col gap-3 sm:flex-row sm:items-end" role="search">
        {locations.length > 1 ? (
          <div className="flex flex-col gap-2 sm:w-56">
            <Label htmlFor="stock-location">{t("location")}</Label>
            <NativeSelect id="stock-location" name="location" defaultValue={location.id}>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <input type="hidden" name="location" value={location.id} />
        )}
        <div className="flex flex-1 flex-col gap-2">
          <Label htmlFor="stock-q">{t("search")}</Label>
          <Input
            id="stock-q"
            name="q"
            type="search"
            defaultValue={q}
            maxLength={100}
            placeholder={t("searchPlaceholder")}
          />
        </div>
        <label className="flex h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="low"
            value="1"
            defaultChecked={lowOnly}
            className="size-5 accent-primary"
          />
          {t("lowOnly")}
        </label>
        <Button type="submit">{t("apply")}</Button>
      </form>

      <section aria-labelledby="stock-list" className="space-y-3">
        <h2 id="stock-list" className="sr-only">
          {t("listHeading")}
        </h2>
        {rows.length === 0 ? (
          <EmptyState
            icon={PackageSearch}
            title={filtered ? t("noResults") : t("empty")}
            description={filtered ? t("noResultsDescription") : t("emptyDescription")}
          />
        ) : (
          <>
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("resultCount", { count: total })}
            </p>
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("product")}</TableHead>
                    <TableHead className="text-right">{t("onHand")}</TableHead>
                    <TableHead className="text-right">{t("reorderPoint")}</TableHead>
                    {showCosts ? (
                      <>
                        <TableHead className="text-right">{t("avgCost")}</TableHead>
                        <TableHead className="text-right">{t("value")}</TableHead>
                      </>
                    ) : null}
                    <TableHead>{t("status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const low = isLowStock(row.onHandMilli, row.reorderPointMilli);
                    const unit = tu(row.unit);
                    return (
                      <TableRow key={row.variantId}>
                        <TableCell>
                          <Link
                            href={`/inventory/stock/${row.variantId}?location=${location.id}`}
                            className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                          >
                            {row.label}
                          </Link>
                          {row.sku ? (
                            <div className="text-xs text-muted-foreground">{row.sku}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(row.onHandMilli, row.unit, { locale })} {unit}
                        </TableCell>
                        <TableCell className="text-right text-muted-foreground tabular-nums">
                          {row.reorderPointMilli === null
                            ? "—"
                            : `${formatQty(row.reorderPointMilli, row.unit, { locale })} ${unit}`}
                        </TableCell>
                        {showCosts ? (
                          <>
                            <TableCell className="text-right tabular-nums">
                              {formatMoney(row.avgCost ?? 0n, { locale })}
                            </TableCell>
                            <TableCell className="text-right tabular-nums">
                              {formatMoney(row.value ?? 0n, { locale })}
                            </TableCell>
                          </>
                        ) : null}
                        <TableCell>
                          {low ? (
                            <Badge variant="destructive">{t("low")}</Badge>
                          ) : (
                            <Badge variant="secondary">{t("ok")}</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
            <Pager
              basePath="/inventory/stock"
              params={{ location: location.id, q, low: lowOnly ? "1" : undefined }}
              page={page}
              pages={pages}
            />
          </>
        )}
      </section>
    </div>
  );
}
