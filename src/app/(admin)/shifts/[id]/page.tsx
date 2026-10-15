import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/app/page-header";
import { PrintableReport } from "@/components/shifts/report-view";
import { VarianceBadge } from "@/components/shifts/variance-badge";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { uuid } from "@/domain/checkout-contract";
import { formatMoney } from "@/domain/money";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { getShiftDetail } from "@/server/queries/shifts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("shifts");
  return { title: t("title") };
}

export default async function ShiftDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("reports.view");
  const { id } = await params;
  const parsed = uuid.safeParse(id);
  if (!parsed.success) notFound();
  const detail = await getShiftDetail({ user }, parsed.data);
  if (!detail) notFound();

  const [t, format, locale] = await Promise.all([
    getTranslations("shifts"),
    getFormatter(),
    getLocale(),
  ]);
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const when = (date: Date) => format.dateTime(date, { dateStyle: "medium", timeStyle: "short" });
  const { shift } = detail;

  return (
    <div className="space-y-6">
      <Link
        href="/shifts"
        className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "-ml-3 w-fit")}
      >
        <ArrowLeft aria-hidden />
        {t("detail.back")}
      </Link>
      <PageHeader
        title={t("detail.title", { register: shift.registerName })}
        description={`${shift.locationName} · ${when(shift.openedAt)}`}
        actions={
          <Badge variant={shift.status === "OPEN" ? "default" : "secondary"}>
            {t(`list.status${shift.status}`)}
          </Badge>
        }
      />
      {shift.status === "OPEN" ? (
        <p role="status" className="rounded-md bg-muted px-3 py-2 text-sm">
          {t("detail.liveNotice")}
        </p>
      ) : null}

      <section aria-labelledby="shift-summary" className="space-y-2">
        <h2 id="shift-summary" className="text-lg font-semibold">
          {t("detail.summary")}
        </h2>
        <Card className="px-4 py-3">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            <Fact
              label={t("detail.openedBy")}
              value={`${shift.openedByName} · ${when(shift.openedAt)}`}
            />
            {shift.closedAt ? (
              <Fact
                label={t("detail.closedBy")}
                value={`${shift.closedByName ?? "—"} · ${when(shift.closedAt)}`}
              />
            ) : null}
            <Fact label={t("report.openingFloat")} value={money(shift.openingFloat)} />
            <Fact
              label={t("report.expectedCash")}
              value={money(shift.expectedCash ?? detail.report.cash.expected)}
            />
            {shift.countedCash !== null ? (
              <Fact label={t("report.countedCash")} value={money(shift.countedCash)} />
            ) : null}
            {shift.cashVariance !== null ? (
              <div className="flex flex-col gap-1" data-testid="detail-variance">
                <dt className="text-xs text-muted-foreground">{t("report.variance")}</dt>
                <dd>
                  <VarianceBadge variance={shift.cashVariance} text={money(shift.cashVariance)} />
                </dd>
              </div>
            ) : null}
            {shift.closingNote ? (
              <Fact label={t("report.closingNote")} value={shift.closingNote} />
            ) : null}
          </dl>
        </Card>
      </section>

      <section aria-labelledby="shift-movements" className="space-y-2">
        <h2 id="shift-movements" className="text-lg font-semibold">
          {t("detail.movements")}
        </h2>
        {detail.movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("detail.noMovements")}</p>
        ) : (
          <Card className="overflow-x-auto py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("report.movementTime")}</TableHead>
                  <TableHead>{t("report.movementType")}</TableHead>
                  <TableHead className="text-right">{t("report.movementAmount")}</TableHead>
                  <TableHead>{t("report.movementReason")}</TableHead>
                  <TableHead>{t("report.movementBy")}</TableHead>
                  <TableHead>{t("report.movementApprovedBy")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.movements.map((m) => (
                  <TableRow key={m.id} data-testid="movement-row">
                    <TableCell className="whitespace-nowrap">{when(m.createdAt)}</TableCell>
                    <TableCell>{t(`report.types.${m.type}`)}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.type === "CASH_IN" ? money(m.amount) : money(-m.amount)}
                    </TableCell>
                    <TableCell className="max-w-64 break-words">{m.reason}</TableCell>
                    <TableCell>{m.createdByName}</TableCell>
                    <TableCell>{m.approvedByName ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>

      <section aria-labelledby="shift-report" className="space-y-2">
        <h2 id="shift-report" className="text-lg font-semibold">
          {t("detail.reportHeading")}
        </h2>
        <PrintableReport
          report={detail.report}
          meta={{
            registerName: shift.registerName,
            locationName: shift.locationName,
            openedByName: shift.openedByName,
            closedByName: shift.closedByName,
            zNumber: shift.zReportNumber,
          }}
          movements={detail.movements}
        />
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{value}</dd>
    </div>
  );
}
