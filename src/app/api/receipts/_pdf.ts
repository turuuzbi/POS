import { createTranslator } from "next-intl";
import type { NextRequest } from "next/server";
import type { ReceiptRow } from "@/domain/receipt-layout";
import { LOCALE_COOKIE, resolveLocale, type Locale } from "@/i18n/config";
import { renderReceiptPdf, type PaperMm } from "@/server/services/receipt-pdf";
import en from "../../../../messages/en";
import mn from "../../../../messages/mn";

/** Shared by the credit-note and void-slip PDF routes (the sale route predates it). */
const CATALOGS = { mn, en } as const;

export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
} as const;

export type Translate = (key: string, values?: Record<string, string | number>) => string;

export function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function requestLocale(request: NextRequest): Locale {
  return resolveLocale(
    request.nextUrl.searchParams.get("lang"),
    request.cookies.get(LOCALE_COOKIE)?.value,
  );
}

export function receiptTranslator(locale: Locale): Translate {
  return createTranslator({
    locale,
    messages: CATALOGS[locale],
    namespace: "receipt",
  }) as unknown as Translate;
}

export function paperOf(request: NextRequest): PaperMm {
  return request.nextUrl.searchParams.get("paper") === "58" ? 58 : 80;
}

export async function pdfResponse(
  rows: readonly ReceiptRow[],
  options: { paper: PaperMm; title: string; filenamePrefix: string; number: string },
): Promise<Response> {
  const pdf = await renderReceiptPdf(rows, { paperMm: options.paper, title: options.title });
  // ASCII-only filename: receipt numbers are plain codes, but never trust that.
  const filename = `${options.filenamePrefix}-${options.number.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  return new Response(Buffer.from(pdf), {
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.byteLength),
      "Content-Disposition": `inline; filename="${filename}"`,
    },
  });
}
