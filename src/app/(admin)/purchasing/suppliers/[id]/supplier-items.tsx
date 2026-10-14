"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { VariantPicker } from "@/components/catalog/variant-picker";
import { ConfirmButton } from "@/components/form/confirm-button";
import { FieldError, fieldA11y } from "@/components/form/field-error";
import { costText } from "@/components/purchasing/lines-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/hooks/use-action";
import { formatMoney } from "@/domain/money";
import { removeSupplierItemAction, saveSupplierItemAction } from "@/server/actions/suppliers";

export interface SupplierItemRow {
  variantId: string;
  label: string;
  sku: string | null;
  supplierSku: string | null;
  /** Last cost in mongo; null when unknown or when the viewer may not see costs. */
  cost: bigint | null;
  isPreferred: boolean;
}

interface Draft {
  variantId: string;
  label: string;
  supplierSku: string;
  cost: string;
  isPreferred: boolean;
}

export function SupplierItems({
  supplierId,
  items,
  showCosts,
}: {
  supplierId: string;
  items: SupplierItemRow[];
  showCosts: boolean;
}) {
  const t = useTranslations("purchasing.supplierItems");
  const tc = useTranslations("common");
  const router = useRouter();
  const { run, pending, errorMessage, fieldErrors, reset } = useAction(saveSupplierItemAction);
  const [draft, setDraft] = useState<Draft | null>(null);

  const edit = (item: SupplierItemRow) => {
    reset();
    setDraft({
      variantId: item.variantId,
      label: item.label,
      supplierSku: item.supplierSku ?? "",
      cost: item.cost === null ? "" : costText(item.cost),
      isPreferred: item.isPreferred,
    });
  };

  return (
    <div className="space-y-4">
      <VariantPicker
        label={t("add")}
        onPick={(variant) => {
          const existing = items.find((i) => i.variantId === variant.variantId);
          if (existing) return edit(existing);
          reset();
          setDraft({
            variantId: variant.variantId,
            label: variant.label,
            supplierSku: "",
            cost: "",
            isPreferred: false,
          });
        }}
      />

      {draft ? (
        <form
          className="space-y-4 rounded-lg border p-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            run(
              {
                supplierId,
                variantId: draft.variantId,
                supplierSku: draft.supplierSku,
                cost: showCosts ? draft.cost : undefined,
                isPreferred: draft.isPreferred,
              },
              {
                onSuccess: () => {
                  toast.success(tc("saved"));
                  setDraft(null);
                  router.refresh();
                },
              },
            );
          }}
        >
          <p className="font-medium">{draft.label}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="item-sku">{t("supplierSku")}</Label>
              <Input
                id="item-sku"
                value={draft.supplierSku}
                maxLength={80}
                onChange={(e) => setDraft({ ...draft, supplierSku: e.target.value })}
                {...fieldA11y("item-sku", fieldErrors.supplierSku)}
              />
              <FieldError id="item-sku-error" errors={fieldErrors.supplierSku} />
            </div>
            {showCosts ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="item-cost">{t("cost")}</Label>
                <Input
                  id="item-cost"
                  inputMode="decimal"
                  value={draft.cost}
                  onChange={(e) => setDraft({ ...draft, cost: e.target.value })}
                  {...fieldA11y("item-cost", fieldErrors.cost)}
                />
                <FieldError id="item-cost-error" errors={fieldErrors.cost} />
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              id="item-preferred"
              checked={draft.isPreferred}
              onCheckedChange={(checked) => setDraft({ ...draft, isPreferred: checked === true })}
            />
            <Label htmlFor="item-preferred">{t("preferred")}</Label>
          </div>
          {errorMessage && !Object.keys(fieldErrors).length ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" disabled={pending}>
              {tc("save")}
            </Button>
            <Button type="button" variant="outline" onClick={() => setDraft(null)}>
              {tc("cancel")}
            </Button>
          </div>
        </form>
      ) : null}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {items.map((item) => (
            <li
              key={item.variantId}
              className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium break-words">
                  {item.label}{" "}
                  {item.isPreferred ? <Badge variant="success">{t("preferredBadge")}</Badge> : null}
                </p>
                <p className="text-sm text-muted-foreground">
                  {[
                    item.sku,
                    item.supplierSku ? t("supplierSkuValue", { sku: item.supplierSku }) : null,
                    showCosts && item.cost !== null
                      ? t("lastCost", { cost: formatMoney(item.cost) })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => edit(item)}>
                  {tc("edit")}
                </Button>
                <ConfirmButton
                  action={removeSupplierItemAction}
                  input={{ supplierId, variantId: item.variantId }}
                  label={tc("remove")}
                  description={t("removeConfirm", { name: item.label })}
                  successMessage={t("removed")}
                  destructive
                  variant="ghost"
                  size="sm"
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
