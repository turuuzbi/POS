"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { FieldError, fieldA11y } from "@/components/form/field-error";
import { LinesEditor, type EditorLine } from "@/components/purchasing/lines-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { parseQty, formatQty, type Unit } from "@/domain/qty";
import { receiveGoodsAction } from "@/server/actions/receipts";

export interface OrderRow {
  id: string;
  label: string;
  sku: string | null;
  unit: Unit;
  orderedMilli: number;
  receivedMilli: number;
  outstandingMilli: number;
  /** Order cost as input text; "" when the viewer may not see costs. */
  cost: string;
  /** Prefilled receiving quantity as input text. */
  qty: string;
}

type Props =
  | { mode: "order"; orderId: string; rows: OrderRow[]; showCosts: boolean }
  | {
      mode: "adHoc";
      suppliers: { id: string; name: string }[];
      locations: { id: string; name: string }[];
      showCosts: boolean;
    };

/** Receive goods against a purchase order (partial quantities allowed) or ad hoc. */
export function ReceiptForm(props: Props) {
  const t = useTranslations("purchasing.receipts");
  const tl = useTranslations("purchasing.lines");
  const tc = useTranslations("common");
  const locale = useLocale();
  const router = useRouter();
  const { run, pending, errorMessage, fieldErrors } = useAction(receiveGoodsAction);
  const [note, setNote] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const [rows, setRows] = useState(props.mode === "order" ? props.rows : []);
  const [lines, setLines] = useState<EditorLine[]>([]);
  const [locationId, setLocationId] = useState(
    props.mode === "adHoc" ? (props.locations[0]?.id ?? "") : "",
  );
  const [supplierId, setSupplierId] = useState("");
  // Row ids in the order they were submitted, to map "lines.N.…" errors back.
  const [submitted, setSubmitted] = useState<string[]>([]);

  const done = (data: { id: string }) => {
    toast.success(t("success"));
    router.push(`/purchasing/receipts/${data.id}`);
    router.refresh();
  };

  const submit = () => {
    setLocalError(null);
    if (props.mode === "order") {
      const picked = rows
        .map((row) => ({
          row,
          qty: row.qty.trim() === "" ? 0 : (parseQty(row.qty, row.unit) ?? -1),
        }))
        .filter(({ qty }) => qty !== 0);
      if (picked.length === 0) return setLocalError(t("nothingToReceive"));
      setSubmitted(picked.map(({ row }) => row.id));
      run(
        {
          purchaseOrderId: props.orderId,
          note,
          lines: picked.map(({ row, qty }) => ({
            purchaseOrderLineId: row.id,
            qtyMilli: qty,
            unitCost: props.showCosts ? row.cost : "0",
          })),
        },
        { onSuccess: done },
      );
    } else {
      if (lines.length === 0) return setLocalError(t("nothingToReceive"));
      setSubmitted(lines.map((l) => l.key));
      run(
        {
          locationId,
          supplierId: supplierId || null,
          note,
          lines: lines.map((l) => ({
            variantId: l.variantId,
            qtyMilli: parseQty(l.qty, l.unit) ?? 0,
            unitCost: props.showCosts ? l.cost : "0",
          })),
        },
        { onSuccess: done },
      );
    }
  };

  const rowErrors = (rowId: string, field: string) =>
    fieldErrors[`lines.${submitted.indexOf(rowId)}.${field}`];
  const lineGeneral = fieldErrors.lines?.[0];

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) submit();
      }}
    >
      {props.mode === "adHoc" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="gr-location">{t("location")}</Label>
            <NativeSelect
              id="gr-location"
              value={locationId}
              onChange={(e) => setLocationId(e.target.value)}
              {...fieldA11y("gr-location", fieldErrors.locationId)}
            >
              {props.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
            <FieldError id="gr-location-error" errors={fieldErrors.locationId} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="gr-supplier">{t("supplier")}</Label>
            <NativeSelect
              id="gr-supplier"
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <option value="">{t("noSupplier")}</option>
              {props.suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="gr-lines" className="space-y-3">
        <h2 id="gr-lines" className="text-lg font-semibold">
          {t("lines")}
        </h2>
        {props.mode === "order" ? (
          <ul className="space-y-3">
            {rows.map((row, index) => {
              const qtyErrors = rowErrors(row.id, "qtyMilli");
              const costErrors = rowErrors(row.id, "unitCost");
              return (
                <li key={row.id} className="space-y-3 rounded-lg border p-3">
                  <div>
                    <p className="font-medium break-words">{row.label}</p>
                    <p className="text-sm text-muted-foreground">
                      {[
                        row.sku,
                        t("orderedReceived", {
                          ordered: formatQty(row.orderedMilli, row.unit, { locale }),
                          received: formatQty(row.receivedMilli, row.unit, { locale }),
                        }),
                        t("outstanding", {
                          qty: formatQty(row.outstandingMilli, row.unit, { locale }),
                        }),
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3 sm:max-w-md">
                    <div className="space-y-1.5">
                      <Label htmlFor={`recv-${row.id}`}>{t("qtyReceiving")}</Label>
                      <Input
                        id={`recv-${row.id}`}
                        inputMode="decimal"
                        value={row.qty}
                        aria-invalid={qtyErrors ? true : undefined}
                        aria-describedby={qtyErrors ? `recv-${row.id}-error` : undefined}
                        onChange={(e) =>
                          setRows(
                            rows.map((r, i) => (i === index ? { ...r, qty: e.target.value } : r)),
                          )
                        }
                      />
                      <FieldError id={`recv-${row.id}-error`} errors={qtyErrors} />
                    </div>
                    {props.showCosts ? (
                      <div className="space-y-1.5">
                        <Label htmlFor={`recv-cost-${row.id}`}>{tl("unitCost")}</Label>
                        <Input
                          id={`recv-cost-${row.id}`}
                          inputMode="decimal"
                          value={row.cost}
                          aria-invalid={costErrors ? true : undefined}
                          aria-describedby={costErrors ? `recv-cost-${row.id}-error` : undefined}
                          onChange={(e) =>
                            setRows(
                              rows.map((r, i) =>
                                i === index ? { ...r, cost: e.target.value } : r,
                              ),
                            )
                          }
                        />
                        <FieldError id={`recv-cost-${row.id}-error`} errors={costErrors} />
                      </div>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <LinesEditor
            lines={lines}
            onChange={setLines}
            showCost={props.showCosts}
            locationId={locationId || null}
            errors={fieldErrors}
          />
        )}
        {lineGeneral ? (
          <p role="alert" className="text-sm text-destructive">
            {lineGeneral === "overReceipt" ? tl("overReceipt") : tl("invalid")}
          </p>
        ) : null}
      </section>

      <div className="flex flex-col gap-2">
        <Label htmlFor="gr-note">{t("note")}</Label>
        <Textarea
          id="gr-note"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {localError || (errorMessage && !Object.keys(fieldErrors).length) ? (
        <p role="alert" className="text-sm text-destructive">
          {localError ?? errorMessage}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {t("submit")}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {tc("cancel")}
        </Button>
      </div>
    </form>
  );
}
