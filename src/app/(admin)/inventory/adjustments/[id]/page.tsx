import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/app/page-header";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { cn } from "@/lib/utils";
import { can, requirePermission } from "@/server/auth/session";
import { getAdjustment } from "@/server/queries/stock";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adjustments");
  return { title: t("title") };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdjustmentDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("inventory.adjust");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const showCosts = can(user, "reports.view_costs");
  const [adjustment, t, tu, locale, format] = await Promise.all([
    getAdjustment(user, id, showCosts),
    getTranslations("adjustments"),
    getTranslations("units"),
    getLocale(),
    getFormatter(),
  ]);
  if (!adjustment) notFound();

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("detailTitle", { id: adjustment.id.slice(-8).toUpperCase() })}
        description={`${t(`reasons.${adjustment.reason}`)} · ${adjustment.locationName}`}
        actions={
          <Link
            href="/inventory/adjustments"
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            <ArrowLeft aria-hidden />
            {t("backToList")}
          </Link>
        }
      />

      <Card>
        <CardContent>
          <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="text-sm text-muted-foreground">{t("date")}</dt>
              <dd>
                {format.dateTime(adjustment.createdAt, { dateStyle: "medium", timeStyle: "short" })}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{t("by")}</dt>
              <dd>{adjustment.createdByName}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-sm text-muted-foreground">{t("note")}</dt>
              <dd className="whitespace-pre-wrap">{adjustment.note ?? "—"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <section aria-labelledby="adj-lines" className="space-y-3">
        <h2 id="adj-lines" className="text-lg font-semibold">
          {t("lines")}
        </h2>
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("form.productsHeading")}</TableHead>
                <TableHead className="text-right">{t("form.qtyDelta")}</TableHead>
                <TableHead className="text-right">{t("balanceAfter")}</TableHead>
                {showCosts ? <TableHead className="text-right">{t("value")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustment.lines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell>
                    <Link
                      href={`/inventory/stock/${line.variantId}?location=${adjustment.locationId}`}
                      className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                    >
                      {line.label}
                    </Link>
                    {line.sku ? (
                      <div className="text-xs text-muted-foreground">{line.sku}</div>
                    ) : null}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-medium tabular-nums",
                      line.qtyDeltaMilli < 0 ? "text-destructive" : "text-success",
                    )}
                  >
                    {line.qtyDeltaMilli > 0 ? "+" : ""}
                    {formatQty(line.qtyDeltaMilli, line.unit, { locale })} {tu(line.unit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatQty(line.balanceAfterMilli, line.unit, { locale })} {tu(line.unit)}
                  </TableCell>
                  {showCosts ? (
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(line.value ?? 0n, { locale })}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        {showCosts && adjustment.totalValue !== null ? (
          <p className="text-right font-semibold tabular-nums">
            {t("totalValue")}: {formatMoney(adjustment.totalValue, { locale })}
          </p>
        ) : null}
      </section>
    </div>
  );
}
