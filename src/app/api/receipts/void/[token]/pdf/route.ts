import type { NextRequest } from "next/server";
import { buildVoidReceiptRows, makeCreditLabels } from "@/domain/receipt-credit-layout";
import { getVoidReceiptByToken } from "@/server/services/credit-notes";
import {
  notFoundResponse,
  paperOf,
  pdfResponse,
  receiptTranslator,
  requestLocale,
} from "../../../_pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Void-slip PDF for a void share token. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const receipt = await getVoidReceiptByToken(token);
  if (!receipt) return notFoundResponse();
  const locale = requestLocale(request);
  const t = receiptTranslator(locale);
  const rows = buildVoidReceiptRows(receipt.model, makeCreditLabels(t), { locale });
  return pdfResponse(rows, {
    paper: paperOf(request),
    title: t("voidSlip.pdfTitle", { number: receipt.model.number }),
    filenamePrefix: "void",
    number: receipt.model.number,
  });
}
