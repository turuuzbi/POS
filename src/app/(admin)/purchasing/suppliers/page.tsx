import { Plus, Truck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
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
import { cn } from "@/lib/utils";
import { deleteSupplierAction, setSupplierActiveAction } from "@/server/actions/suppliers";
import { requirePermission } from "@/server/auth/session";
import { listSuppliers } from "@/server/queries/purchasing";
import { SupplierDialog } from "./supplier-dialog";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.suppliers");
  return { title: t("title") };
}

const LIST_HEADING_ID = "supplier-list";

export default async function SuppliersPage() {
  await requirePermission("purchasing.manage");
  const [t, tc, suppliers] = await Promise.all([
    getTranslations("purchasing.suppliers"),
    getTranslations("common"),
    listSuppliers({ includeInactive: true }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <SupplierDialog
            trigger={
              <Button>
                <Plus aria-hidden />
                {t("new")}
              </Button>
            }
          />
        }
      />

      <section aria-labelledby={LIST_HEADING_ID} className="space-y-3">
        <h2 id={LIST_HEADING_ID} tabIndex={-1} className="sr-only">
          {t("listHeading")}
        </h2>
        {suppliers.length === 0 ? (
          <EmptyState icon={Truck} title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t("contact")}</TableHead>
                  <TableHead className="hidden md:table-cell">{t("products")}</TableHead>
                  <TableHead>{tc("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {suppliers.map((supplier) => (
                  <TableRow key={supplier.id} className={cn(!supplier.isActive && "opacity-70")}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <Link
                          href={`/purchasing/suppliers/${supplier.id}`}
                          className="font-medium underline-offset-4 hover:underline"
                        >
                          {supplier.name}
                        </Link>
                        {supplier.isActive ? null : (
                          <Badge variant="secondary">{tc("archived")}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground sm:table-cell">
                      {[supplier.contactName, supplier.phone].filter(Boolean).join(" · ") ||
                        tc("none")}
                    </TableCell>
                    <TableCell className="hidden text-muted-foreground md:table-cell">
                      {supplier._count.items}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <SupplierDialog
                          supplier={supplier}
                          trigger={
                            <Button variant="outline" size="sm">
                              {tc("edit")}
                            </Button>
                          }
                        />
                        {supplier.isActive ? (
                          <ConfirmButton
                            action={setSupplierActiveAction}
                            input={{ id: supplier.id, isActive: false }}
                            label={tc("archive")}
                            description={t("archiveConfirm", { name: supplier.name })}
                            successMessage={t("archived")}
                            size="sm"
                          />
                        ) : (
                          <ConfirmButton
                            action={setSupplierActiveAction}
                            input={{ id: supplier.id, isActive: true }}
                            label={tc("restore")}
                            description={supplier.name}
                            successMessage={t("restored")}
                            size="sm"
                          />
                        )}
                        {supplier._count.purchaseOrders + supplier._count.goodsReceipts === 0 ? (
                          <ConfirmButton
                            action={deleteSupplierAction}
                            input={{ id: supplier.id }}
                            label={tc("delete")}
                            description={tc("confirmDelete", { name: supplier.name })}
                            successMessage={tc("deleted")}
                            destructive
                            focusAfterId={LIST_HEADING_ID}
                            variant="ghost"
                            size="sm"
                          />
                        ) : null}
                      </div>
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
