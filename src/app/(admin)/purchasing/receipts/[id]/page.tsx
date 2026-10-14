import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { PrintButton } from "@/components/purchasing/print-button";
import { PrintStyles } from "@/components/purchasing/print-styles";
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
import { lineTotal } from "@/domain/purchasing";
import { formatQty } from "@/domain/qty";
import { requirePermission } from "@/server/auth/session";
import { getReceipt } from "@/server/queries/purchasing";
import { isUuid } from "../../ids";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.receipts");
  return { title: t("detailTitle") };
}

export default async function ReceiptPage({ params }: PageProps<"/purchasing/receipts/[id]">) {
  const user = await requirePermission("inventory.receive");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [t, tl, format, receipt] = await Promise.all([
    getTranslations("purchasing.receipts"),
    getTranslations("purchasing.lines"),
    getFormatter(),
    getReceipt(user, id),
  ]);
  if (!receipt) notFound();
  const showCosts = can(user, "reports.view_costs");
  const canSeeOrder = can(user, "purchasing.manage");

  const facts = [
    [t("location"), receipt.location.name],
    [t("supplier"), receipt.supplier?.name ?? t("noSupplier")],
    [
      t("receivedAt"),
      format.dateTime(receipt.receivedAt, { dateStyle: "medium", timeStyle: "short" }),
    ],
    [t("receivedBy"), receipt.receivedBy.name],
  ] as const;

  return (
    <div className="space-y-6">
      <PrintStyles />
      <Link
        href="/purchasing/receipts"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("title")}
      </Link>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{receipt.number}</h1>
          {receipt.purchaseOrder ? (
            <p className="text-muted-foreground">
              {t("againstOrderNumber")}{" "}
              {canSeeOrder ? (
                <Link
                  href={`/purchasing/orders/${receipt.purchaseOrder.id}`}
                  className="underline underline-offset-4"
                >
                  {receipt.purchaseOrder.number}
                </Link>
              ) : (
                receipt.purchaseOrder.number
              )}
            </p>
          ) : (
            <p className="text-muted-foreground">{t("adHocShort")}</p>
          )}
        </div>
        <div className="print:hidden">
          <PrintButton label={t("print")} />
        </div>
      </div>
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {receipt.note ? (
        <p className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{receipt.note}</p>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{tl("product")}</TableHead>
              <TableHead className="text-right">{tl("qty")}</TableHead>
              {showCosts ? <TableHead className="text-right">{tl("unitCost")}</TableHead> : null}
              {showCosts ? <TableHead className="text-right">{tl("lineTotal")}</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {receipt.lines.map((line) => (
              <TableRow key={line.id}>
                <TableCell>
                  <span className="font-medium">{line.label}</span>
                  {line.sku ? (
                    <span className="block text-xs text-muted-foreground">{line.sku}</span>
                  ) : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatQty(line.qtyMilli, line.unit)}
                </TableCell>
                {showCosts ? (
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(line.unitCost)}
                  </TableCell>
                ) : null}
                {showCosts ? (
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(lineTotal(line.unitCost, line.qtyMilli))}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
          {showCosts ? (
            <TableBody>
              <TableRow>
                <TableCell colSpan={3} className="text-right font-semibold">
                  {tl("total")}
                </TableCell>
                <TableCell className="text-right font-semibold tabular-nums">
                  {formatMoney(receipt.total)}
                </TableCell>
              </TableRow>
            </TableBody>
          ) : null}
        </Table>
      </div>
    </div>
  );
}
