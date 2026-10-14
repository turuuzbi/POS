import { ArrowLeft, PackageCheck, Pencil } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getFormatter, getTranslations } from "next-intl/server";
import { ConfirmButton } from "@/components/form/confirm-button";
import { PrintButton } from "@/components/purchasing/print-button";
import { PrintStyles } from "@/components/purchasing/print-styles";
import { PurchaseOrderStatusBadge } from "@/components/purchasing/status-badge";
import { Button } from "@/components/ui/button";
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
import { canReceive, canTransition, isEditable, lineTotal } from "@/domain/purchasing";
import { formatQty } from "@/domain/qty";
import { transitionPurchaseOrderAction } from "@/server/actions/purchase-orders";
import { requirePermission } from "@/server/auth/session";
import { getPurchaseOrder } from "@/server/queries/purchasing";
import { isUuid } from "../../ids";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.orders");
  return { title: t("detailTitle") };
}

export default async function PurchaseOrderPage({ params }: PageProps<"/purchasing/orders/[id]">) {
  const user = await requirePermission("purchasing.manage");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [t, tc, format, order] = await Promise.all([
    getTranslations("purchasing.orders"),
    getTranslations("common"),
    getFormatter(),
    getPurchaseOrder(user, id),
  ]);
  if (!order) notFound();
  const showCosts = can(user, "reports.view_costs");
  const canWrite = showCosts && can(user, "purchasing.manage", order.locationId);
  const canBook = canReceive(order.status) && can(user, "inventory.receive", order.locationId);
  const date = (value: Date | null) =>
    value ? format.dateTime(value, { dateStyle: "medium" }) : tc("none");

  const facts = [
    [t("supplier"), order.supplier.name],
    [t("location"), order.location.name],
    [t("createdAt"), date(order.createdAt)],
    [t("createdBy"), order.createdBy.name],
    [t("orderedAt"), date(order.orderedAt)],
    [t("expectedAt"), date(order.expectedAt)],
  ] as const;

  return (
    <div className="space-y-6">
      <PrintStyles />
      <Link
        href="/purchasing/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground print:hidden"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("title")}
      </Link>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{order.number}</h1>
          <PurchaseOrderStatusBadge status={order.status} />
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <PrintButton label={t("print")} />
          {canWrite && isEditable(order.status) ? (
            <Button asChild variant="outline">
              <Link href={`/purchasing/orders/${order.id}/edit`}>
                <Pencil aria-hidden />
                {tc("edit")}
              </Link>
            </Button>
          ) : null}
          {canBook ? (
            <Button asChild>
              <Link href={`/purchasing/receipts/new?order=${order.id}`}>
                <PackageCheck aria-hidden />
                {t("receive")}
              </Link>
            </Button>
          ) : null}
          {canWrite && canTransition(order.status, "ORDERED") ? (
            <ConfirmButton
              action={transitionPurchaseOrderAction}
              input={{ id: order.id, to: "ORDERED" as const }}
              label={t("markOrdered")}
              description={t("markOrderedConfirm", { number: order.number })}
              successMessage={t("markedOrdered")}
              variant="secondary"
            />
          ) : null}
          {canWrite && order.status === "PARTIALLY_RECEIVED" ? (
            <ConfirmButton
              action={transitionPurchaseOrderAction}
              input={{ id: order.id, to: "RECEIVED" as const }}
              label={t("closeShort")}
              description={t("closeShortConfirm", { number: order.number })}
              successMessage={t("closed")}
            />
          ) : null}
          {canWrite && canTransition(order.status, "CANCELLED") ? (
            <ConfirmButton
              action={transitionPurchaseOrderAction}
              input={{ id: order.id, to: "CANCELLED" as const }}
              label={t("cancelOrder")}
              description={t("cancelConfirm", { number: order.number })}
              successMessage={t("cancelled")}
              destructive
              variant="ghost"
            />
          ) : null}
        </div>
      </div>

      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      {order.note ? (
        <p className="rounded-md bg-muted p-3 text-sm whitespace-pre-wrap">{order.note}</p>
      ) : null}

      <section aria-labelledby="po-lines" className="space-y-3">
        <h2 id="po-lines" className="text-lg font-semibold">
          {t("lines")}
        </h2>
        {order.lines.length === 0 ? (
          <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t("noLines")}
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("product")}</TableHead>
                  <TableHead className="text-right">{t("qtyOrdered")}</TableHead>
                  <TableHead className="text-right">{t("qtyReceived")}</TableHead>
                  {showCosts ? <TableHead className="text-right">{t("unitCost")}</TableHead> : null}
                  {showCosts ? (
                    <TableHead className="text-right">{t("lineTotal")}</TableHead>
                  ) : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {order.lines.map((line) => (
                  <TableRow key={line.id}>
                    <TableCell>
                      <span className="font-medium">{line.label}</span>
                      {line.sku ? (
                        <span className="block text-xs text-muted-foreground">{line.sku}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(line.qtyOrderedMilli, line.unit)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatQty(line.qtyReceivedMilli, line.unit)}
                    </TableCell>
                    {showCosts ? (
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(line.unitCost)}
                      </TableCell>
                    ) : null}
                    {showCosts ? (
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(lineTotal(line.unitCost, line.qtyOrderedMilli))}
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
              {showCosts ? (
                <TableBody>
                  <TableRow>
                    <TableCell colSpan={4} className="text-right font-semibold">
                      {t("total")}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatMoney(order.total)}
                    </TableCell>
                  </TableRow>
                </TableBody>
              ) : null}
            </Table>
          </div>
        )}
      </section>

      <section aria-labelledby="po-receipts" className="space-y-3 print:hidden">
        <h2 id="po-receipts" className="text-lg font-semibold">
          {t("receipts")}
        </h2>
        {order.receipts.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noReceipts")}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {order.receipts.map((receipt) => (
              <li key={receipt.id} className="flex items-center justify-between gap-2 p-3">
                <Link
                  href={`/purchasing/receipts/${receipt.id}`}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {receipt.number}
                </Link>
                <span className="text-sm text-muted-foreground">
                  {format.dateTime(receipt.receivedAt, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
