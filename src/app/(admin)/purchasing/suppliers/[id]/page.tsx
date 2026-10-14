import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { can } from "@/domain/access";
import { requirePermission } from "@/server/auth/session";
import { getSupplier } from "@/server/queries/purchasing";
import { isUuid } from "../../ids";
import { SupplierItems } from "./supplier-items";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.suppliers");
  return { title: t("title") };
}

export default async function SupplierPage({ params }: PageProps<"/purchasing/suppliers/[id]">) {
  const user = await requirePermission("purchasing.manage");
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [t, ti, tc, supplier] = await Promise.all([
    getTranslations("purchasing.suppliers"),
    getTranslations("purchasing.supplierItems"),
    getTranslations("common"),
    getSupplier(id),
  ]);
  if (!supplier) notFound();
  const showCosts = can(user, "reports.view_costs");

  const details = [
    [t("contactName"), supplier.contactName],
    [t("phone"), supplier.phone],
    [t("email"), supplier.email],
    [t("taxId"), supplier.taxId],
    [t("address"), supplier.address],
    [t("notes"), supplier.notes],
  ] as const;

  return (
    <div className="space-y-6">
      <Link
        href="/purchasing/suppliers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden />
        {t("title")}
      </Link>
      <PageHeader
        title={supplier.name}
        description={supplier.isActive ? undefined : tc("archived")}
        actions={supplier.isActive ? null : <Badge variant="secondary">{tc("archived")}</Badge>}
      />
      <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
        {details.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="break-words">{value || tc("none")}</dd>
          </div>
        ))}
      </dl>
      <section aria-labelledby="supplier-items" className="space-y-3">
        <h2 id="supplier-items" className="text-lg font-semibold">
          {ti("title")}
        </h2>
        <p className="text-sm text-muted-foreground">{ti("description")}</p>
        <SupplierItems
          supplierId={supplier.id}
          showCosts={showCosts}
          items={supplier.items.map((item) => ({
            variantId: item.variantId,
            label: item.label,
            sku: item.sku,
            supplierSku: item.supplierSku,
            cost: showCosts ? item.cost : null,
            isPreferred: item.isPreferred,
          }))}
        />
      </section>
    </div>
  );
}
