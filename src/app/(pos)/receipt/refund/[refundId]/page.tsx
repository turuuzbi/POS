import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RefundReceipt } from "@/components/receipt/receipt";
import { parsePaper, ReceiptScreen } from "@/components/receipt/receipt-screen";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { canAccessLocation, requirePermission } from "@/server/auth/session";
import { getRefundReceiptForStaff } from "@/server/services/credit-notes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("receipt.refund");
  return { title: t("pageTitle") };
}

/** In-app credit note for a refund: print, copy the share link, download the PDF. */
export default async function StaffRefundReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ refundId: string }>;
  searchParams: Promise<{ paper?: string | string[] }>;
}) {
  const user = await requirePermission("pos.sell");
  const [{ refundId }, { paper }] = await Promise.all([params, searchParams]);
  // Refunds outside the user's locations look exactly like missing ones.
  const receipt = await getRefundReceiptForStaff(refundId, (locationId) =>
    canAccessLocation(user, locationId),
  );
  if (!receipt) notFound();
  const t = await getTranslations("receipt");
  const size = parsePaper(paper);
  const token = encodeURIComponent(receipt.shareToken);
  return (
    <ReceiptScreen
      slip={<RefundReceipt model={receipt.model} paper={size} />}
      paper={size}
      basePath={`/receipt/refund/${refundId}`}
      sharePath={`/r/refund/${token}`}
      pdfHref={`/api/receipts/refund/${token}/pdf?paper=${size}`}
      token={receipt.shareToken}
      heading={`${t("refund.pageTitle")} ${receipt.model.number}`}
      topSlot={
        <Link
          href="/register"
          className={cn(buttonVariants({ variant: "ghost" }), "-ml-3 self-start")}
        >
          <ArrowLeft aria-hidden />
          {t("actions.backToRegister")}
        </Link>
      }
    />
  );
}
