import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RefundReceipt } from "@/components/receipt/receipt";
import { parsePaper, ReceiptScreen } from "@/components/receipt/receipt-screen";
import { getRefundReceiptByToken } from "@/server/services/credit-notes";

/**
 * Public credit note (no sign-in). The signed token is the only credential:
 * not indexed, no referrer, never cached. Bad, tampered and other-kind tokens
 * all 404 alike.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("receipt.refund");
  return {
    title: t("publicTitle"),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}

export default async function PublicRefundReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ paper?: string | string[] }>;
}) {
  const [{ token }, { paper }] = await Promise.all([params, searchParams]);
  const receipt = await getRefundReceiptByToken(token);
  if (!receipt) notFound();
  const t = await getTranslations("receipt.refund");
  const size = parsePaper(paper);
  const path = `/r/refund/${encodeURIComponent(token)}`;
  return (
    <ReceiptScreen
      slip={<RefundReceipt model={receipt.model} paper={size} />}
      paper={size}
      basePath={path}
      sharePath={path}
      pdfHref={`/api/receipts/refund/${encodeURIComponent(token)}/pdf?paper=${size}`}
      token={token}
      heading={t("publicTitle")}
    />
  );
}
