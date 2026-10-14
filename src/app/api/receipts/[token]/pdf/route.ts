import { createTranslator } from "next-intl";
import type { NextRequest } from "next/server";
import { buildReceiptRows, makeReceiptLabels } from "@/domain/receipt-layout";
import { LOCALE_COOKIE, resolveLocale } from "@/i18n/config";
import { renderReceiptPdf, type PaperMm } from "@/server/services/receipt-pdf";
import { getReceiptByToken } from "@/server/services/receipts";
import en from "../../../../../../messages/en";
import mn from "../../../../../../messages/mn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CATALOGS = { mn, en } as const;

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
} as const;

/** Receipt PDF for a share token. Same model and rows as the HTML receipt. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  // Plain 404 for every bad token; nothing about why.
  const receipt = await getReceiptByToken(token);
  if (!receipt) {
    return new Response("Not found", {
      status: 404,
      headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const locale = resolveLocale(
    request.nextUrl.searchParams.get("lang"),
    request.cookies.get(LOCALE_COOKIE)?.value,
  );
  const translate = createTranslator({
    locale,
    messages: CATALOGS[locale],
    namespace: "receipt",
  }) as unknown as (key: string, values?: Record<string, string | number>) => string;

  const paper: PaperMm = request.nextUrl.searchParams.get("paper") === "58" ? 58 : 80;
  const rows = buildReceiptRows(receipt.model, makeReceiptLabels(translate), { locale });
  const pdf = await renderReceiptPdf(rows, {
    paperMm: paper,
    title: translate("pdf.title", { number: receipt.model.number }),
  });

  // ASCII-only filename: receipt numbers are plain codes, but never trust that.
  const filename = `receipt-${receipt.model.number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  return new Response(Buffer.from(pdf), {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
