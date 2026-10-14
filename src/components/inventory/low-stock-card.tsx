import { AlertTriangle, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatQty } from "@/domain/qty";
import type { CurrentUser } from "@/server/auth/session";
import { listLowStock } from "@/server/queries/stock";

const SHOWN = 6;

/** Dashboard card: items at or below their reorder point in the user's locations. */
export async function LowStockCard({ user }: { user: Pick<CurrentUser, "locationIds"> }) {
  const [t, tu, locale, { total, items }] = await Promise.all([
    getTranslations("inventory"),
    getTranslations("units"),
    getLocale(),
    listLowStock(user, { limit: SHOWN }),
  ]);
  const Icon = total > 0 ? AlertTriangle : CheckCircle2;
  const multipleLocations = new Set(items.map((i) => i.locationId)).size > 1;

  return (
    <Card aria-labelledby="low-stock-title">
      <CardHeader className="grid-cols-[auto_1fr] items-center gap-4">
        <Icon
          className={total > 0 ? "size-8 text-destructive" : "size-8 text-success"}
          aria-hidden
        />
        <div className="space-y-1">
          <CardTitle id="low-stock-title">{t("lowStock.title")}</CardTitle>
          <CardDescription>{t("lowStock.summary", { count: total })}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">{t("lowStock.none")}</p>
        ) : (
          <>
            <ul className="divide-y">
              {items.map((item) => (
                <li key={`${item.variantId}:${item.locationId}`}>
                  <Link
                    href={`/inventory/stock/${item.variantId}?location=${item.locationId}`}
                    className="flex items-center justify-between gap-3 rounded-sm py-2 focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{item.label}</span>
                      {multipleLocations ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {item.locationName}
                        </span>
                      ) : null}
                    </span>
                    <Badge variant="destructive" className="tabular-nums">
                      {t("lowStock.level", {
                        qty: formatQty(item.onHandMilli, item.unit, { locale }),
                        point: `${formatQty(item.reorderPointMilli, item.unit, { locale })} ${tu(item.unit)}`,
                      })}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between text-sm">
              {total > items.length ? (
                <span className="text-muted-foreground">
                  {t("lowStock.more", { count: total - items.length })}
                </span>
              ) : (
                <span />
              )}
              <Link
                href="/inventory/stock?low=1"
                className="font-medium underline-offset-4 hover:underline focus-visible:underline"
              >
                {t("lowStock.viewAll")}
              </Link>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
