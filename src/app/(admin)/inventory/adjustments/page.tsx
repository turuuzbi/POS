import { ClipboardList, MapPinOff, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { Pager } from "@/components/inventory/pager";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { listUserLocations } from "@/server/queries/locations";
import { listAdjustments } from "@/server/queries/stock";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("adjustments");
  return { title: t("title") };
}

const first = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value[0] : value) || undefined;

const shortId = (id: string) => id.slice(-8).toUpperCase();

export default async function AdjustmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("inventory.adjust");
  const sp = await searchParams;
  const [t, format, locations] = await Promise.all([
    getTranslations("adjustments"),
    getFormatter(),
    listUserLocations(user),
  ]);
  const locationId = locations.find((l) => l.id === first(sp.location))?.id;
  const { rows, page, pages } = await listAdjustments(user, {
    locationId,
    page: Number(first(sp.page)) || 1,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          locations.length > 0 ? (
            <Link href="/inventory/adjustments/new" className={cn(buttonVariants())}>
              <Plus aria-hidden />
              {t("new")}
            </Link>
          ) : null
        }
      />

      {locations.length === 0 ? (
        <EmptyState icon={MapPinOff} title={t("noLocations")} />
      ) : (
        <>
          {locations.length > 1 ? (
            <form method="get" className="flex items-end gap-3" role="search">
              <div className="flex flex-col gap-2 sm:w-56">
                <Label htmlFor="adj-filter-location">{t("location")}</Label>
                <NativeSelect
                  id="adj-filter-location"
                  name="location"
                  defaultValue={locationId ?? ""}
                >
                  <option value="">{t("all")}</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              <Button type="submit">{t("filter")}</Button>
            </form>
          ) : null}

          <section aria-labelledby="adj-list" className="space-y-3">
            <h2 id="adj-list" className="sr-only">
              {t("listHeading")}
            </h2>
            {rows.length === 0 ? (
              <EmptyState
                icon={ClipboardList}
                title={t("empty")}
                description={t("emptyDescription")}
              />
            ) : (
              <>
                <Card className="py-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("date")}</TableHead>
                        <TableHead>{t("id")}</TableHead>
                        <TableHead>{t("reason")}</TableHead>
                        <TableHead>{t("location")}</TableHead>
                        <TableHead>{t("lines")}</TableHead>
                        <TableHead>{t("by")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="whitespace-nowrap">
                            {format.dateTime(row.createdAt, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            })}
                          </TableCell>
                          <TableCell>
                            <Link
                              href={`/inventory/adjustments/${row.id}`}
                              className="font-medium underline-offset-4 hover:underline focus-visible:underline"
                            >
                              {shortId(row.id)}
                            </Link>
                          </TableCell>
                          <TableCell>{t(`reasons.${row.reason}`)}</TableCell>
                          <TableCell>{row.location.name}</TableCell>
                          <TableCell>{t("lineCount", { count: row._count.movements })}</TableCell>
                          <TableCell>{row.createdBy.name}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </Card>
                <Pager
                  basePath="/inventory/adjustments"
                  params={{ location: locationId }}
                  page={page}
                  pages={pages}
                />
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
