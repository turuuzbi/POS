import { PackageCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { costText, qtyText } from "@/components/purchasing/lines-editor";
import { Button } from "@/components/ui/button";
import { can } from "@/domain/access";
import { canReceive, outstandingMilli } from "@/domain/purchasing";
import { requirePermission } from "@/server/auth/session";
import { listUserLocations } from "@/server/queries/locations";
import { getPurchaseOrder, listReceivableOrders, listSuppliers } from "@/server/queries/purchasing";
import { isUuid } from "../../ids";
import { ReceiptForm } from "../receipt-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.receipts");
  return { title: t("newTitle") };
}

export default async function NewReceiptPage({
  searchParams,
}: PageProps<"/purchasing/receipts/new">) {
  const user = await requirePermission("inventory.receive");
  const { order: orderParam } = await searchParams;
  const orderId = typeof orderParam === "string" ? orderParam : null;
  const showCosts = can(user, "reports.view_costs");
  const t = await getTranslations("purchasing.receipts");

  if (orderId) {
    if (!isUuid(orderId)) notFound();
    const order = await getPurchaseOrder(user, orderId);
    if (!order) notFound();
    if (!canReceive(order.status)) redirect(`/purchasing/orders/${order.id}`);
    return (
      <div className="space-y-6">
        <PageHeader
          title={t("newTitle")}
          description={t("forOrder", { number: order.number, supplier: order.supplier.name })}
        />
        <ReceiptForm
          mode="order"
          orderId={order.id}
          showCosts={showCosts}
          rows={order.lines.map((line) => ({
            id: line.id,
            label: line.label,
            sku: line.sku,
            unit: line.unit,
            orderedMilli: line.qtyOrderedMilli,
            receivedMilli: line.qtyReceivedMilli,
            outstandingMilli: outstandingMilli(line),
            cost: showCosts ? costText(line.unitCost) : "",
            qty: outstandingMilli(line) > 0 ? qtyText(outstandingMilli(line)) : "",
          }))}
        />
      </div>
    );
  }

  const [orders, suppliers, locations] = await Promise.all([
    listReceivableOrders(user),
    listSuppliers(),
    listUserLocations(user),
  ]);
  if (locations.length === 0) {
    return <EmptyState icon={PackageCheck} headingLevel={1} title={t("noLocation")} />;
  }
  return (
    <div className="space-y-8">
      <PageHeader title={t("newTitle")} description={t("adHocDescription")} />
      {orders.length > 0 ? (
        <section aria-labelledby="open-orders" className="space-y-3">
          <h2 id="open-orders" className="text-lg font-semibold">
            {t("againstOrder")}
          </h2>
          <ul className="divide-y rounded-lg border">
            {orders.map((order) => (
              <li key={order.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span>
                  <span className="font-medium">{order.number}</span>
                  <span className="text-sm text-muted-foreground">
                    {" · "}
                    {order.supplier.name} · {order.location.name}
                  </span>
                </span>
                <Button asChild size="sm" variant="outline">
                  <Link href={`/purchasing/receipts/new?order=${order.id}`}>
                    {t("receiveThis")}
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="ad-hoc" className="space-y-3">
        <h2 id="ad-hoc" className="text-lg font-semibold">
          {t("adHoc")}
        </h2>
        <ReceiptForm
          mode="adHoc"
          showCosts={showCosts}
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
          locations={locations}
        />
      </section>
    </div>
  );
}
