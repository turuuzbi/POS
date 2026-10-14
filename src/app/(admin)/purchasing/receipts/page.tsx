import { PackageCheck, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
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
import { listReceipts } from "@/server/queries/purchasing";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.receipts");
  return { title: t("title") };
}

export default async function ReceiptsPage() {
  const user = await requirePermission("inventory.receive");
  const [t, tc, format, receipts] = await Promise.all([
    getTranslations("purchasing.receipts"),
    getTranslations("common"),
    getFormatter(),
    listReceipts(user),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          <Button asChild>
            <Link href="/purchasing/receipts/new">
              <Plus aria-hidden />
              {t("new")}
            </Link>
          </Button>
        }
      />
      {receipts.length === 0 ? (
        <EmptyState icon={PackageCheck} title={t("empty")} description={t("emptyDescription")} />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("number")}</TableHead>
                <TableHead>{t("source")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("location")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("receivedAt")}</TableHead>
                <TableHead className="hidden lg:table-cell">{t("receivedBy")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {receipts.map((receipt) => (
                <TableRow key={receipt.id}>
                  <TableCell>
                    <Link
                      href={`/purchasing/receipts/${receipt.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {receipt.number}
                    </Link>
                  </TableCell>
                  <TableCell>
                    {receipt.purchaseOrder?.number ?? t("adHocShort")}
                    {receipt.supplier ? (
                      <span className="block text-xs text-muted-foreground">
                        {receipt.supplier.name}
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {receipt.location.name}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {format.dateTime(receipt.receivedAt, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground lg:table-cell">
                    {receipt.receivedBy.name || tc("none")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
