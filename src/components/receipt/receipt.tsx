import { useLocale, useTranslations } from "next-intl";
import type { ReceiptModel } from "@/domain/receipt";
import { buildReceiptRows, makeReceiptLabels, type ReceiptRow } from "@/domain/receipt-layout";
import { cn } from "@/lib/utils";

export type ReceiptPaper = 58 | 80;

/**
 * Printable-area widths: 80 mm paper prints ~72 mm, 58 mm paper ~48 mm. The
 * sheet is always black on white, whatever the app theme, because it is paper.
 */
const PAPER_CSS: Record<ReceiptPaper, string> = {
  80: `@page { size: 80mm auto; margin: 0; }`,
  58: `@page { size: 58mm auto; margin: 0; }`,
};

const SIZE_CLASS = { sm: "text-[11px]", md: "text-xs", lg: "text-sm" } as const;

function RowView({ row }: { row: ReceiptRow }) {
  switch (row.kind) {
    case "gap":
      return <div className="h-2" aria-hidden />;
    case "rule":
      return (
        <div
          aria-hidden
          className={cn(
            "my-1.5 border-t border-black",
            row.style === "dashed" ? "border-dashed" : "border-solid",
          )}
        />
      );
    case "banner":
      return (
        <div
          role="status"
          className="my-1 border-2 border-black py-1 text-center text-sm font-bold"
        >
          {row.text}
        </div>
      );
    case "text":
      return (
        <p
          className={cn(
            "break-words whitespace-pre-wrap",
            SIZE_CLASS[row.size ?? "md"],
            row.align === "center" && "text-center",
            row.bold && "font-bold",
          )}
        >
          {row.text}
        </p>
      );
    case "pair":
      return (
        <div
          className={cn(
            "flex items-baseline justify-between gap-2",
            SIZE_CLASS[row.size ?? "md"],
            row.bold && "font-bold",
            row.indent && "pl-2",
          )}
        >
          <span className="min-w-0 break-words">{row.left}</span>
          {row.right ? <span className="shrink-0 text-right tabular-nums">{row.right}</span> : null}
        </div>
      );
  }
}

/**
 * Thermal-paper receipt. Pure presentation of a `ReceiptModel`; contains no
 * app chrome, so printing a page that holds only this (and `print:hidden`
 * toolbars) yields exactly the slip.
 */
export function Receipt({
  model,
  paper = 80,
  className,
}: {
  model: ReceiptModel;
  paper?: ReceiptPaper;
  className?: string;
}) {
  const t = useTranslations("receipt");
  const locale = useLocale();
  const labels = makeReceiptLabels(t as unknown as Parameters<typeof makeReceiptLabels>[0]);
  const rows = buildReceiptRows(model, labels, { locale });

  return (
    <>
      <style>{`@media print {
  ${PAPER_CSS[paper]}
  html, body { background: #fff !important; color: #000 !important; margin: 0 !important; }
  .receipt-sheet { width: ${paper}mm !important; max-width: none !important; margin: 0 !important; border: 0 !important; border-radius: 0 !important; box-shadow: none !important; }
}`}</style>
      <article
        aria-label={`${t("title")} ${model.number}`}
        data-paper={paper}
        className={cn(
          "receipt-sheet mx-auto box-border w-full bg-white px-[4mm] py-[4mm] font-mono leading-snug text-black",
          "rounded-sm border border-black/15 shadow-sm",
          paper === 80 ? "max-w-[80mm]" : "max-w-[58mm]",
          className,
        )}
      >
        {rows.map((row, index) => (
          <RowView key={index} row={row} />
        ))}
      </article>
    </>
  );
}
