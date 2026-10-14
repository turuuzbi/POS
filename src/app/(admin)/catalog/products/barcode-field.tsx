"use client";

import { Barcode, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { FieldError } from "@/components/form/field-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { generateInternalEan13 } from "@/domain/product-form";

/**
 * Barcodes of one variant. Scan-friendly: a scanner types the code and sends
 * Enter, which adds it to the list (and never submits the form), leaving the
 * field focused for the next scan.
 */
export function BarcodeField({
  id,
  label,
  codes,
  onChange,
  errors,
  max,
}: {
  id: string;
  label: string;
  codes: string[];
  onChange: (codes: string[]) => void;
  /** Field errors keyed by index; "_" for the list itself. */
  errors: Record<number | "_", string[] | undefined>;
  max: number;
}) {
  const t = useTranslations("products");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState<"exists" | null>(null);

  function add(code: string) {
    const value = code.trim();
    if (!value) return;
    if (codes.includes(value)) {
      setNote("exists");
      return;
    }
    setNote(null);
    onChange([...codes, value]);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-input`} className="text-sm leading-none font-medium">
        {label}
      </label>
      <div className="flex gap-2">
        <Input
          id={`${id}-input`}
          value={draft}
          inputMode="text"
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          maxLength={32}
          placeholder={t("barcodeScanHint")}
          disabled={codes.length >= max}
          onChange={(e) => {
            setDraft(e.target.value);
            setNote(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault(); // a scan's Enter must not submit the product
              add(draft);
            }
          }}
          onBlur={() => add(draft)}
        />
        <Button type="button" variant="outline" onClick={() => add(draft)} disabled={!draft.trim()}>
          {t("addBarcode")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={codes.length >= max}
          onClick={() => add(generateInternalEan13())}
        >
          <Barcode aria-hidden />
          {t("generateBarcode")}
        </Button>
      </div>
      {note ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("barcodeExists")}
        </p>
      ) : null}
      <FieldError id={`${id}-error`} errors={errors._} />
      {codes.length > 0 ? (
        <ul className="flex flex-wrap gap-2" aria-label={label}>
          {codes.map((code, index) => (
            <li key={code} className="flex flex-col gap-1">
              <span className="inline-flex items-center gap-1 rounded-md border bg-muted py-1 ps-3 pe-1 font-mono text-sm">
                {code}
                <button
                  type="button"
                  className="inline-flex size-8 items-center justify-center rounded-md hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:outline-none"
                  aria-label={t("removeBarcode", { code })}
                  onClick={() => onChange(codes.filter((c) => c !== code))}
                >
                  <X className="size-4" aria-hidden />
                </button>
              </span>
              <FieldError id={`${id}-${index}-error`} errors={errors[index]} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
