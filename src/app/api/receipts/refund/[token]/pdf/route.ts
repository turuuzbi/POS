import type { NextRequest } from "next/server";
import { buildRefundReceiptRows, makeCreditLabels } from "@/domain/receipt-credit-layout";
import { getRefundReceiptByToken } from "@/server/services/credit-notes";
import {
  notFoundResponse,
  paperOf,
  pdfResponse,
  receiptTranslator,
  requestLocale,
} from "../../../_pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Credit-note PDF for a refund share token. Same model and rows as the HTML slip. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const receipt = await getRefundReceiptByToken(token);
  if (!receipt) return notFoundResponse();
  const locale = requestLocale(request);
  const t = receiptTranslator(locale);
  const rows = buildRefundReceiptRows(receipt.model, makeCreditLabels(t), { locale });
  return pdfResponse(rows, {
    paper: paperOf(request),
    title: t("refund.pdfTitle", { number: receipt.model.number }),
    filenamePrefix: "refund",
    number: receipt.model.number,
  });
}
