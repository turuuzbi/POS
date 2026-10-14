"use client";

import { Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { VariantPicker, type PickedVariant } from "@/components/catalog/variant-picker";
import { FieldError, fieldA11y } from "@/components/form/field-error";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import {
  ADJUSTMENT_REASONS,
  REASON_DIRECTION,
  adjustmentValue,
  isNoteRequired,
  parseLineQty,
  type AdjustmentReason,
} from "@/domain/adjustments";
import { formatMoney } from "@/domain/money";
import { formatQty } from "@/domain/qty";
import { useAction } from "@/hooks/use-action";
import { createAdjustmentAction } from "@/server/actions/adjustments";

interface Line {
  variant: PickedVariant;
  mode: "delta" | "set";
  text: string;
}

export function AdjustmentForm({
  locations,
  defaultLocationId,
}: {
  locations: { id: string; name: string }[];
  defaultLocationId: string;
}) {
  const t = useTranslations("adjustments");
  const tu = useTranslations("units");
  const tv = useTranslations("validation");
  const locale = useLocale();
  const router = useRouter();
  const { run, pending, errorMessage, fieldErrors } = useAction(createAdjustmentAction);
  const [locationId, setLocationId] = useState(defaultLocationId);
  const [reason, setReason] = useState<AdjustmentReason>("DAMAGED");
  const [note, setNote] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [showInvalid, setShowInvalid] = useState(false);

  const direction = REASON_DIRECTION[reason];
  const modeOf = (line: Line) => (direction === "both" ? line.mode : "delta");
  const parsed = lines.map((line) =>
    parseLineQty(line.text, modeOf(line), line.variant.unit, direction),
  );
  const noteRequired = isNoteRequired(reason);
  const noteErrors =
    fieldErrors.note ?? (showInvalid && noteRequired && !note.trim() ? ["required"] : undefined);

  const updateLine = (index: number, patch: Partial<Line>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));

  const submit = () => {
    if (pending) return;
    setShowInvalid(true);
    if (lines.length === 0 || parsed.some((qty) => qty === null)) return;
    if (noteRequired && !note.trim()) return;
    run(
      {
        locationId,
        reason,
        note: note.trim() || null,
        lines: lines.map((line, i) => ({
          mode: modeOf(line),
          variantId: line.variant.variantId,
          qtyMilli: parsed[i]!,
        })),
      },
      {
        onSuccess: (data) => {
          toast.success(t("form.created"));
          router.push(`/inventory/adjustments/${data.id}`);
          router.refresh();
        },
      },
    );
  };

  return (
    <form
      className="flex max-w-3xl flex-col gap-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="adj-location">{t("location")}</Label>
          <NativeSelect
            id="adj-location"
            value={locationId}
            onChange={(e) => {
              setLocationId(e.target.value);
              setLines([]); // on-hand figures belong to the old location
            }}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="adj-reason">{t("reason")}</Label>
          <NativeSelect
            id="adj-reason"
            value={reason}
            aria-describedby="adj-reason-hint"
            onChange={(e) => setReason(e.target.value as AdjustmentReason)}
          >
            {ADJUSTMENT_REASONS.map((r) => (
              <option key={r} value={r}>
                {t(`reasons.${r}`)}
              </option>
            ))}
          </NativeSelect>
          <p id="adj-reason-hint" className="text-sm text-muted-foreground">
            {t(`direction.${direction}`)}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="adj-note">
          {t("note")}
          {noteRequired ? <span aria-hidden>{" *"}</span> : null}
        </Label>
        <Textarea
          id="adj-note"
          value={note}
          maxLength={500}
          rows={2}
          required={noteRequired}
          onChange={(e) => setNote(e.target.value)}
          {...fieldA11y("adj-note", noteErrors)}
        />
        {noteRequired ? (
          <p className="text-sm text-muted-foreground">{t("noteRequiredHint")}</p>
        ) : null}
        <FieldError id="adj-note-error" errors={noteErrors} />
      </div>

      <section aria-labelledby="adj-lines" className="flex flex-col gap-3">
        <h2 id="adj-lines" className="text-lg font-semibold">
          {t("form.productsHeading")}
        </h2>
        <VariantPicker
          locationId={locationId}
          stockOnly
          label={t("form.find")}
          onPick={(variant) =>
            setLines((current) =>
              current.some((l) => l.variant.variantId === variant.variantId)
                ? current
                : [...current, { variant, mode: "delta", text: "" }],
            )
          }
        />
        {lines.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("form.noLines")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {lines.map((line, index) => {
              const qty = parsed[index] ?? null;
              const mode = modeOf(line);
              const { variant } = line;
              const delta =
                qty === null ? null : mode === "set" ? qty - (variant.onHandMilli ?? 0) : qty;
              const after =
                qty === null || delta === null ? null : (variant.onHandMilli ?? 0) + delta;
              const invalid = showInvalid && qty === null;
              const inputId = `adj-qty-${variant.variantId}`;
              return (
                <li key={variant.variantId}>
                  <Card className="gap-3 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium">{variant.label}</p>
                        <p className="text-sm text-muted-foreground">
                          {t("form.current", {
                            qty: `${formatQty(variant.onHandMilli ?? 0, variant.unit, { locale })} ${tu(variant.unit)}`,
                          })}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={t("form.removeLine", { name: variant.label })}
                        onClick={() => setLines((current) => current.filter((_, i) => i !== index))}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {direction === "both" ? (
                        <div className="flex flex-col gap-2">
                          <Label htmlFor={`${inputId}-mode`}>{t("form.mode")}</Label>
                          <NativeSelect
                            id={`${inputId}-mode`}
                            value={line.mode}
                            onChange={(e) =>
                              updateLine(index, { mode: e.target.value as Line["mode"] })
                            }
                          >
                            <option value="delta">{t("form.modeDelta")}</option>
                            <option value="set">{t("form.modeSet")}</option>
                          </NativeSelect>
                        </div>
                      ) : null}
                      <div className="flex flex-col gap-2">
                        <Label htmlFor={inputId}>
                          {`${mode === "set" ? t("form.qtySet") : t("form.qtyDelta")} (${tu(variant.unit)})`}
                        </Label>
                        <Input
                          id={inputId}
                          value={line.text}
                          inputMode={direction === "both" && mode === "delta" ? "text" : "decimal"}
                          autoComplete="off"
                          onChange={(e) => updateLine(index, { text: e.target.value })}
                          aria-invalid={invalid || undefined}
                          aria-describedby={invalid ? `${inputId}-error` : undefined}
                        />
                        {invalid ? (
                          <p id={`${inputId}-error`} className="text-sm text-destructive">
                            {tv("invalidQty")}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    {after !== null && delta !== null ? (
                      <p className="text-sm text-muted-foreground" aria-live="polite">
                        {t("form.after", {
                          qty: `${formatQty(after, variant.unit, { locale })} ${tu(variant.unit)}`,
                        })}
                        {variant.cost !== null
                          ? ` · ${t("form.costImpact", { value: formatMoney(adjustmentValue(delta, variant.cost), { locale }) })}`
                          : null}
                      </p>
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : showInvalid && parsed.some((qty) => qty === null) ? (
        <p role="alert" className="text-sm text-destructive">
          {t("form.fixLines")}
        </p>
      ) : null}

      <div>
        <Button type="submit" disabled={pending || lines.length === 0}>
          {t("form.submit")}
        </Button>
      </div>
    </form>
  );
}
