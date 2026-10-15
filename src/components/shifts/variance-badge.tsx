import { useTranslations } from "next-intl";
import { classifyVariance } from "@/domain/shift";
import { cn } from "@/lib/utils";

/**
 * A variance with its class spelled out (not colour alone): short = red,
 * over = amber, balanced = green.
 */
export function VarianceBadge({ variance, text }: { variance: bigint; text: string }) {
  const t = useTranslations("shifts.report.classification");
  const kind = classifyVariance(variance);
  return (
    <span
      data-variance={kind}
      className={cn(
        "inline-flex min-h-7 items-center gap-1.5 rounded-md border px-2 text-sm font-medium tabular-nums",
        kind === "SHORT" && "border-destructive/50 bg-destructive/10 text-destructive",
        kind === "OVER" && "border-warning bg-warning/20 text-foreground",
        kind === "OK" && "border-success/50 bg-success/10 text-foreground",
      )}
    >
      <span>{text}</span>
      <span className="text-xs font-normal">{t(kind)}</span>
    </span>
  );
}
