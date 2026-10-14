import { ClipboardList, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { PurchaseOrderStatusBadge } from "@/components/purchasing/status-badge";
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
import { can } from "@/domain/access";
import { formatMoney } from "@/domain/money";
import { PURCHASE_ORDER_STATUSES, type PurchaseOrderStatus } from "@/domain/purchasing";
import { cn } from "@/lib/utils";
import { requirePermission } from "@/server/auth/session";
import { listPurchaseOrders } from "@/server/queries/purchasing";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("purchasing.orders");
  return { title: t("title") };
}

const isStatus = (value: unknown): value is PurchaseOrderStatus =>
  (PURCHASE_ORDER_STATUSES as readonly unknown[]).includes(value);

export default async function PurchaseOrdersPage({
  searchParams,
}: PageProps<"/purchasing/orders">) {
  const user = await requirePermission("purchasing.manage");
  const { status: rawStatus } = await searchParams;
  const status = isStatus(rawStatus) ? rawStatus : undefined;
  const showCosts = can(user, "reports.view_costs");
  const [t, ts, tc, format, orders] = await Promise.all([
    getTranslations("purchasing.orders"),
    getTranslations("purchasing.status"),
    getTranslations("common"),
    getFormatter(),
    listPurchaseOrders(user, { status }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title={t("title")}
        description={t("description")}
        actions={
          showCosts ? (
            <Button asChild>
              <Link href="/purchasing/orders/new">
                <Plus aria-hidden />
                {t("new")}
              </Link>
            </Button>
          ) : null
        }
      />

      <nav aria-label={t("filterStatus")} className="flex flex-wrap gap-2">
        {[undefined, ...PURCHASE_ORDER_STATUSES].map((value) => (
          <Button
            key={value ?? "all"}
            asChild
            size="sm"
            variant={value === status ? "default" : "outline"}
          >
            <Link
              href={value ? `/purchasing/orders?status=${value}` : "/purchasing/orders"}
              aria-current={value === status ? "page" : undefined}
            >
              {value ? ts(value) : tc("all")}
            </Link>
          </Button>
        ))}
      </nav>

      {orders.length === 0 ? (
        <EmptyState icon={ClipboardList} title={t("empty")} description={t("emptyDescription")} />
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("number")}</TableHead>
                <TableHead>{t("supplier")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("location")}</TableHead>
                <TableHead>{t("status")}</TableHead>
                <TableHead className="hidden sm:table-cell">{t("createdAt")}</TableHead>
                {showCosts ? <TableHead className="text-right">{t("total")}</TableHead> : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow key={order.id}>
                  <TableCell>
                    <Link
                      href={`/purchasing/orders/${order.id}`}
                      className={cn("font-medium underline-offset-4 hover:underline")}
                    >
                      {order.number}
                    </Link>
                  </TableCell>
                  <TableCell>{order.supplier.name}</TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {order.location.name}
                  </TableCell>
                  <TableCell>
                    <PurchaseOrderStatusBadge status={order.status} />
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {format.dateTime(order.createdAt, { dateStyle: "medium" })}
                  </TableCell>
                  {showCosts ? (
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(order.total)}
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
