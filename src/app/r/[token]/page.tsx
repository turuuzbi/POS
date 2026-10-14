import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { parsePaper, ReceiptScreen } from "@/components/receipt/receipt-screen";
import { getReceiptByToken } from "@/server/services/receipts";

/**
 * Public receipt (no sign-in). The token is the only credential, so the page
 * is private to its holder: not indexed, no referrer leaked, never cached.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("receipt");
  return {
    title: t("publicTitle"),
    robots: { index: false, follow: false, nocache: true },
    referrer: "no-referrer",
  };
}

export default async function PublicReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ paper?: string | string[] }>;
}) {
  const [{ token }, { paper }] = await Promise.all([params, searchParams]);
  // Shape-checked before any query; unknown, short and wrong tokens all 404 alike.
  const receipt = await getReceiptByToken(token);
  if (!receipt) notFound();
  const t = await getTranslations("receipt");
  return (
    <ReceiptScreen
      model={receipt.model}
      paper={parsePaper(paper)}
      basePath={`/r/${encodeURIComponent(token)}`}
      sharePath={`/r/${encodeURIComponent(token)}`}
      token={token}
      heading={t("publicTitle")}
    />
  );
}
