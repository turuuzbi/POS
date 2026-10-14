import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/app/page-header";
import { costText, qtyText } from "@/components/purchasing/line-text";
import { isEditable } from "@/domain/purchasing";
import { requirePermission } from "@/server/auth/session";
import { listUserLocations } from "@/server/queries/locations";
import { getPurchaseOrder, listSuppliers } from "@/server/queries/purchasing";
import { isUuid } from "../../../ids";
import { PurchaseOrderForm } from "../../po-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.orders");
  return { title: t("editTitle") };
}

export default async function EditPurchaseOrderPage({
  params,
}: PageProps<"/purchasing/orders/[id]/edit">) {
  const user = await requirePermission("purchasing.manage");
  await requirePermission("reports.view_costs");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [t, order, suppliers, locations] = await Promise.all([
    getTranslations("purchasing.orders"),
    getPurchaseOrder(user, id),
    listSuppliers(),
    listUserLocations(user),
  ]);
  if (!order) notFound();
  if (!isEditable(order.status)) redirect(`/purchasing/orders/${id}`);
  // An archived supplier stays selectable on its own draft so the form still shows it.
  const supplierOptions = suppliers.some((s) => s.id === order.supplierId)
    ? suppliers
    : [...suppliers, order.supplier];

  return (
    <div className="space-y-6">
      <PageHeader title={`${t("editTitle")} · ${order.number}`} description={t("description")} />
      <PurchaseOrderForm
        initial={{
          id: order.id,
          supplierId: order.supplierId,
          locationId: order.locationId,
          expectedAt: order.expectedAt?.toISOString().slice(0, 10) ?? "",
          note: order.note ?? "",
          lines: order.lines.map((l) => ({
            key: l.variantId,
            variantId: l.variantId,
            label: l.label,
            sku: l.sku,
            unit: l.unit,
            qty: qtyText(l.qtyOrderedMilli),
            cost: costText(l.unitCost),
          })),
        }}
        suppliers={supplierOptions.map((s) => ({ id: s.id, name: s.name }))}
        locations={locations}
      />
    </div>
  );
}
