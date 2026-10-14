import { ArrowLeft, ClipboardList, Lock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { can } from "@/domain/access";
import { formatMoney } from "@/domain/money";
import { formatQty } from "@/domain/qty";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { getStocktake } from "@/server/queries/stocktakes";
import { CountScreen } from "./count-screen";
import { FinalizePanel } from "./finalize-panel";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("stocktakes");
  return { title: t("title") };
}

const STATUS_VARIANT = {
  IN_PROGRESS: "default",
  COMPLETED: "success",
  CANCELLED: "secondary",
} as const;

export default async function StocktakePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ view?: string; only?: string }>;
}) {
  const user = await requirePermission("inventory.stocktake");
  const { id } = await params;
  const { view, only } = await searchParams;
  const [t, tc, locale] = await Promise.all([
    getTranslations("stocktakes"),
    getTranslations("common"),
    getLocale(),
  ]);
  const showCosts = can(user, "reports.view_costs");
  const stocktake = await getStocktake(id, user, showCosts);
  if (!stocktake) {
    return (
      <EmptyState
        icon={ClipboardList}
        headingLevel={1}
        title={t("notFound")}
        description={t("notFoundDescription")}
        action={<BackLink label={t("backToList")} />}
      />
    );
  }

  const isOpen = stocktake.status === "IN_PROGRESS";
  const reviewing = !isOpen || view === "review";
  const onlyVariances = only === "variance";
  const base = `/inventory/stocktakes/${stocktake.id}`;
  const dateFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const { summary } = stocktake;
  const rows = onlyVariances
    ? stocktake.lines.filter((l) => l.varianceMilli !== null && l.varianceMilli !== 0)
    : stocktake.lines;
  const fmtVariance = (milli: number, unit: (typeof stocktake.lines)[number]["unit"]) =>
    `${milli > 0 ? "+" : ""}${formatQty(milli, unit, { locale })}`;

  return (
    <div className="space-y-6">
      <div>
        <BackLink label={t("backToList")} />
      </div>
      <PageHeader
        title={stocktake.number}
        description={[
          stocktake.location.name,
          stocktake.category?.name ?? t("fullCount"),
          t("startedBy", { name: stocktake.startedBy }),
          dateFormat.format(stocktake.startedAt),
        ].join(" · ")}
        actions={
          <Badge variant={STATUS_VARIANT[stocktake.status]}>{t(`status${stocktake.status}`)}</Badge>
        }
      />
      {stocktake.note ? <p className="text-sm text-muted-foreground">{stocktake.note}</p> : null}

      {isOpen ? (
        <nav aria-label={t("title")} className="flex gap-2">
          <TabLink href={base} active={!reviewing} label={t("tabCount")} />
          <TabLink href={`${base}?view=review`} active={reviewing} label={t("tabReview")} />
        </nav>
      ) : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Lock className="size-4" aria-hidden />
          {t("lockedNote")}
          {stocktake.completedBy && stocktake.completedAt
            ? ` ${t("completedBy", { name: stocktake.completedBy })} · ${dateFormat.format(stocktake.completedAt)}`
            : null}
        </p>
      )}

      {!reviewing ? (
        <CountScreen
          stocktakeId={stocktake.id}
          initialLines={stocktake.lines.map((l) => ({
            variantId: l.variantId,
            label: l.label,
            sku: l.sku,
            unit: l.unit,
            countedMilli: l.countedMilli,
          }))}
        />
      ) : (
        <section aria-labelledby="stocktake-review" className="space-y-4">
          <h2 id="stocktake-review" className="text-lg font-semibold">
            {t("reviewHeading")}
          </h2>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label={t("summaryCounted")} value={String(summary.counted)} />
            <Stat label={t("summaryUncounted")} value={String(summary.uncounted)} />
            <Stat
              label={t("summarySurplus")}
              value={t("summaryLines", { count: summary.surplusLines })}
            />
            <Stat
              label={t("summaryShortage")}
              value={t("summaryLines", { count: summary.shortageLines })}
            />
            {summary.netValue !== null ? (
              <Stat label={t("summaryNet")} value={formatMoney(summary.netValue, { locale })} />
            ) : null}
          </dl>
          {isOpen ? <p className="text-sm text-muted-foreground">{t("varianceNote")}</p> : null}
          <div className="flex gap-2">
            <TabLink
              href={isOpen ? `${base}?view=review` : base}
              active={!onlyVariances}
              label={t("allLines")}
            />
            <TabLink
              href={`${base}?${isOpen ? "view=review&" : ""}only=variance`}
              active={onlyVariances}
              label={t("onlyVariances")}
            />
          </div>

          {rows.length === 0 ? (
            <EmptyState icon={ClipboardList} title={t("noLines")} description={t("noMatches")} />
          ) : (
            <Card className="py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("item")}</TableHead>
                    <TableHead className="text-right">
                      {isOpen ? t("expectedNow") : t("expected")}
                    </TableHead>
                    <TableHead className="text-right">{t("counted")}</TableHead>
                    <TableHead className="text-right">{t("variance")}</TableHead>
                    {showCosts ? <TableHead className="text-right">{t("value")}</TableHead> : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((line) => {
                    const v = line.varianceMilli;
                    return (
                      <TableRow key={line.variantId}>
                        <TableCell>
                          <div className="font-medium">{line.label}</div>
                          {line.sku ? (
                            <div className="text-xs text-muted-foreground">{line.sku}</div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatQty(line.liveMilli, line.unit, { locale })}
                          {isOpen && line.expectedMilli !== line.liveMilli ? (
                            <div className="text-xs text-muted-foreground">
                              {t("snapshotNote", {
                                qty: formatQty(line.expectedMilli, line.unit, { locale }),
                              })}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {line.countedMilli === null ? (
                            <span className="text-muted-foreground">{t("notCounted")}</span>
                          ) : (
                            formatQty(line.countedMilli, line.unit, { locale })
                          )}
                        </TableCell>
                        <TableCell
                          className={cn(
                            "text-right font-medium tabular-nums",
                            v !== null && v < 0 && "text-destructive",
                          )}
                        >
                          {v === null ? (
                            <span aria-label={t("notCounted")}>{tc("none")}</span>
                          ) : v === 0 ? (
                            t("matches")
                          ) : (
                            <>
                              {fmtVariance(v, line.unit)}
                              <span className="sr-only">
                                {" "}
                                {v > 0 ? t("surplus") : t("shortage")}
                              </span>
                            </>
                          )}
                        </TableCell>
                        {showCosts ? (
                          <TableCell className="text-right tabular-nums">
                            {line.value === null ? tc("none") : formatMoney(line.value, { locale })}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </Card>
          )}

          {isOpen ? (
            <FinalizePanel
              stocktakeId={stocktake.id}
              counted={summary.counted}
              uncounted={summary.uncounted}
            />
          ) : null}
        </section>
      )}
    </div>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link
      href="/inventory/stocktakes"
      className="inline-flex items-center gap-1 text-sm text-muted-foreground underline-offset-4 hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden />
      {label}
    </Link>
  );
}

function TabLink({ href, active, label }: { href: string; active: boolean; label: string }) {
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium",
        active ? "border-primary bg-primary text-primary-foreground" : "hover:bg-accent",
      )}
    >
      {label}
    </Link>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
