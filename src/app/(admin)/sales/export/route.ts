import { createTranslator } from "next-intl";
import type { NextRequest } from "next/server";
import { CSV_BOM, csvLine, csvText, formatCsvMoney } from "@/domain/csv-catalog";
import { DEFAULT_TIME_ZONE, LOCALE_COOKIE, resolveLocale } from "@/i18n/config";
import { localDateTime } from "@/domain/receipt";
import { parseSalesFilter, salesFilterParams } from "@/domain/sales-filter";
import { audit } from "@/server/audit";
import { can, getCurrentUser } from "@/server/auth/session";
import { db } from "@/server/db";
import { iterateSales, type SaleListRow } from "@/server/queries/sales";
import { requestMeta } from "@/server/request";
import en from "../../../../../messages/en";
import mn from "../../../../../messages/mn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CATALOGS = { mn, en } as const;

/**
 * Streams the filtered sales list as CSV (UTF-8 with BOM, CRLF, formula-safe
 * text cells). There is no `reports.export` permission, so it needs the same
 * `reports.view` as the list, and it applies the same location scoping.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });
  if (!can(user, "reports.view")) return new Response(null, { status: 403 });

  const query = Object.fromEntries(request.nextUrl.searchParams.entries());
  const filter = parseSalesFilter(query);
  const locale = resolveLocale(request.cookies.get(LOCALE_COOKIE)?.value);
  const t = createTranslator({
    locale,
    messages: CATALOGS[locale],
  }) as unknown as (key: string) => string;

  await audit(db, {
    actorId: user.id,
    action: "sales.export",
    entityType: "Sale",
    after: { filter: salesFilterParams(filter) },
    ...(await requestMeta()),
  });

  const header = csvLine(
    [
      "number",
      "date",
      "location",
      "register",
      "cashier",
      "methods",
      "total",
      "refunded",
      "status",
    ].map((key) => csvText(t(`sales.csv.${key}`))),
  );
  const line = (row: SaleListRow) => {
    const at = localDateTime(row.occurredAt, DEFAULT_TIME_ZONE);
    return csvLine([
      csvText(row.number),
      csvText(`${at.date} ${at.time}`),
      csvText(row.locationName),
      csvText(row.registerCode),
      csvText(row.cashierName),
      csvText(row.methods.map((m) => t(`receipt.method.${m}`)).join("; ")),
      formatCsvMoney(row.totalAmount),
      formatCsvMoney(row.refundedAmount),
      csvText(t(`sales.status.${row.status}`)),
    ]);
  };

  const batches = iterateSales(user, filter);
  const encoder = new TextEncoder();
  let first = true;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (first) {
          first = false;
          controller.enqueue(encoder.encode(CSV_BOM + header));
          return;
        }
        const next = await batches.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value.map(line).join("")));
      } catch (error) {
        console.error("[sales export] failed", error);
        controller.error(error);
      }
    },
    async cancel() {
      await batches.return(undefined);
    },
  });
  const date = new Date().toISOString().slice(0, 10);
  return new Response(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sales-${date}.csv"`,
      "Cache-Control": "private, no-store",
    },
  });
}
