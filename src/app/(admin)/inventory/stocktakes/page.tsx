import { ClipboardList, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
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
import { requirePermission } from "@/server/auth/session";
import { listUserLocations } from "@/server/queries/locations";
import { listCountCategories, listStocktakes } from "@/server/queries/stocktakes";
import { NewStocktakeDialog } from "./new-stocktake-dialog";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("stocktakes");
  return { title: t("title") };
}

const STATUS_VARIANT = {
  IN_PROGRESS: "default",
  COMPLETED: "success",
  CANCELLED: "secondary",
} as const;

export default async function StocktakesPage() {
  const user = await requirePermission("inventory.stocktake");
  const [t, locations, categories, stocktakes] = await Promise.all([
    getTranslations("stocktakes"),
    listUserLocations(user),
    listCountCategories(),
    listStocktakes(user),
  ]);
  const dateFormat = new Intl.DateTimeFormat(await getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          locations.length > 0 ? (
            <NewStocktakeDialog
              locations={locations}
              categories={categories}
              defaultLocationId={null}
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

      <section aria-labelledby="stocktake-list" className="space-y-3">
        <h2 id="stocktake-list" className="sr-only">
          {t("listHeading")}
        </h2>
        {stocktakes.length === 0 ? (
          <EmptyState icon={ClipboardList} title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("number")}</TableHead>
                  <TableHead>{t("location")}</TableHead>
                  <TableHead>{t("scope")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("progress")}</TableHead>
                  <TableHead>{t("startedAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stocktakes.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        href={`/inventory/stocktakes/${row.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.number}
                      </Link>
                    </TableCell>
                    <TableCell>{row.location.name}</TableCell>
                    <TableCell>{row.category?.name ?? t("fullCount")}</TableCell>
                    <TableCell>
                      <Badge variant={STATUS_VARIANT[row.status]}>{t(`status${row.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {t("progressValue", { counted: row.countedLines, total: row._count.lines })}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {dateFormat.format(row.startedAt)}
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
