import { ImageIcon, Package, Plus, Search } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
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
import { hasPermission } from "@/domain/permissions";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { listCategoryTree } from "@/server/queries/catalog";
import { listProducts, PRODUCT_STATUSES, type ProductStatus } from "@/server/queries/products";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("products");
  return { title: t("title") };
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) ?? "";

export default async function ProductsPage({ searchParams }: { searchParams: SearchParams }) {
  const user = await requirePermission("catalog.view");
  const canEdit = hasPermission(user.role, "catalog.edit");
  const params = await searchParams;
  const q = first(params.q).slice(0, 100);
  const categoryId = /^[0-9a-f-]{36}$/.test(first(params.category)) ? first(params.category) : "";
  const statusParam = first(params.status);
  const status: ProductStatus = (PRODUCT_STATUSES as readonly string[]).includes(statusParam)
    ? (statusParam as ProductStatus)
    : "active";
  const page = Math.max(1, Number.parseInt(first(params.page), 10) || 1);

  const [t, tc, tu, locale, categories, result] = await Promise.all([
    getTranslations("products"),
    getTranslations("common"),
    getTranslations("units"),
    getLocale(),
    listCategoryTree({ includeInactive: true }),
    listProducts({ q, categoryId: categoryId || undefined, status, page }, user),
  ]);

  const href = (nextPage: number) => {
    const search = new URLSearchParams();
    if (q) search.set("q", q);
    if (categoryId) search.set("category", categoryId);
    if (status !== "active") search.set("status", status);
    if (nextPage > 1) search.set("page", String(nextPage));
    const qs = search.toString();
    return `/catalog/products${qs ? `?${qs}` : ""}`;
  };
  const filtered = Boolean(q || categoryId || status !== "active");

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canEdit ? (
            <Link href="/catalog/products/new" className={buttonVariants()}>
              <Plus aria-hidden />
              {t("new")}
            </Link>
          ) : null
        }
      />

      <form
        method="get"
        action="/catalog/products"
        role="search"
        aria-label={t("filters")}
        className="grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto]"
      >
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            name="q"
            defaultValue={q}
            type="search"
            className="pl-9"
            aria-label={t("search")}
            placeholder={t("searchPlaceholder")}
            maxLength={100}
          />
        </div>
        <NativeSelect name="category" defaultValue={categoryId} aria-label={t("category")}>
          <option value="">{t("allCategories")}</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.path}
            </option>
          ))}
        </NativeSelect>
        <NativeSelect name="status" defaultValue={status} aria-label={t("status")}>
          {PRODUCT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`statuses.${s}`)}
            </option>
          ))}
        </NativeSelect>
        <Button type="submit">{t("applyFilters")}</Button>
      </form>

      <section aria-labelledby="product-list" className="space-y-3">
        <h2 id="product-list" className="sr-only">
          {t("listHeading")}
        </h2>
        {result.rows.length === 0 ? (
          <EmptyState
            icon={Package}
            title={filtered ? t("emptyFiltered") : t("empty")}
            description={filtered ? t("emptyFilteredDescription") : t("emptyDescription")}
            action={
              filtered ? (
                <Link href="/catalog/products" className={buttonVariants({ variant: "outline" })}>
                  {t("clearFilters")}
                </Link>
              ) : canEdit ? (
                <Link href="/catalog/products/new" className={buttonVariants()}>
                  {t("new")}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("category")}</TableHead>
                  <TableHead className="text-right">{t("price")}</TableHead>
                  {result.locations.map((location) => (
                    <TableHead key={location.id} className="text-right">
                      <span title={location.name}>
                        {t("onHandAt", { location: location.code })}
                      </span>
                    </TableHead>
                  ))}
                  <TableHead>{tc("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.map((row) => (
                  <TableRow key={row.id} className={cn(!row.isActive && "opacity-70")}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-muted">
                          {row.imageUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element -- user upload
                            <img
                              src={row.imageUrl}
                              alt=""
                              className="size-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <ImageIcon className="size-4 text-muted-foreground" aria-hidden />
                          )}
                        </div>
                        <div className="min-w-0">
                          <Link
                            href={`/catalog/products/${row.id}`}
                            className="font-medium hover:underline focus-visible:underline"
                          >
                            {row.name}
                          </Link>
                          <p className="text-xs text-muted-foreground">
                            {[
                              row.firstSku,
                              row.variantCount > 1
                                ? t("variantCount", { count: row.variantCount })
                                : null,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </p>
                        </div>
                        {row.isActive ? null : <Badge variant="secondary">{tc("archived")}</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.category ?? tc("none")}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap tabular-nums">
                      {row.minPrice === row.maxPrice
                        ? formatMoney(row.minPrice, { locale })
                        : `${formatMoney(row.minPrice, { locale, symbol: false })} – ${formatMoney(row.maxPrice, { locale })}`}
                    </TableCell>
                    {result.locations.map((location) => (
                      <TableCell
                        key={location.id}
                        className="text-right whitespace-nowrap tabular-nums"
                      >
                        {row.trackStock
                          ? `${formatQty(row.onHand[location.id] ?? 0, row.unit, { locale })} ${tu(row.unit)}`
                          : tc("none")}
                      </TableCell>
                    ))}
                    <TableCell>
                      <Link
                        href={`/catalog/products/${row.id}`}
                        className={buttonVariants({ variant: "outline", size: "sm" })}
                      >
                        {canEdit ? tc("edit") : t("view")}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}

        {result.pages > 1 ? (
          <nav aria-label={t("pagination")} className="flex items-center justify-between gap-3">
            {result.page > 1 ? (
              <Link
                href={href(result.page - 1)}
                className={buttonVariants({ variant: "outline" })}
                rel="prev"
              >
                {tc("previous")}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-sm text-muted-foreground" aria-live="polite">
              {tc("pageOf", { page: result.page, pages: result.pages })} ·{" "}
              {t("total", { count: result.total })}
            </span>
            {result.page < result.pages ? (
              <Link
                href={href(result.page + 1)}
                className={buttonVariants({ variant: "outline" })}
                rel="next"
              >
                {tc("next")}
              </Link>
            ) : (
              <span />
            )}
          </nav>
        ) : null}
      </section>
    </div>
  );
}
