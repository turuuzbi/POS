"use client";

import { Printer, RefreshCw } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { formatMoney, type Money } from "@/domain/money";
import type { ShiftReport } from "@/domain/report";
import { MNT_DENOMINATIONS } from "@/domain/shift";
import { cn } from "@/lib/utils";

export type ReportPaper = "80" | "A4";

export interface ReportMeta {
  registerName: string;
  locationName: string;
  openedByName: string;
  closedByName: string | null;
  zNumber: number | null;
}

export interface ReportMovement {
  id: string;
  type: "CASH_IN" | "CASH_OUT";
  amount: Money;
  reason: string;
  createdAt: Date;
  createdByName: string;
  approvedByName: string | null;
}

const PAGE_CSS: Record<ReportPaper, string> = {
  "80": "@page { size: 80mm auto; margin: 0; }",
  A4: "@page { size: A4; margin: 14mm; }",
};

/**
 * Print rules: only the report (and what it sits in) survives. Every element
 * that is neither the report, an ancestor of it nor inside it is hidden;
 * ancestors lose their positioning, clipping and chrome, so a report inside a
 * dialog or the admin shell prints as a plain page.
 */
const PRINT_CSS = (paper: ReportPaper) => `@media print {
  ${PAGE_CSS[paper]}
  html, body { background: #fff !important; color: #000 !important; margin: 0 !important; height: auto !important; overflow: visible !important; }
  body :not(.shift-print):not(:has(.shift-print)):not(.shift-print *) { display: none !important; }
  body :has(.shift-print) { position: static !important; transform: none !important; overflow: visible !important; max-height: none !important; height: auto !important; width: auto !important; max-width: none !important; display: block !important; inset: auto !important; padding: 0 !important; margin: 0 !important; border: 0 !important; box-shadow: none !important; background: none !important; }
  .shift-print { width: ${paper === "80" ? "80mm" : "100%"} !important; max-width: none !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; padding: ${paper === "80" ? "4mm" : "0"} !important; background: #fff !important; color: #000 !important; }
  .shift-print * { color: #000 !important; }
}`;

