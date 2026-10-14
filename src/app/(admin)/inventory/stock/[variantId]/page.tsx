import { ArrowLeft, History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Pager } from "@/components/inventory/pager";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import { can, requirePermission } from "@/server/auth/session";
import { resolveLocation } from "@/server/queries/locations";
import { getStockVariant, listVariantLedger, type LedgerRow } from "@/server/queries/stock";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("inventory");
  return { title: t("ledgerHeading") };
}

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || undefined;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const short = (id: string) => id.slice(-8).toUpperCase();

export default async function StockVariantPage({
  params,
  searchParams,
}: {
  params: Promise<{ variantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("inventory.view");
  const [{ variantId }, sp] = await Promise.all([params, searchParams]);
  if (!UUID.test(variantId)) notFound();
  const { location } = await resolveLocation(user, first(sp.location));
  if (!location) notFound();
  const showCosts = can(user, "reports.view_costs");

  const [variant, ledger, t, tu, tt, locale, format] = await Promise.all([
    getStockVariant(user, variantId, location.id),
    listVariantLedger(user, variantId, location.id, {
      page: Number(first(sp.page)) || 1,
      showCosts,
    }),
    getTranslations("inventory"),
    getTranslations("units"),
    getTranslations("inventory.types"),
    getLocale(),
    getFormatter(),
  ]);
  if (!variant) notFound();

  const unit = tu(variant.unit);
  const qty = (milli: number) => `${formatQty(milli, variant.unit, { locale })} ${unit}`;
  const low = isLowStock(variant.onHandMilli, variant.reorderPointMilli);

  // Targets need their own permission (this page only needs inventory.view): plain text otherwise.
  const canAdjust = can(user, "inventory.adjust");
  const canReceive = can(user, "inventory.receive");
  const canStocktake = can(user, "inventory.stocktake");
  const reference = (row: LedgerRow): React.ReactNode => {
    if (row.adjustmentId) {
      const label = t("ref.adjustment", { id: short(row.adjustmentId) });
      return canAdjust ? (
        <Link href={`/inventory/adjustments/${row.adjustmentId}`} className="underline">
          {label}
        </Link>
      ) : (
        label
      );
    }
    if (row.goodsReceiptId) {
      const label = t("ref.goodsReceipt", {
        number: row.goodsReceiptNumber ?? short(row.goodsReceiptId),
      });
      return canReceive ? (
        <Link href={`/purchasing/receipts/${row.goodsReceiptId}`} className="underline">
          {label}
        </Link>
      ) : (
        label
      );
    }
    if (row.stocktakeId) {
      const label = t("ref.stocktake", { number: row.stocktakeNumber ?? short(row.stocktakeId) });
      return canStocktake ? (
        <Link href={`/inventory/stocktakes/${row.stocktakeId}`} className="underline">
          {label}
        </Link>
      ) : (
        label
      );
    }
    // Sales and refunds have no admin page yet: show the reference as text.
    if (row.saleId) return t("ref.sale", { id: short(row.saleId) });
    if (row.refundId) return t("ref.refund", { id: short(row.refundId) });
    return "—";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("historyFor", { name: variant.label })}
        description={`${location.name}${variant.sku ? ` · ${variant.sku}` : ""}`}
        actions={
          <Link
            href={`/inventory/stock?location=${location.id}`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            <ArrowLeft aria-hidden />
            {t("backToStock")}
          </Link>
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="sr-only">{variant.label}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-sm text-muted-foreground">{t("onHand")}</dt>
              <dd className="flex items-center gap-2 text-xl font-semibold tabular-nums">
                {qty(variant.onHandMilli)}
                {low ? <Badge variant="destructive">{t("low")}</Badge> : null}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("reorderPoint")}</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {variant.reorderPointMilli === null ? "—" : qty(variant.reorderPointMilli)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("reorderQty")}</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {variant.reorderQtyMilli === null ? "—" : qty(variant.reorderQtyMilli)}
              </dd>
            </div>
            {showCosts ? (
              <div>
                <dt className="text-sm text-muted-foreground">{t("avgCost")}</dt>
                <dd className="text-xl font-semibold tabular-nums">
                  {formatMoney(variant.cost, { locale })}
                </dd>
              </div>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      <section aria-labelledby="ledger" className="space-y-3">
        <h2 id="ledger" className="text-lg font-semibold">
          {t("ledgerHeading")}
        </h2>
        {ledger.rows.length === 0 ? (
          <EmptyState icon={History} title={t("ledgerEmpty")} />
        ) : (
          <>
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("col.date")}</TableHead>
                    <TableHead>{t("col.type")}</TableHead>
                    <TableHead className="text-right">{t("col.change")}</TableHead>
                    <TableHead className="text-right">{t("col.balance")}</TableHead>
                    {showCosts ? (
                      <TableHead className="text-right">{t("col.unitCost")}</TableHead>
                    ) : null}
                    <TableHead>{t("col.reference")}</TableHead>
                    <TableHead>{t("col.user")}</TableHead>
                    <TableHead>{t("col.note")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ledger.rows.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell className="whitespace-nowrap">
                        {format.dateTime(row.createdAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </TableCell>
                      <TableCell>{tt(row.type)}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right font-medium tabular-nums",
                          row.qtyDeltaMilli < 0 ? "text-destructive" : "text-success",
                        )}
                      >
                        {row.qtyDeltaMilli > 0 ? "+" : ""}
                        {formatQty(row.qtyDeltaMilli, variant.unit, { locale })}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatQty(row.balanceAfterMilli, variant.unit, { locale })}
                      </TableCell>
                      {showCosts ? (
                        <TableCell className="text-right tabular-nums">
                          {row.unitCost === null ? "—" : formatMoney(row.unitCost, { locale })}
                        </TableCell>
                      ) : null}
                      <TableCell>{reference(row)}</TableCell>
                      <TableCell>{row.createdByName}</TableCell>
                      <TableCell className="max-w-64 truncate" title={row.note ?? undefined}>
                        {row.note ?? "—"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Pager
              basePath={`/inventory/stock/${variantId}`}
              params={{ location: location.id }}
              page={ledger.page}
              pages={ledger.pages}
            />
          </>
        )}
      </section>
    </div>
  );
}
