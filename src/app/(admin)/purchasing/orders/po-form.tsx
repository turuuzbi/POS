"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { FieldError, fieldA11y } from "@/components/form/field-error";
import { LinesEditor, typedLineTotal, type EditorLine } from "@/components/purchasing/lines-editor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { formatMoney, sum } from "@/domain/money";
import { parseQty } from "@/domain/qty";
import { savePurchaseOrderAction } from "@/server/actions/purchase-orders";

export interface PoFormInitial {
  id?: string;
  supplierId: string;
  locationId: string;
  /** yyyy-mm-dd or "" */
  expectedAt: string;
  note: string;
  lines: EditorLine[];
}

/** Create or edit a draft purchase order. */
export function PurchaseOrderForm({
  initial,
  suppliers,
  locations,
}: {
  initial: PoFormInitial;
  suppliers: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}) {
  const t = useTranslations("purchasing.orders");
  const tc = useTranslations("common");
  const router = useRouter();
  const { run, pending, errorMessage, fieldErrors } = useAction(savePurchaseOrderAction);
  const [supplierId, setSupplierId] = useState(initial.supplierId);
  const [locationId, setLocationId] = useState(initial.locationId);
  const [expectedAt, setExpectedAt] = useState(initial.expectedAt);
  const [note, setNote] = useState(initial.note);
  const [lines, setLines] = useState(initial.lines);
  const total = sum(lines.map(typedLineTotal));

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (pending) return;
        run(
          {
            id: initial.id,
            supplierId,
            locationId,
            expectedAt: expectedAt || null,
            note,
            lines: lines.map((l) => ({
              variantId: l.variantId,
              qtyMilli: parseQty(l.qty, l.unit) ?? 0,
              unitCost: l.cost,
            })),
          },
          {
            onSuccess: ({ id }) => {
              toast.success(tc("saved"));
              router.push(`/purchasing/orders/${id}`);
              router.refresh();
            },
          },
        );
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="po-supplier">{t("supplier")}</Label>
          <NativeSelect
            id="po-supplier"
            value={supplierId}
            required
            onChange={(e) => setSupplierId(e.target.value)}
            {...fieldA11y("po-supplier", fieldErrors.supplierId)}
          >
            <option value="" disabled>
              {t("chooseSupplier")}
            </option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </NativeSelect>
          <FieldError id="po-supplier-error" errors={fieldErrors.supplierId} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="po-location">{t("location")}</Label>
          <NativeSelect
            id="po-location"
            value={locationId}
            required
            onChange={(e) => setLocationId(e.target.value)}
            {...fieldA11y("po-location", fieldErrors.locationId)}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
          <FieldError id="po-location-error" errors={fieldErrors.locationId} />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="po-expected">{t("expectedAt")}</Label>
          <Input
            id="po-expected"
            type="date"
            value={expectedAt}
            onChange={(e) => setExpectedAt(e.target.value)}
            className="sm:max-w-48"
            {...fieldA11y("po-expected", fieldErrors.expectedAt)}
          />
          <FieldError id="po-expected-error" errors={fieldErrors.expectedAt} />
        </div>
      </div>

      <section aria-labelledby="po-lines" className="space-y-3">
        <h2 id="po-lines" className="text-lg font-semibold">
          {t("lines")}
        </h2>
        <LinesEditor
          lines={lines}
          onChange={setLines}
          showCost
          locationId={locationId || null}
          errors={fieldErrors}
        />
        <p className="flex justify-end gap-2 text-lg font-semibold">
          <span>{t("total")}</span>
          <span className="tabular-nums">{formatMoney(total)}</span>
        </p>
      </section>

      <div className="flex flex-col gap-2">
        <Label htmlFor="po-note">{t("note")}</Label>
        <Textarea
          id="po-note"
          value={note}
          maxLength={1000}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {errorMessage && !Object.keys(fieldErrors).length ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {t("saveDraft")}
        </Button>
        <Button type="button" variant="outline" onClick={() => router.back()}>
          {tc("cancel")}
        </Button>
      </div>
    </form>
  );
}
