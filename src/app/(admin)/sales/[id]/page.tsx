import { ArrowLeft, ExternalLink } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import type * as React from "react";
import { PageHeader } from "@/components/app/page-header";
import { SaleStatusBadge } from "@/components/sales/status-badge";
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
import { formatRateBps } from "@/domain/receipt-layout";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { getSaleDetail } from "@/server/queries/sales";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("sales");
  return { title: t("detail.title") };
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="gap-4 py-4" role="region" aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id} className="text-base">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 sm:px-0">{children}</CardContent>
    </Card>
  );
}

function Facts({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 px-6 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="font-medium break-words">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export default async function SaleDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("reports.view");
  const { id } = await params;
  const detail = await getSaleDetail(user, id);
  if (!detail) notFound();
  const [t, tm, tu, tr, locale, format] = await Promise.all([
    getTranslations("sales.detail"),
    getTranslations("receipt.method"),
    getTranslations("receipt.unit"),
    getTranslations("receipt.refund.reasons"),
    getLocale(),
    getFormatter(),
  ]);
  const tv = await getTranslations("receipt.voidSlip.reasons");
  const { sale, status } = detail;
  const money = (amount: bigint) => formatMoney(amount, { locale });
  const when = (d: Date) => format.dateTime(d, { dateStyle: "medium", timeStyle: "short" });
  const credit = (amount: bigint) => `-${money(amount)}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("heading", { number: sale.number })}
        description={when(sale.occurredAt)}
        actions={<SaleStatusBadge status={status} />}
      />

      <div className="flex flex-wrap gap-2">
        <Link href="/sales" className={cn(buttonVariants({ variant: "ghost" }), "-ml-3")}>
          <ArrowLeft aria-hidden />
          {t("back")}
        </Link>
        <Link href={`/receipt/${sale.id}`} className={cn(buttonVariants({ variant: "outline" }))}>
          <ExternalLink aria-hidden />
          {t("openReceipt")}
        </Link>
        <Link
          href={`/r/${encodeURIComponent(sale.publicToken)}`}
          className={cn(buttonVariants({ variant: "outline" }))}
          data-testid="share-link"
        >
          <ExternalLink aria-hidden />
          {t("shareLink")}
        </Link>
        {sale.void ? (
          <Link
            href={`/receipt/void/${sale.id}`}
            className={cn(buttonVariants({ variant: "outline" }))}
          >
            {t("voidSlip")}
          </Link>
        ) : null}
      </div>

      <Section id="sale-info" title={t("info.title")}>
        <Facts
          items={[
            { label: t("info.location"), value: sale.location.name },
            { label: t("info.register"), value: `${sale.register.code} · ${sale.register.name}` },
            { label: t("info.cashier"), value: sale.cashier.name },
            { label: t("info.shift"), value: when(sale.shift.openedAt) },
            ...(sale.customer ? [{ label: t("info.customer"), value: sale.customer.name }] : []),
            ...(sale.buyerTaxId ? [{ label: t("info.buyerTaxId"), value: sale.buyerTaxId }] : []),
            ...(sale.note ? [{ label: t("info.note"), value: sale.note }] : []),
            { label: t("info.origin"), value: t(`origin.${sale.origin}`) },
            ...(sale.requiresReview
              ? [
                  {
                    label: t("info.review"),
                    value: sale.review ? t("info.reviewed") : t("info.needsReview"),
                  },
                ]
              : []),
          ]}
        />
      </Section>

      <Section id="sale-lines" title={t("lines.title")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("lines.no")}</TableHead>
              <TableHead>{t("lines.item")}</TableHead>
              <TableHead className="text-right">{t("lines.qty")}</TableHead>
              <TableHead className="text-right">{t("lines.price")}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{t("lines.vat")}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">
                {t("lines.discount")}
              </TableHead>
              <TableHead className="text-right">{t("lines.total")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sale.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>{line.lineNo}</TableCell>
                <TableCell className="min-w-40 whitespace-normal">
                  <div className="font-medium">{line.name}</div>
                  {line.sku ? (
                    <div className="text-xs text-muted-foreground">{line.sku}</div>
                  ) : null}
                  {line.modifiers.map((m) => (
                    <div key={m.name} className="text-xs text-muted-foreground">
                      {`+ ${m.name}`}
                    </div>
                  ))}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {formatQty(line.qtyMilli, line.unit, { locale })} {tu(line.unit)}
                </TableCell>
                <TableCell className="text-right whitespace-nowrap tabular-nums">
                  {money(line.unitPrice)}
                </TableCell>
                <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">
                  {money(line.vatAmount + line.cityTaxAmount)}
                </TableCell>
                <TableCell className="hidden text-right whitespace-nowrap tabular-nums sm:table-cell">
                  {line.discountAmount > 0n ? credit(line.discountAmount) : ""}
                </TableCell>
                <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                  {money(line.totalAmount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section id="sale-totals" title={t("totals.title")}>
          <dl className="space-y-2 px-6 text-sm">
            {(
              [
                [t("totals.items"), money(sale.itemsAmount)],
                ...(sale.discountAmount > 0n
                  ? [[t("totals.discount"), credit(sale.discountAmount)] as [string, string]]
                  : []),
                ...(sale.tipAmount > 0n
                  ? [[t("totals.tip"), money(sale.tipAmount)] as [string, string]]
                  : []),
                ...(sale.roundingAmount !== 0n
                  ? [[t("totals.rounding"), money(sale.roundingAmount)] as [string, string]]
                  : []),
              ] as [string, string][]
            ).map(([label, value]) => (
              <div key={label} className="flex justify-between gap-4">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="tabular-nums">{value}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-4 border-t pt-2 text-base font-semibold">
              <dt>{t("totals.total")}</dt>
              <dd className="tabular-nums">{money(sale.totalAmount)}</dd>
            </div>
          </dl>
        </Section>

        <Section id="sale-taxes" title={t("taxes.title")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("taxes.kind")}</TableHead>
                <TableHead className="text-right">{t("taxes.base")}</TableHead>
                <TableHead className="text-right">{t("taxes.vat")}</TableHead>
                <TableHead className="text-right">{t("taxes.cityTax")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.taxRows.map((row) => (
                <TableRow key={`${row.treatment}:${row.vatRateBps}:${row.cityTaxRateBps}`}>
                  <TableCell>
                    {row.treatment === "STANDARD"
                      ? t("taxes.vatRate", { rate: formatRateBps(row.vatRateBps, locale) })
                      : t(`taxes.treatment.${row.treatment}`)}
                    {row.cityTaxRateBps > 0
                      ? ` + ${t("taxes.cityRate", { rate: formatRateBps(row.cityTaxRateBps, locale) })}`
                      : ""}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.base)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.vat)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(row.cityTax)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      </div>

      {sale.discounts.length > 0 ? (
        <Section id="sale-discounts" title={t("discounts.title")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("discounts.scope")}</TableHead>
                <TableHead>{t("discounts.source")}</TableHead>
                <TableHead>{t("discounts.reason")}</TableHead>
                <TableHead>{t("discounts.approvedBy")}</TableHead>
                <TableHead className="text-right">{t("discounts.amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sale.discounts.map((d, i) => (
                <TableRow key={i}>
                  <TableCell>
                    {d.saleLine
                      ? t("discounts.onLine", { no: d.saleLine.lineNo })
                      : t("discounts.onCart")}
                  </TableCell>
                  <TableCell>{t(`discounts.sources.${d.source}`)}</TableCell>
                  <TableCell>{d.reason ?? ""}</TableCell>
                  <TableCell>{d.approvedBy?.name ?? ""}</TableCell>
                  <TableCell className="text-right tabular-nums">{credit(d.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      ) : null}

      <Section id="sale-payments" title={t("payments.title")}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("payments.method")}</TableHead>
              <TableHead>{t("payments.reference")}</TableHead>
              <TableHead className="text-right">{t("payments.tendered")}</TableHead>
              <TableHead className="text-right">{t("payments.change")}</TableHead>
              <TableHead className="text-right">{t("payments.amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sale.payments.map((p, i) => (
              <TableRow key={i}>
                <TableCell>{tm(p.method)}</TableCell>
                <TableCell>
                  {p.cardBrand && p.cardLast4
                    ? `${p.cardBrand} ****${p.cardLast4}`
                    : (p.reference ?? "")}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.tendered !== null ? money(p.tendered) : ""}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {p.change > 0n ? money(p.change) : ""}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {money(p.amount)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section id="sale-approvals" title={t("approvals.title")}>
          {detail.approvals.length === 0 ? (
            <p className="px-6 text-sm text-muted-foreground">{t("approvals.none")}</p>
          ) : (
            <ul className="space-y-2 px-6 text-sm">
              {detail.approvals.map((a, i) => (
                <li key={i} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {t(`approvals.kinds.${a.kind}`)}
                    {a.ref ? ` · ${a.ref}` : ""}
                  </span>
                  <span className="font-medium">{a.approverName}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="sale-fiscal" title={t("fiscal.title")}>
          <Facts
            items={[
              {
                label: t("fiscal.status"),
                value: t(`fiscal.statuses.${sale.fiscalReceipt?.status ?? "NONE"}`),
              },
              ...(sale.fiscalReceipt?.lotteryCode
                ? [{ label: t("fiscal.lottery"), value: sale.fiscalReceipt.lotteryCode }]
                : []),
              ...(sale.fiscalReceipt?.issuedAt
                ? [{ label: t("fiscal.issuedAt"), value: when(sale.fiscalReceipt.issuedAt) }]
                : []),
            ]}
          />
        </Section>
      </div>

      {sale.void ? (
        <Section id="sale-void" title={t("void.title")}>
          <Facts
            items={[
              { label: t("void.when"), value: when(sale.void.createdAt) },
              { label: t("void.reason"), value: tv(sale.void.reason) },
              { label: t("void.by"), value: sale.void.voidedBy.name },
              ...(sale.void.approvedBy
                ? [{ label: t("void.approvedBy"), value: sale.void.approvedBy.name }]
                : []),
              ...(sale.void.note ? [{ label: t("void.note"), value: sale.void.note }] : []),
              { label: t("void.amount"), value: money(sale.totalAmount) },
            ]}
          />
        </Section>
      ) : null}

      {sale.refunds.length > 0 ? (
        <Section id="sale-refunds" title={t("refunds.title")}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("refunds.number")}</TableHead>
                <TableHead>{t("refunds.date")}</TableHead>
                <TableHead>{t("refunds.reason")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("refunds.by")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("refunds.approvedBy")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("refunds.paidBack")}</TableHead>
                <TableHead className="text-right">{t("refunds.amount")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sale.refunds.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <Link
                      href={`/receipt/refund/${r.id}`}
                      className="inline-flex min-h-11 items-center font-medium underline-offset-4 hover:underline"
                    >
                      {r.number}
                    </Link>
                    {r.exchangeSale ? (
                      <div className="text-xs text-muted-foreground">
                        {t("refunds.exchange", { number: r.exchangeSale.number })}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{when(r.occurredAt)}</TableCell>
                  <TableCell>{tr(r.reason)}</TableCell>
                  <TableCell className="hidden sm:table-cell">{r.processedBy.name}</TableCell>
                  <TableCell className="hidden sm:table-cell">{r.approvedBy?.name ?? ""}</TableCell>
                  <TableCell className="hidden md:table-cell">
                    {r.payments.map((p) => `${tm(p.method)} ${money(p.amount)}`).join(", ")}
                  </TableCell>
                  <TableCell className="text-right font-medium whitespace-nowrap tabular-nums">
                    {credit(r.totalAmount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="px-6 pt-3 text-sm text-muted-foreground">
            {t("refunds.total", { amount: money(detail.refundedAmount) })}
          </p>
        </Section>
      ) : null}

      <Section id="sale-audit" title={t("audit.title")}>
        {detail.audit.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">{t("audit.none")}</p>
        ) : (
          <ul className="space-y-2 px-6 text-sm">
            {detail.audit.map((a) => (
              <li key={a.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{a.action}</code>{" "}
                  {a.actorName ?? t("audit.system")}
                </span>
                <time dateTime={a.createdAt.toISOString()} className="text-muted-foreground">
                  {when(a.createdAt)}
                </time>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
