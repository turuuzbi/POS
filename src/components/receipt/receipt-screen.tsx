import { getTranslations } from "next-intl/server";
import type * as React from "react";
import type { ReceiptModel } from "@/domain/receipt";
import { cn } from "@/lib/utils";
import { Receipt, type ReceiptPaper } from "./receipt";
import { ReceiptActions } from "./receipt-actions";

export function parsePaper(value: string | string[] | undefined): ReceiptPaper {
  return value === "58" ? 58 : 80;
}

/** 80 mm / 58 mm toggle as plain links, so it works without client state. */
async function PaperSwitch({ basePath, paper }: { basePath: string; paper: ReceiptPaper }) {
  const t = await getTranslations("receipt.paper");
  const options: { value: ReceiptPaper; label: string }[] = [
    { value: 80, label: t("mm80") },
    { value: 58, label: t("mm58") },
  ];
  return (
    <nav aria-label={t("label")} className="flex items-center gap-2 text-sm print:hidden">
      <span className="text-muted-foreground">{t("label")}</span>
      <ul className="flex overflow-hidden rounded-md border">
        {options.map((option) => (
          <li key={option.value}>
            <a
              href={`${basePath}?paper=${option.value}`}
              aria-current={option.value === paper ? "page" : undefined}
              className={cn(
                "inline-flex h-11 min-w-16 items-center justify-center px-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring",
                option.value === paper
                  ? "bg-primary text-primary-foreground"
                  : "bg-background hover:bg-accent",
              )}
            >
              {option.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** Shared body of the staff and public receipt pages: toolbar + the slip. */
export async function ReceiptScreen({
  model,
  slip,
  pdfHref,
  paper,
  basePath,
  sharePath,
  token,
  heading,
  topSlot,
}: {
  /** A sale receipt model, or pass `slip` (+ `pdfHref`) for another kind of slip. */
  model?: ReceiptModel;
  slip?: React.ReactNode;
  pdfHref?: string;
  paper: ReceiptPaper;
  /** Path of the current page (for the paper toggle). */
  basePath: string;
  sharePath: string;
  token: string;
  heading: string;
  topSlot?: React.ReactNode;
}) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-xl flex-col gap-4 px-4 py-6 print:m-0 print:min-h-0 print:max-w-none print:p-0"
    >
      <div className="flex flex-col gap-3 print:hidden">
        {topSlot}
        <h1 className="text-xl font-semibold tracking-tight">{heading}</h1>
        <ReceiptActions
          sharePath={sharePath}
          pdfHref={pdfHref ?? `/api/receipts/${encodeURIComponent(token)}/pdf?paper=${paper}`}
        />
        <PaperSwitch basePath={basePath} paper={paper} />
      </div>
      {slip ?? (model ? <Receipt model={model} paper={paper} /> : null)}
    </main>
  );
}
