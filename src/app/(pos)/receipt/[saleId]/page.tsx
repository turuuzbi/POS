import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { parsePaper, ReceiptScreen } from "@/components/receipt/receipt-screen";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { canAccessLocation, requirePermission } from "@/server/auth/session";
import { getReceiptForStaff } from "@/server/services/receipts";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("receipt");
  return { title: t("title") };
}

/** In-app receipt for staff: print, copy the share link, download the PDF. */
export default async function StaffReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ saleId: string }>;
  searchParams: Promise<{ paper?: string | string[] }>;
}) {
  const user = await requirePermission("pos.sell");
  const [{ saleId }, { paper }] = await Promise.all([params, searchParams]);
  // Sales outside the user's locations look exactly like missing ones.
  const receipt = await getReceiptForStaff(saleId, (locationId) =>
    canAccessLocation(user, locationId),
  );
  if (!receipt) notFound();
  const t = await getTranslations("receipt");
  return (
    <ReceiptScreen
      model={receipt.model}
      paper={parsePaper(paper)}
      basePath={`/receipt/${saleId}`}
      sharePath={`/r/${encodeURIComponent(receipt.shareToken)}`}
      token={receipt.shareToken}
      heading={`${t("title")} ${receipt.model.number}`}
      topSlot={
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href="/register"
            className={cn(buttonVariants({ variant: "ghost" }), "-ml-3 self-start")}
          >
            <ArrowLeft aria-hidden />
            {t("actions.backToRegister")}
          </Link>
          {receipt.model.voided ? (
            <Link
              href={`/receipt/void/${saleId}`}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              {t("voidSlip.pageTitle")}
            </Link>
          ) : null}
        </div>
      }
    />
  );
}
