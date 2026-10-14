"use client";

import { Check, Download, Link2, Printer } from "lucide-react";
import { useTranslations } from "next-intl";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/**
 * Print / share / PDF controls. `print:hidden`, so they never reach the slip.
 * `sharePath` is the public path (`/r/<token>`); the origin is added in the
 * browser so the copied link is absolute.
 */
export function ReceiptActions({ sharePath, pdfHref }: { sharePath: string; pdfHref: string }) {
  const t = useTranslations("receipt.actions");
  const [copied, setCopied] = React.useState(false);

  async function copyLink() {
    const url = new URL(sharePath, window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      toast.success(t("linkCopied"));
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("copyFailed"), { description: url });
    }
  }

  return (
    <div role="toolbar" aria-label={t("toolbar")} className="flex flex-wrap gap-2 print:hidden">
      <Button type="button" onClick={() => window.print()}>
        <Printer aria-hidden />
        {t("print")}
      </Button>
      <Button type="button" variant="outline" onClick={copyLink}>
        {copied ? <Check aria-hidden /> : <Link2 aria-hidden />}
        {t("shareLink")}
      </Button>
      <Button variant="outline" asChild>
        <a href={pdfHref} download>
          <Download aria-hidden />
          {t("downloadPdf")}
        </a>
      </Button>
    </div>
  );
}
