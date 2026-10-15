import { Clock } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Pager } from "@/components/inventory/pager";
import { VarianceBadge } from "@/components/shifts/variance-badge";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { listRegistersForFilter, listShifts } from "@/server/queries/shifts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shifts");
  return { title: t("title") };
}

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || undefined;

export default async function ShiftsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("reports.view");
  const sp = await searchParams;
  const [t, format, locale, registers] = await Promise.all([
    getTranslations("shifts"),
    getFormatter(),
    getLocale(),
    listRegistersForFilter(user),
  ]);
  const status =
    first(sp.status) === "OPEN" || first(sp.status) === "CLOSED" ? first(sp.status) : undefined;
  const registerId = registers.find((r) => r.id === first(sp.register))?.id;
  const from = first(sp.from);
  const to = first(sp.to);
  const { rows, page, pages, summary } = await listShifts(user, {
    from,
    to,
    registerId,
    status: status as "OPEN" | "CLOSED" | undefined,
    page: Number(first(sp.page)) || 1,
  });
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const when = (date: Date) => format.dateTime(date, { dateStyle: "medium", timeStyle: "short" });
  const filtered = Boolean(from || to || registerId || status);

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <form
        method="get"
        role="search"
        aria-label={t("list.filters")}
        className="grid grid-cols-1 items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="shift-from">{t("list.from")}</Label>
          <Input id="shift-from" type="date" name="from" defaultValue={from ?? ""} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shift-to">{t("list.to")}</Label>
          <Input id="shift-to" type="date" name="to" defaultValue={to ?? ""} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shift-register">{t("list.register")}</Label>
          <NativeSelect id="shift-register" name="register" defaultValue={registerId ?? ""}>
            <option value="">{t("list.allRegisters")}</option>
            {registers.map((r) => (
              <option key={r.id} value={r.id}>
                {registers.length > 1 ? `${r.location.name} · ${r.name}` : r.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="shift-status">{t("list.status")}</Label>
          <NativeSelect id="shift-status" name="status" defaultValue={status ?? ""}>
            <option value="">{t("list.allStatuses")}</option>
            <option value="OPEN">{t("list.statusOPEN")}</option>
            <option value="CLOSED">{t("list.statusCLOSED")}</option>
          </NativeSelect>
        </div>
        <div className="flex gap-2">
          <Button type="submit">{t("list.filter")}</Button>
          {filtered ? (
            <Link href="/shifts" className={cn(buttonVariants({ variant: "outline" }))}>
              {t("list.reset")}
            </Link>
          ) : null}
        </div>
      </form>

      <section aria-labelledby="shift-summary" className="space-y-2">
        <h2 id="shift-summary" className="text-sm font-medium text-muted-foreground">
          {t("list.summary")}
        </h2>
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="variance-summary">
          <SummaryCell label={t("list.summaryClosed")} value={String(summary.closedCount)} />
          <SummaryCell label={t("list.summaryExact")} value={String(summary.exactCount)} />
          <SummaryCell
            label={t("list.summaryShort")}
            value={`${summary.shortCount} · ${money(summary.shortTotal)}`}
            tone={summary.shortCount > 0 ? "bad" : undefined}
          />
          <SummaryCell
            label={t("list.summaryOver")}
            value={`${summary.overCount} · ${money(summary.overTotal)}`}
            tone={summary.overCount > 0 ? "warn" : undefined}
          />
          <SummaryCell label={t("list.summaryNet")} value={money(summary.net)} />
        </dl>
      </section>

      <section aria-labelledby="shift-list" className="space-y-3">
        <h2 id="shift-list" className="sr-only">
          {t("list.heading")}
        </h2>
        {rows.length === 0 ? (
          <EmptyState
            icon={Clock}
            title={t("list.empty")}
            description={t("list.emptyDescription")}
          />
        ) : (
          <>
            <Card className="overflow-x-auto py-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("list.opened")}</TableHead>
                    <TableHead>{t("list.register_col")}</TableHead>
                    <TableHead>{t("list.status")}</TableHead>
                    <TableHead>{t("list.cashier")}</TableHead>
                    <TableHead className="text-right">{t("list.expected")}</TableHead>
                    <TableHead className="text-right">{t("list.counted")}</TableHead>
                    <TableHead className="text-right">{t("list.variance")}</TableHead>
                    <TableHead>{t("list.z")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => (
                    <TableRow key={row.id} data-testid="shift-row">
                      <TableCell className="whitespace-nowrap">
                        <Link
                          href={`/shifts/${row.id}`}
                          className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline focus-visible:underline"
                        >
                          {when(row.openedAt)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        {row.locationName} · {row.registerName}
                      </TableCell>
                      <TableCell>
                        <Badge variant={row.status === "OPEN" ? "default" : "secondary"}>
                          {t(`list.status${row.status}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.closedByName ?? row.openedByName}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.expectedCash === null ? "—" : money(row.expectedCash)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {row.countedCash === null ? "—" : money(row.countedCash)}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.cashVariance === null ? (
                          "—"
                        ) : (
                          <VarianceBadge
                            variance={row.cashVariance}
                            text={money(row.cashVariance)}
                          />
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">{row.zReportNumber ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
            <Pager
              basePath="/shifts"
              params={{
                from,
                to,
                register: registerId,
                status,
              }}
              page={page}
              pages={pages}
            />
          </>
        )}
      </section>
    </div>
  );
}

function SummaryCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "bad" | "warn";
}) {
  return (
    <Card
      className={cn(
        "gap-1 px-4 py-3",
        tone === "bad" && "border-destructive/50 bg-destructive/10",
        tone === "warn" && "border-warning bg-warning/15",
      )}
    >
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </Card>
  );
}
