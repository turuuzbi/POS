import { Percent, Plus } from "lucide-react";
import type { Metadata } from "next";
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
import { setTaxClassActiveAction } from "@/server/actions/tax-classes";
import { requirePermission } from "@/server/auth/session";
import { listTaxClassesWithUsage } from "@/server/queries/tax-classes";
import { bpsToPercent } from "./percent";
import { TaxClassDialog } from "./tax-class-dialog";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("taxClasses");
  return { title: t("title") };
}

const LIST_HEADING_ID = "tax-class-list";

export default async function TaxClassesPage() {
  await requirePermission("settings.manage");
  const [t, tc, classes] = await Promise.all([
    getTranslations("taxClasses"),
    getTranslations("common"),
    listTaxClassesWithUsage(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <TaxClassDialog
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
        {classes.length === 0 ? (
          <EmptyState icon={Percent} title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("name")}</TableHead>
                  <TableHead>{t("treatment")}</TableHead>
                  <TableHead className="text-end">{t("vatRate")}</TableHead>
                  <TableHead className="text-end">{t("cityTaxRate")}</TableHead>
                  <TableHead>{t("products")}</TableHead>
                  <TableHead>{tc("actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {classes.map((taxClass) => (
                  <TableRow key={taxClass.id} className={cn(!taxClass.isActive && "opacity-70")}>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{taxClass.name}</span>
                        {taxClass.isDefault ? <Badge>{t("defaultBadge")}</Badge> : null}
                        {taxClass.isActive ? null : (
                          <Badge variant="secondary">{tc("archived")}</Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>{t(`treatments.${taxClass.treatment}`)}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {bpsToPercent(taxClass.vatRateBps)}%
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {bpsToPercent(taxClass.cityTaxRateBps)}%
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t("productCount", { count: taxClass._count.products })}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <TaxClassDialog
                          taxClass={taxClass}
                          trigger={
                            <Button variant="outline" size="sm">
                              {tc("edit")}
                            </Button>
                          }
                        />
                        {taxClass.isActive ? (
                          <ConfirmButton
                            action={setTaxClassActiveAction}
                            input={{ id: taxClass.id, isActive: false }}
                            label={tc("archive")}
                            description={t("archiveConfirm", { name: taxClass.name })}
                            successMessage={t("archived")}
                            size="sm"
                          />
                        ) : (
                          <ConfirmButton
                            action={setTaxClassActiveAction}
                            input={{ id: taxClass.id, isActive: true }}
                            label={tc("restore")}
                            description={taxClass.name}
                            successMessage={t("restored")}
                            size="sm"
                          />
                        )}
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
