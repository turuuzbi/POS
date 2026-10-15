import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { VoidReceipt } from "@/components/receipt/receipt";
import { parsePaper, ReceiptScreen } from "@/components/receipt/receipt-screen";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { canAccessLocation, requirePermission } from "@/server/auth/session";
import { getVoidReceiptForStaff } from "@/server/services/credit-notes";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("receipt.voidSlip");
  return { title: t("pageTitle") };
}

/** In-app slip for a voided sale (keyed by the SALE id). */
export default async function StaffVoidReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ saleId: string }>;
  searchParams: Promise<{ paper?: string | string[] }>;
}) {
  const user = await requirePermission("pos.sell");
  const [{ saleId }, { paper }] = await Promise.all([params, searchParams]);
  const receipt = await getVoidReceiptForStaff(saleId, (locationId) =>
    canAccessLocation(user, locationId),
  );
  if (!receipt) notFound();
  const t = await getTranslations("receipt");
  const size = parsePaper(paper);
  const token = encodeURIComponent(receipt.shareToken);
  return (
    <ReceiptScreen
      slip={<VoidReceipt model={receipt.model} paper={size} />}
      paper={size}
      basePath={`/receipt/void/${saleId}`}
      sharePath={`/r/void/${token}`}
      pdfHref={`/api/receipts/void/${token}/pdf?paper=${size}`}
      token={receipt.shareToken}
      heading={`${t("voidSlip.pageTitle")} ${receipt.model.number}`}
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
