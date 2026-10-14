import type { Metadata } from "next";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { hasPermission } from "@/domain/permissions";
import { requirePermission } from "@/server/auth/session";
import { productFormOptions } from "@/server/queries/products";
import { Package } from "lucide-react";
import { newProductDraft } from "../draft";
import { ProductForm } from "../product-form";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("products");
  return { title: t("createTitle") };
}

export default async function NewProductPage() {
  const user = await requirePermission("catalog.edit");
  const [t, locale, options] = await Promise.all([
    getTranslations("products"),
    getLocale(),
    productFormOptions(),
  ]);
  const taxClassId = options.defaultTaxClassId ?? options.taxClasses[0]?.id;

  return (
    <div className="space-y-6">
      <PageHeader title={t("createTitle")} description={t("formDescription")} />
      {taxClassId ? (
        <ProductForm
          initial={newProductDraft(taxClassId)}
          categories={options.categories}
          taxClasses={options.taxClasses}
          canViewCosts={hasPermission(user.role, "reports.view_costs")}
          locale={locale}
        />
      ) : (
        <EmptyState icon={Package} title={t("noTaxClasses")} description={t("noTaxClassesHint")} />
      )}
    </div>
  );
}
