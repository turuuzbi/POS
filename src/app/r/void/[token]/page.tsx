import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { VoidReceipt } from "@/components/receipt/receipt";
import { parsePaper, ReceiptScreen } from "@/components/receipt/receipt-screen";
import { getVoidReceiptByToken } from "@/server/services/credit-notes";

/** Public void slip (no sign-in); same privacy rules as the credit note. */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("receipt.voidSlip");
  return {
    title: t("publicTitle"),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}

export default async function PublicVoidReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ paper?: string | string[] }>;
}) {
  const [{ token }, { paper }] = await Promise.all([params, searchParams]);
  const receipt = await getVoidReceiptByToken(token);
  if (!receipt) notFound();
  const t = await getTranslations("receipt.voidSlip");
  const size = parsePaper(paper);
  const path = `/r/void/${encodeURIComponent(token)}`;
  return (
    <ReceiptScreen
      slip={<VoidReceipt model={receipt.model} paper={size} />}
      paper={size}
      basePath={path}
      sharePath={path}
      pdfHref={`/api/receipts/void/${encodeURIComponent(token)}/pdf?paper=${size}`}
      token={token}
      heading={t("publicTitle")}
    />
  );
}
