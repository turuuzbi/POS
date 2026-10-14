"use client";

import { Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { VariantPicker, type PickedVariant } from "@/components/catalog/variant-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatMoney, parseMoney } from "@/domain/money";
import { costText } from "./line-text";
import { lineTotal } from "@/domain/purchasing";
import { parseQty, type Unit } from "@/domain/qty";

/** One editable order/receipt line; qty and cost stay as typed text until submit. */
export interface EditorLine {
  key: string;
  variantId: string;
  label: string;
  sku: string | null;
  unit: Unit;
  qty: string;
  cost: string;
}

export function lineFromVariant(variant: PickedVariant): EditorLine {
  return {
    key: variant.variantId,
    variantId: variant.variantId,
    label: variant.label,
    sku: variant.sku,
    unit: variant.unit,
    qty: "1",
    cost: variant.cost !== null && variant.cost > 0n ? costText(variant.cost) : "",
  };
}

/** Typed qty/cost -> money for the live total (0 while a field is not valid yet). */
export function typedLineTotal(line: Pick<EditorLine, "qty" | "cost" | "unit">): bigint {
  const qty = parseQty(line.qty, line.unit);
  const cost = parseMoney(line.cost);
  return qty === null || cost === null ? 0n : lineTotal(cost, qty);
}

function rowError(errors: Record<string, string[]>, index: number, field: string) {
  return errors[`lines.${index}.${field}`]?.[0];
}

/** Product search plus an editable list of lines (quantity, unit cost, line total). */
export function LinesEditor({
  lines,
  onChange,
  showCost,
  locationId,
  errors,
}: {
  lines: EditorLine[];
  onChange: (lines: EditorLine[]) => void;
  showCost: boolean;
  locationId: string | null;
  errors: Record<string, string[]>;
}) {
  const t = useTranslations("purchasing.lines");
  const tv = useTranslations("validation");
  const update = (index: number, patch: Partial<EditorLine>) =>
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  return (
    <div className="space-y-3">
      <VariantPicker
        label={t("addProduct")}
        locationId={locationId}
        stockOnly
        onPick={(variant) => {
          if (!lines.some((l) => l.variantId === variant.variantId)) {
            onChange([...lines, lineFromVariant(variant)]);
          }
        }}
      />
      {errors.lines?.[0] ? (
        <p role="alert" className="text-sm text-destructive">
          {errors.lines[0] === "duplicate" ? t("duplicate") : t("invalid")}
        </p>
      ) : null}
      {lines.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="space-y-3">
          {lines.map((line, index) => {
            const qtyError = rowError(errors, index, "qtyMilli");
            const costError = rowError(errors, index, "unitCost");
            return (
              <li key={line.key} className="space-y-3 rounded-lg border p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium break-words">{line.label}</p>
                    {line.sku ? <p className="text-xs text-muted-foreground">{line.sku}</p> : null}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t("remove", { name: line.label })}
                    onClick={() => onChange(lines.filter((_, i) => i !== index))}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <div className="space-y-1.5">
                    <Label htmlFor={`qty-${line.key}`}>{t("qty")}</Label>
                    <Input
                      id={`qty-${line.key}`}
                      inputMode="decimal"
                      value={line.qty}
                      aria-invalid={qtyError ? true : undefined}
                      aria-describedby={qtyError ? `qty-${line.key}-error` : undefined}
                      onChange={(e) => update(index, { qty: e.target.value })}
                    />
                    {qtyError ? (
                      <p id={`qty-${line.key}-error`} className="text-sm text-destructive">
                        {qtyError === "overReceipt"
                          ? t("overReceipt")
                          : tv(qtyError === "invalidQty" ? "invalidQty" : "invalid")}
                      </p>
                    ) : null}
                  </div>
                  {showCost ? (
                    <div className="space-y-1.5">
                      <Label htmlFor={`cost-${line.key}`}>{t("unitCost")}</Label>
                      <Input
                        id={`cost-${line.key}`}
                        inputMode="decimal"
                        value={line.cost}
                        aria-invalid={costError ? true : undefined}
                        aria-describedby={costError ? `cost-${line.key}-error` : undefined}
                        onChange={(e) => update(index, { cost: e.target.value })}
                      />
                      {costError ? (
                        <p id={`cost-${line.key}-error`} className="text-sm text-destructive">
                          {tv("invalidMoney")}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {showCost ? (
                    <div className="col-span-2 space-y-1.5 sm:col-span-1">
                      <p className="text-sm font-medium">{t("lineTotal")}</p>
                      <p className="flex h-11 items-center tabular-nums">
                        {formatMoney(typedLineTotal(line))}
                      </p>
                    </div>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
