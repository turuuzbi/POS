import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Truck } from "lucide-react";
import { requirePermission } from "@/server/auth/session";
import { listUserLocations } from "@/server/queries/locations";
import { listSuppliers } from "@/server/queries/purchasing";
import { PurchaseOrderForm } from "../po-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.orders");
  return { title: t("createTitle") };
}

export default async function NewPurchaseOrderPage() {
  const user = await requirePermission("purchasing.manage");
  await requirePermission("reports.view_costs");
  const [t, suppliers, locations] = await Promise.all([
    getTranslations("purchasing.orders"),
    listSuppliers(),
    listUserLocations(user),
  ]);
  if (suppliers.length === 0 || locations.length === 0) {
    return (
      <EmptyState
        icon={Truck}
        headingLevel={1}
        title={t("needSupplier")}
        description={t("needSupplierDescription")}
      />
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t("createTitle")} description={t("description")} />
      <PurchaseOrderForm
        initial={{
          supplierId: "",
          locationId: locations[0]!.id,
          expectedAt: "",
          note: "",
          lines: [],
        }}
        suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
        locations={locations}
      />
    </div>
  );
}
