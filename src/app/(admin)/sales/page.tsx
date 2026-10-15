import { Receipt } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Pager } from "@/components/inventory/pager";
import { SalesFiltersForm } from "@/components/sales/filters-form";
import { SaleStatusBadge } from "@/components/sales/status-badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatMoney } from "@/domain/money";
import { parseSalesFilter, salesFilterParams } from "@/domain/sales-filter";
import { requirePermission } from "@/server/auth/session";
import { getSalesFilterOptions, listSales } from "@/server/queries/sales";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("sales");
  return { title: t("title") };
}

export default async function SalesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("reports.view");
  const filter = parseSalesFilter(await searchParams);
  const [t, tm, format, locale, options, result] = await Promise.all([
    getTranslations("sales"),
    getTranslations("receipt.method"),
    getFormatter(),
    getLocale(),
    getSalesFilterOptions(user),
    listSales(user, filter),
  ]);
  const params = salesFilterParams(filter);
  const exportQuery = new URLSearchParams(
    Object.entries(params).filter((e): e is [string, string] => Boolean(e[1])),
  ).toString();
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const { totals } = result;

  const stats: { key: string; label: string; value: string }[] = [
    { key: "count", label: t("totals.count"), value: format.number(totals.count) },
    { key: "gross", label: t("totals.gross"), value: money(totals.gross) },
    { key: "refunded", label: t("totals.refunded"), value: money(totals.refunded) },
    { key: "net", label: t("totals.net"), value: money(totals.net) },
    { key: "voided", label: t("totals.voided"), value: money(totals.voided) },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <SalesFiltersForm
        filter={filter}
        options={options}
        exportHref={exportQuery ? `/sales/export?${exportQuery}` : "/sales/export"}
      />

      <section aria-labelledby="sales-totals" className="space-y-2">
        <h2 id="sales-totals" className="sr-only">
          {t("totals.heading")}
        </h2>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {stats.map((s) => (
            <div
              key={s.key}
              data-testid={`total-${s.key}`}
              className="rounded-xl border bg-card px-4 py-3"
            >
              <dt className="text-sm text-muted-foreground">{s.label}</dt>
              <dd className="text-lg font-semibold tabular-nums">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="sales-list" className="space-y-3">
        <h2 id="sales-list" className="sr-only">
          {t("list.heading")}
        </h2>
        {result.rows.length === 0 ? (
          <EmptyState icon={Receipt} title={t("list.empty")} description={t("list.emptyHint")} />
        ) : (
          <>
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("columns.number")}</TableHead>
                    <TableHead>{t("columns.date")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("columns.location")}</TableHead>
                    <TableHead className="hidden md:table-cell">{t("columns.register")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("columns.cashier")}</TableHead>
                    <TableHead className="hidden lg:table-cell">{t("columns.methods")}</TableHead>
                    <TableHead className="text-right">{t("columns.total")}</TableHead>
                    <TableHead className="hidden text-right sm:table-cell">
                      {t("columns.refunded")}
                    </TableHead>
                    <TableHead>{t("columns.status")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.rows.map((row) => (
                    <TableRow key={row.id} data-sale-number={row.number}>
                      <TableCell>
                        <Link
                          href={`/sales/${row.id}`}
                          className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline focus-visible:underline"
                        >
                          {row.number}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {format.dateTime(row.occurredAt, {
                          dateStyle: "medium",
                          timeStyle: "short",
                        })}
                      </TableCell>
                      <TableCell className="hidden md:table-cell">{row.locationName}</TableCell>
                      <TableCell className="hidden md:table-cell">{row.registerCode}</TableCell>
                      <TableCell className="hidden lg:table-cell">{row.cashierName}</TableCell>
                      <TableCell className="hidden lg:table-cell">
                        {row.methods.map((m) => tm(m)).join(", ")}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap tabular-nums">
                        {money(row.totalAmount)}
                      </TableCell>
                      <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">
                        {row.refundedAmount > 0n ? `-${money(row.refundedAmount)}` : ""}
                      </TableCell>
                      <TableCell>
                        <SaleStatusBadge status={row.status} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Pager basePath="/sales" params={params} page={result.page} pages={result.pages} />
          </>
        )}
      </section>
    </div>
  );
}
