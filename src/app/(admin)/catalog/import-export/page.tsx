import { Download, FileDown } from "lucide-react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/app/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { can } from "@/domain/access";
import { templateCsv } from "@/domain/csv-catalog";
import { requirePermission } from "@/server/auth/session";
import { ImportForm } from "./import-form";

export const maxDuration = 60;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("importExport");
  return { title: t("title") };
}

export default async function ImportExportPage() {
  const user = await requirePermission("catalog.edit");
  const t = await getTranslations("importExport");
  const withCosts = can(user, "reports.view_costs");
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(templateCsv(withCosts))}`;

  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} description={t("description")} />

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("export.heading")}</CardTitle>
            <CardDescription>{t("export.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button asChild>
              <a href="/api/catalog/export" download>
                <Download aria-hidden />
                {t("export.button")}
              </a>
            </Button>
            {withCosts ? null : (
              <p className="text-sm text-muted-foreground">{t("export.costsNote")}</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("template.heading")}</CardTitle>
            <CardDescription>{t("template.description")}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <a href={template} download="products-template.csv">
                <FileDown aria-hidden />
                {t("template.button")}
              </a>
            </Button>
          </CardContent>
        </Card>
      </div>

      <ImportForm />
    </div>
  );
}