/** Toolbar (paper + print) and the report. The toolbar never prints. */
export function PrintableReport({
  report,
  meta,
  movements,
  hideExpected = false,
  onRefresh,
  refreshing = false,
  className,
}: {
  report: ShiftReport;
  meta: ReportMeta;
  movements?: readonly ReportMovement[];
  /** Blind close: the cashier does not see the expected cash before counting. */
  hideExpected?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
  className?: string;
}) {
  const t = useTranslations("shifts");
  const [paper, setPaper] = useState<ReportPaper>("80");
  const groupId = useId();
  return (
    <div className={cn("space-y-3", className)}>
      <style>{PRINT_CSS(paper)}</style>
      <div
        role="toolbar"
        aria-label={t("report.print")}
        className="flex flex-wrap items-center gap-2 print:hidden"
      >
        <div role="group" aria-labelledby={groupId} className="flex items-center gap-1">
          <span id={groupId} className="sr-only">
            {t("paper.label")}
          </span>
          {(["80", "A4"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={paper === option ? "default" : "outline"}
              aria-pressed={paper === option}
              className="min-h-11 min-w-11"
              onClick={() => setPaper(option)}
            >
              {option === "80" ? t("paper.p80") : t("paper.a4")}
            </Button>
          ))}
        </div>
        <Button type="button" onClick={() => window.print()} data-testid="report-print">
          <Printer aria-hidden />
          {t("report.print")}
        </Button>
        {onRefresh ? (
          <Button type="button" variant="outline" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw aria-hidden className={refreshing ? "animate-spin" : undefined} />
            {t("report.refresh")}
          </Button>
        ) : null}
      </div>
      <ReportView
        report={report}
        meta={meta}
        movements={movements}
        paper={paper}
        hideExpected={hideExpected}
      />
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  tone,
  testId,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  strong?: boolean;
  tone?: "bad" | "warn" | "good";
  testId?: string;
}) {
  return (
    <div
      className={cn("flex items-baseline justify-between gap-3 py-0.5", strong && "font-semibold")}
    >
      <dt className="min-w-0 break-words">{label}</dt>
      <dd
        data-testid={testId}
        className={cn(
          "shrink-0 text-right tabular-nums",
          tone === "bad" && "font-bold text-red-700",
          tone === "warn" && "font-bold text-amber-700",
          tone === "good" && "font-bold text-green-700",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-dashed border-current/40 pt-2">
      <h3 id={id} className="mb-1 text-xs font-bold tracking-wide uppercase">
        {title}
      </h3>
      <dl>{children}</dl>
    </section>
  );
}

/** Pure presentation of a `ShiftReport` (X or Z). Black on white: it is paper. */
export function ReportView({
  report,
  meta,
  movements,
  paper,
  hideExpected = false,
}: {
  report: ShiftReport;
  meta: ReportMeta;
  movements?: readonly ReportMovement[] | undefined;
  paper: ReportPaper;
  hideExpected?: boolean;
}) {
  const t = useTranslations("shifts.report");
  const locale = useLocale();
  const format = useFormatter();
  const money = (amount: Money) => formatMoney(amount, { locale });
  // The server (Node ICU) and the browser spell Mongolian dates differently ("10-р сар" vs
  // "M10"); this report is also server-rendered (back-office shift page), so the date text is
  // exempt from the hydration comparison instead of raising React error #418 on every view.
  const when = (date: Date) => (
    <span suppressHydrationWarning>
      {format.dateTime(date, { dateStyle: "medium", timeStyle: "short" })}
    </span>
  );
  const z = report.kind === "Z" ? report.closing : undefined;
  const variance = z?.cashVariance ?? 0n;
  const tone = z
    ? z.classification === "OK"
      ? "good"
      : z.classification === "SHORT"
        ? "bad"
        : "warn"
    : undefined;
  const pct = (bps: number) => `${bps / 100}%`;
  const headingId = useId();

  return (
    <article
      aria-labelledby={headingId}
      data-paper={paper}
      data-kind={report.kind}
      className={cn(
        "shift-print mx-auto box-border w-full space-y-2 rounded-sm border border-black/15 bg-white p-4 font-mono text-xs leading-snug text-black shadow-sm",
        paper === "80" ? "max-w-[80mm]" : "max-w-3xl text-sm",
      )}
    >
      <header className="space-y-0.5 text-center">
        <h2 id={headingId} className="text-base font-bold">
          {report.kind === "Z" ? t("titleZ") : t("titleX")}
          {meta.zNumber ? ` · ${t("zNumber", { number: meta.zNumber })}` : ""}
        </h2>
        <p>{report.kind === "Z" ? t("subtitleZ") : t("subtitleX")}</p>
      </header>

      <dl>
        <Row label={t("location")} value={meta.locationName} />
        <Row label={t("register")} value={meta.registerName} />
        <Row label={t("openedAt")} value={when(report.openedAt)} />
        <Row label={t("openedBy")} value={meta.openedByName} />
        {z ? <Row label={t("closedAt")} value={when(z.closedAt)} /> : null}
        {z && meta.closedByName ? <Row label={t("closedBy")} value={meta.closedByName} /> : null}
        {z ? null : <Row label={t("asOf")} value={when(report.asOf)} />}
      </dl>

      <Section title={t("sales")}>
        <Row label={t("saleCount")} value={report.saleCount} />
        {report.firstReceiptNumber ? (
          <Row
            label={t("receipts")}
            value={t("receiptsRange", {
              first: report.firstReceiptNumber,
              last: report.lastReceiptNumber ?? report.firstReceiptNumber,
            })}
          />
        ) : null}
        <Row label={t("grossSales")} value={money(report.grossSales)} />
        <Row label={t("discounts")} value={money(-report.discounts)} />
        <Row label={t("itemsSales")} value={money(report.itemsSales)} />
        {report.tips !== 0n ? <Row label={t("tips")} value={money(report.tips)} /> : null}
        {report.rounding !== 0n ? (
          <Row label={t("rounding")} value={money(report.rounding)} />
        ) : null}
        <Row label={t("salesTotal")} value={money(report.salesTotal)} strong testId="sales-total" />
      </Section>

      <Section title={t("refunds")}>
        <Row label={t("refundCount")} value={report.refundCount} />
        <Row label={t("refundsTotal")} value={money(-report.refunds.total)} />
        <Row label={t("netSales")} value={money(report.netSales)} strong testId="net-sales" />
      </Section>

      <Section title={t("tax")}>
        {report.taxByRate.map((rate) => (
          <div
            key={`${rate.taxTreatment}-${rate.vatRateBps}-${rate.cityTaxRateBps}`}
            className="mb-1"
          >
            <Row
              label={t("taxRow", {
                treatment: t(`treatments.${rate.taxTreatment}`),
                rate: pct(rate.vatRateBps),
              })}
              value={money(rate.gross)}
            />
            <Row label={<span className="pl-2">{t("taxNet")}</span>} value={money(rate.net)} />
            <Row label={<span className="pl-2">{t("vat")}</span>} value={money(rate.vat)} />
            {rate.cityTaxRateBps > 0 || rate.city !== 0n ? (
              <Row label={<span className="pl-2">{t("cityTax")}</span>} value={money(rate.city)} />
            ) : null}
          </div>
        ))}
        <Row label={t("vat")} value={money(report.tax.vat)} strong />
      </Section>

      <Section title={t("tenders")}>
        {report.tenders.map((row) => (
          <Row
            key={row.method}
            label={t(`methods.${row.method}`)}
            value={money(row.net)}
            testId={`tender-${row.method}`}
          />
        ))}
        <Row label={t("tendersTotal")} value={money(report.tendersTotal)} strong />
      </Section>

      <Section title={t("cash")}>
        <Row label={t("openingFloat")} value={money(report.cash.openingFloat)} />
        <Row label={t("cashSales")} value={money(report.cash.cashSales)} />
        <Row label={t("cashRefunds")} value={money(-report.cash.cashRefunds)} />
        <Row label={t("cashIn")} value={money(report.cash.cashIn)} />
        <Row label={t("cashOut")} value={money(-report.cash.cashOut)} />
        {hideExpected && !z ? (
          <Row label={t("expectedCash")} value={t("expectedHidden")} strong />
        ) : (
          <Row
            label={t("expectedCash")}
            value={money(report.cash.expected)}
            strong
            testId="expected-cash"
          />
        )}
      </Section>

      <Section title={t("items")}>
        <Row label={t("pieceCount")} value={report.items.pieceCount} />
        {report.items.measuredLineCount > 0 ? (
          <Row label={t("measuredLines")} value={report.items.measuredLineCount} />
        ) : null}
        {report.items.refundedPieceCount > 0 ? (
          <Row label={t("refundedPieces")} value={report.items.refundedPieceCount} />
        ) : null}
      </Section>

      <Section title={t("voids")}>
        {report.voids.length === 0 ? (
          <p>{t("voidsNone")}</p>
        ) : (
          <>
            {report.voids.map((v) => (
              <Row
                key={v.saleId}
                label={`${v.number} · ${t(`voidReasons.${v.reason}`)}`}
                value={money(v.totalAmount)}
              />
            ))}
            <Row label={t("voidedTotal")} value={money(report.voidedTotal)} strong />
          </>
        )}
      </Section>

      {movements ? (
        <Section title={t("movements")}>
          {movements.length === 0 ? (
            <p>{t("movementsNone")}</p>
          ) : (
            movements.map((m) => (
              <Row
                key={m.id}
                label={
                  <span>
                    {t(`types.${m.type}`)} · {m.reason}
                  </span>
                }
                value={money(m.type === "CASH_IN" ? m.amount : -m.amount)}
              />
            ))
          )}
        </Section>
      ) : null}

      {z ? (
        <Section title={t("closing")}>
          {MNT_DENOMINATIONS.filter((d) => (z.denominations[String(d)] ?? 0) > 0).map((d) => (
            <Row
              key={d}
              label={t("denominationRow", {
                value: format.number(d),
                count: z.denominations[String(d)] ?? 0,
              })}
              value={money(BigInt(d) * 100n * BigInt(z.denominations[String(d)] ?? 0))}
            />
          ))}
          <Row label={t("countedCash")} value={money(z.countedCash)} strong testId="counted-cash" />
          <Row label={t("expectedCash")} value={money(report.cash.expected)} />
          <Row
            label={`${t("variance")} · ${t(`classification.${z.classification}`)}`}
            value={money(variance)}
            strong
            {...(tone ? { tone } : {})}
            testId="variance"
          />
          {z.note ? (
            <p className="mt-1 break-words">
              {t("closingNote")}: {z.note}
            </p>
          ) : null}
        </Section>
      ) : null}
    </article>
  );
}
