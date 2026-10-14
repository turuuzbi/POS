import { FolderTree, Plus } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { TILE_COLORS, isTileColor } from "@/components/catalog/tile-colors";
import { ConfirmButton } from "@/components/form/confirm-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { hasPermission } from "@/domain/permissions";
import { cn } from "@/lib/utils";
import { deleteCategoryAction, setCategoryActiveAction } from "@/server/actions/categories";
import { requirePermission } from "@/server/auth/session";
import { listCategoryTree } from "@/server/queries/catalog";
import { CategoryDialog } from "./category-dialog";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("categories");
  return { title: t("title") };
}

const LIST_HEADING_ID = "category-list";

export default async function CategoriesPage() {
  const user = await requirePermission("catalog.view");
  const canEdit = hasPermission(user.role, "catalog.edit");
  const [t, tc, categories] = await Promise.all([
    getTranslations("categories"),
    getTranslations("common"),
    listCategoryTree({ includeInactive: true }),
  ]);
  const parents = categories.filter((c) => c.isActive).map((c) => ({ id: c.id, path: c.path }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          canEdit ? (
            <CategoryDialog
              parents={parents}
              trigger={
                <Button>
                  <Plus aria-hidden />
                  {t("new")}
                </Button>
              }
            />
          ) : null
        }
      />

      <section aria-labelledby={LIST_HEADING_ID} className="space-y-3">
        <h2 id={LIST_HEADING_ID} tabIndex={-1} className="sr-only">
          {t("listHeading")}
        </h2>
        {categories.length === 0 ? (
          <EmptyState icon={FolderTree} title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("products")}</TableHead>
                  <TableHead>{tc("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {categories.map((category) => (
                  <TableRow key={category.id} className={cn(!category.isActive && "opacity-70")}>
                    <TableCell>
                      <div
                        className="flex items-center gap-2"
                        style={{ paddingInlineStart: `${category.depth * 1.25}rem` }}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "size-3 shrink-0 rounded-full",
                            isTileColor(category.color)
                              ? TILE_COLORS[category.color]
                              : "border bg-muted",
                          )}
                        />
                        <span className="font-medium">{category.name}</span>
                        {category.isActive ? null : (
                          <Badge variant="secondary">{tc("archived")}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t("productCount", { count: category._count.products })}
                    </TableCell>
                    <TableCell>
                      {canEdit ? (
                        <div className="flex flex-wrap gap-2">
                          <CategoryDialog
                            category={category}
                            parents={parents}
                            trigger={
                              <Button variant="outline" size="sm">
                                {tc("edit")}
                              </Button>
                            }
                          />
                          {category.isActive ? (
                            <ConfirmButton
                              action={setCategoryActiveAction}
                              input={{ id: category.id, isActive: false }}
                              label={tc("archive")}
                              description={t("archiveConfirm", { name: category.name })}
                              successMessage={t("archived")}
                              size="sm"
                            />
                          ) : (
                            <ConfirmButton
                              action={setCategoryActiveAction}
                              input={{ id: category.id, isActive: true }}
                              label={tc("restore")}
                              description={category.name}
                              successMessage={t("restored")}
                              size="sm"
                            />
                          )}
                          <ConfirmButton
                            action={deleteCategoryAction}
                            input={{ id: category.id }}
                            label={tc("delete")}
                            description={tc("confirmDelete", { name: category.name })}
                            successMessage={tc("deleted")}
                            destructive
                            focusAfterId={LIST_HEADING_ID}
                            variant="ghost"
                            size="sm"
                          />
                        </div>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        )}
      </section>
    </div>
  );
}
