import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/app/page-header";
import { ConfirmButton } from "@/components/form/confirm-button";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { hasPermission } from "@/domain/permissions";
import { setProductActiveAction } from "@/server/actions/products";
import { requirePermission } from "@/server/auth/session";
import { getProductForEdit, productFormOptions } from "@/server/queries/products";
import { DeleteProductButton } from "../delete-product-button";
import { draftFromProduct } from "../draft";
import { ProductForm } from "../product-form";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("products");
  return { title: t("editTitle") };
}

export default async function EditProductPage({ params }: Props) {
  const { id } = await params;
  const user = await requirePermission("catalog.view");
  if (!UUID.test(id)) notFound();
  const canEdit = hasPermission(user.role, "catalog.edit");
  const found = await getProductForEdit(id, user);
  if (!found) notFound();
  const { product, onHand } = found;

  const [t, tc, locale, options] = await Promise.all([
    getTranslations("products"),
    getTranslations("common"),
    getLocale(),
    productFormOptions({ categoryId: product.categoryId, taxClassId: product.taxClassId }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={product.name}
        description={canEdit ? t("editDescription") : t("readOnlyDescription")}
        actions={
          <>
            <Link href="/catalog/products" className={buttonVariants({ variant: "outline" })}>
              {tc("back")}
            </Link>
            {canEdit ? (
              <>
                <ConfirmButton
                  action={setProductActiveAction}
                  input={{ id: product.id, isActive: !product.isActive }}
                  label={product.isActive ? tc("archive") : tc("restore")}
                  description={
                    product.isActive ? t("archiveConfirm", { name: product.name }) : product.name
                  }
                  successMessage={product.isActive ? t("archived") : t("restored")}
                />
                <DeleteProductButton id={product.id} name={product.name} />
              </>
            ) : null}
          </>
        }
      />
      {product.isActive ? null : <Badge variant="secondary">{tc("archived")}</Badge>}
      {canEdit ? (
        <ProductForm
          // Fresh form state after every save (variants are touched by each save; an image change is not).
          key={`${product.id}-${product.variants.map((v) => v.updatedAt.getTime()).join("-")}`}
          initial={draftFromProduct(product, onHand)}
          categories={options.categories}
          taxClasses={options.taxClasses}
          canViewCosts={hasPermission(user.role, "reports.view_costs")}
          locale={locale}
        />
      ) : (
        <p className="text-muted-foreground">{t("readOnlyHint")}</p>
      )}
    </div>
  );
}
