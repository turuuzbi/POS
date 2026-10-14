"use client";

import { Plus, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FieldError, fieldA11y } from "@/components/form/field-error";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_BARCODES_PER_VARIANT,
  MAX_OPTIONS,
  MAX_VARIANTS,
  PRODUCT_TYPES,
} from "@/domain/catalog";
import { formatMoney } from "@/domain/money";
import { parseOptionValues, reconcileVariants } from "@/domain/product-form";
import { UNITS, formatQty, isFractionalUnit, type Unit } from "@/domain/qty";
import { useAction } from "@/hooks/use-action";
import { saveProductAction, uploadProductImageAction } from "@/server/actions/products";
import { BarcodeField } from "./barcode-field";
import { blankVariant, type ProductDraft, type VariantDraft } from "./draft";
import { ImageField } from "./image-field";

type Options = {
  categories: { id: string; path: string }[];
  taxClasses: { id: string; name: string }[];
};

const idOf = (path: string) => `pf-${path.replace(/\./g, "-")}`;

/** Create / edit a product: details, options → variant matrix, codes, prices, image. */
export function ProductForm({
  initial,
  categories,
  taxClasses,
  canViewCosts,
  locale,
}: Options & { initial: ProductDraft; canViewCosts: boolean; locale: string }) {
  const t = useTranslations("products");
  const tc = useTranslations("common");
  const tu = useTranslations("units");
  const router = useRouter();
  const { run, pending, errorMessage, fieldErrors } = useAction(saveProductAction);
  const [draft, setDraft] = useState<ProductDraft>(initial);
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  const [finishing, setFinishing] = useState(false);
  const isNew = !initial.id;
  const err = (path: string) => fieldErrors[path];
  const patch = (changes: Partial<ProductDraft>) => setDraft((d) => ({ ...d, ...changes }));

  const hasOptions = draft.options.length > 0;
  const standard = draft.type === "STANDARD";
  const fractional = isFractionalUnit(draft.unit);

  function setType(type: ProductDraft["type"]) {
    patch({
      type,
      trackStock: type === "STANDARD" ? draft.trackStock : false,
      unit: type === "GIFT_CARD" ? "PIECE" : draft.unit,
    });
  }

  /** Rebuild the variant rows from the option values, keeping rows that still exist. */
  function regenerate(options: ProductDraft["options"], variants = draft.variants) {
    const parsed = options.map((o) => ({ name: o.name, values: parseOptionValues(o.valuesText) }));
    const next = reconcileVariants(parsed, variants, (values, template) =>
      blankVariant({ ...values, price: template?.price ?? "", cost: template?.cost ?? "" }),
    );
    return next.slice(0, MAX_VARIANTS);
  }

  function setOptions(options: ProductDraft["options"], regen: boolean) {
    setDraft((d) => ({
      ...d,
      options,
      variants: regen ? regenerate(options, d.variants) : d.variants,
    }));
  }

  function patchVariant(index: number, changes: Partial<VariantDraft>) {
    setDraft((d) => ({
      ...d,
      variants: d.variants.map((v, i) => (i === index ? { ...v, ...changes } : v)),
    }));
  }

  function submit() {
    if (pending || finishing) return;
    const options = draft.options
      .map((o) => ({ name: o.name.trim(), values: parseOptionValues(o.valuesText) }))
      .filter((o) => o.name || o.values.length > 0);
    run(
      {
        id: draft.id,
        name: draft.name,
        description: draft.description,
        type: draft.type,
        unit: draft.unit,
        categoryId: draft.categoryId || null,
        taxClassId: draft.taxClassId,
        pricesIncludeTax: draft.pricesIncludeTax,
        trackStock: standard && draft.trackStock,
        taxClassificationCode: draft.taxClassificationCode,
        isActive: draft.isActive,
        options,
        variants: draft.variants.map((v) => ({
          id: v.id,
          name: v.name,
          sku: v.sku,
          pluCode: v.pluCode,
          option1: v.option1 || null,
          option2: v.option2 || null,
          option3: v.option3 || null,
          price: v.price,
          cost: !v.id && canViewCosts && v.cost.trim() ? v.cost : undefined,
          barcodes: v.barcodes,
          isActive: v.isActive,
        })),
      },
      {
        onSuccess: ({ id }) => {
          toast.success(tc("saved"));
          if (!isNew) {
            router.refresh();
            return;
          }
          void finishCreate(id);
        },
      },
    );
  }

  /** New product: upload the held image (if any), then open the saved product. */
  async function finishCreate(id: string) {
    setFinishing(true);
    if (pendingImage) {
      const data = new FormData();
      data.set("productId", id);
      data.set("file", pendingImage);
      try {
        const result = await uploadProductImageAction(data);
        if (!result.ok) toast.error(t("imageFailed"));
      } catch {
        toast.error(t("imageFailed"));
      }
    }
    router.push(`/catalog/products/${id}`);
  }

  const busy = pending || finishing;

  return (
    <form
      className="space-y-6 pb-24"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <Card>
        <CardHeader>
          <CardTitle>{t("sectionDetails")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="pf-name">{t("name")}</Label>
            <Input
              id="pf-name"
              value={draft.name}
              maxLength={160}
              required
              autoFocus={isNew}
              onChange={(e) => patch({ name: e.target.value })}
              {...fieldA11y("pf-name", err("name"))}
            />
            <FieldError id="pf-name-error" errors={err("name")} />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <Label htmlFor="pf-description">
              {t("descriptionLabel")}{" "}
              <span className="text-muted-foreground">{`(${tc("optional")})`}</span>
            </Label>
            <Textarea
              id="pf-description"
              value={draft.description}
              maxLength={2000}
              rows={3}
              onChange={(e) => patch({ description: e.target.value })}
              {...fieldA11y("pf-description", err("description"))}
            />
            <FieldError id="pf-description-error" errors={err("description")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pf-category">{t("category")}</Label>
            <NativeSelect
              id="pf-category"
              value={draft.categoryId}
              onChange={(e) => patch({ categoryId: e.target.value })}
              {...fieldA11y("pf-category", err("categoryId"))}
            >
              <option value="">{t("noCategory")}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.path}
                </option>
              ))}
            </NativeSelect>
            <FieldError id="pf-category-error" errors={err("categoryId")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pf-type">{t("type")}</Label>
            <NativeSelect
              id="pf-type"
              value={draft.type}
              onChange={(e) => setType(e.target.value as ProductDraft["type"])}
            >
              {PRODUCT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {t(`types.${type}`)}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pf-unit">{t("unit")}</Label>
            <NativeSelect
              id="pf-unit"
              value={draft.unit}
              disabled={draft.type === "GIFT_CARD"}
              onChange={(e) => patch({ unit: e.target.value as Unit })}
              aria-describedby="pf-unit-hint"
              {...fieldA11y("pf-unit", err("unit"))}
            >
              {UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {`${t(`unitNames.${unit}`)} (${tu(unit)})`}
                </option>
              ))}
            </NativeSelect>
            <p id="pf-unit-hint" className="text-sm text-muted-foreground">
              {fractional ? t("unitWeighedHint") : t("unitPieceHint")}
            </p>
            <FieldError id="pf-unit-error" errors={err("unit")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pf-tax">{t("taxClass")}</Label>
            <NativeSelect
              id="pf-tax"
              value={draft.taxClassId}
              required
              onChange={(e) => patch({ taxClassId: e.target.value })}
              {...fieldA11y("pf-tax", err("taxClassId"))}
            >
              {taxClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
            <FieldError id="pf-tax-error" errors={err("taxClassId")} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pf-class-code">
              {t("taxClassificationCode")}{" "}
              <span className="text-muted-foreground">{`(${tc("optional")})`}</span>
            </Label>
            <Input
              id="pf-class-code"
              value={draft.taxClassificationCode}
              maxLength={32}
              onChange={(e) => patch({ taxClassificationCode: e.target.value })}
              {...fieldA11y("pf-class-code", err("taxClassificationCode"))}
            />
            <FieldError id="pf-class-code-error" errors={err("taxClassificationCode")} />
          </div>
          <SwitchRow
            id="pf-prices-include-tax"
            label={t("pricesIncludeTax")}
            hint={t("pricesIncludeTaxHint")}
            checked={draft.pricesIncludeTax}
            onChange={(pricesIncludeTax) => patch({ pricesIncludeTax })}
          />
          <SwitchRow
            id="pf-track-stock"
            label={t("trackStock")}
            hint={standard ? t("trackStockHint") : t("trackStockNotAvailable")}
            checked={standard && draft.trackStock}
            disabled={!standard}
            onChange={(trackStock) => patch({ trackStock })}
            error={err("trackStock")}
          />
          <SwitchRow
            id="pf-active"
            label={t("activeLabel")}
            hint={t("activeHint")}
            checked={draft.isActive}
            onChange={(isActive) => patch({ isActive })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("sectionImage")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ImageField
            productId={draft.id}
            imageUrl={initial.imageUrl}
            pending={pendingImage}
            onPending={setPendingImage}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("sectionOptions")}</CardTitle>
          <CardDescription>{t("optionsHint")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {draft.options.map((option, index) => (
            <div
              key={index}
              className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[1fr_2fr_auto]"
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor={idOf(`options.${index}.name`)}>{t("optionName")}</Label>
                <Input
                  id={idOf(`options.${index}.name`)}
                  value={option.name}
                  maxLength={40}
                  placeholder={t("optionNamePlaceholder")}
                  onChange={(e) =>
                    setOptions(
                      draft.options.map((o, i) =>
                        i === index ? { ...o, name: e.target.value } : o,
                      ),
                      false,
                    )
                  }
                  {...fieldA11y(idOf(`options.${index}.name`), err(`options.${index}.name`))}
                />
                <FieldError
                  id={`${idOf(`options.${index}.name`)}-error`}
                  errors={err(`options.${index}.name`)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={idOf(`options.${index}.values`)}>{t("optionValues")}</Label>
                <Input
                  id={idOf(`options.${index}.values`)}
                  value={option.valuesText}
                  placeholder={t("optionValuesPlaceholder")}
                  onChange={(e) =>
                    setOptions(
                      draft.options.map((o, i) =>
                        i === index ? { ...o, valuesText: e.target.value } : o,
                      ),
                      false,
                    )
                  }
                  onBlur={() => setOptions(draft.options, true)}
                  {...fieldA11y(idOf(`options.${index}.values`), err(`options.${index}.values`))}
                />
                <FieldError
                  id={`${idOf(`options.${index}.values`)}-error`}
                  errors={err(`options.${index}.values`)}
                />
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("removeOption", { n: index + 1 })}
                  onClick={() =>
                    setOptions(
                      draft.options.filter((_, i) => i !== index),
                      true,
                    )
                  }
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={draft.options.length >= MAX_OPTIONS}
              onClick={() => setOptions([...draft.options, { name: "", valuesText: "" }], false)}
            >
              <Plus aria-hidden />
              {t("addOption")}
            </Button>
            {hasOptions ? (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setOptions(draft.options, true)}
              >
                {t("generateVariants")}
              </Button>
            ) : null}
          </div>
          <FieldError id="pf-options-error" errors={err("options")} />
        </CardContent>
      </Card>

      <section aria-labelledby="pf-variants-heading" className="space-y-3">
        <div>
          <h2 id="pf-variants-heading" className="text-lg font-semibold">
            {t("sectionVariants")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("variantCount", { count: draft.variants.length })}
          </p>
        </div>
        <FieldError id="pf-variants-error" errors={err("variants")} />
        {draft.variants.map((variant, index) => {
          const p = (field: string) => `variants.${index}.${field}`;
          const title =
            [variant.option1, variant.option2, variant.option3].filter(Boolean).join(" / ") ||
            t("variantDefault");
          const barcodeErrors: Record<number | "_", string[] | undefined> = {
            _: err(p("barcodes")),
          };
          variant.barcodes.forEach((_, b) => (barcodeErrors[b] = err(p(`barcodes.${b}`))));
          return (
            <Card
              key={
                variant.id ?? `${variant.option1}|${variant.option2}|${variant.option3}|${index}`
              }
            >
              <CardHeader className="flex-row items-center justify-between gap-3">
                <CardTitle className="text-base">{title}</CardTitle>
                <div className="flex items-center gap-2">
                  <Label htmlFor={idOf(p("active"))} className="text-sm">
                    {t("variantActive")}
                  </Label>
                  <Switch
                    id={idOf(p("active"))}
                    checked={variant.isActive}
                    onCheckedChange={(isActive) => patchVariant(index, { isActive })}
                  />
                </div>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {hasOptions ? (
                  <FieldError id={`${idOf(p("option1"))}-error`} errors={err(p("option1"))} />
                ) : null}
                <TextField
                  id={idOf(p("sku"))}
                  label="SKU"
                  value={variant.sku}
                  maxLength={64}
                  errors={err(p("sku"))}
                  onChange={(sku) => patchVariant(index, { sku })}
                />
                <TextField
                  id={idOf(p("pluCode"))}
                  label={t("plu")}
                  value={variant.pluCode}
                  maxLength={7}
                  inputMode="numeric"
                  hint={fractional ? t("pluHint") : undefined}
                  errors={err(p("pluCode"))}
                  onChange={(pluCode) =>
                    patchVariant(index, { pluCode: pluCode.replace(/\D/g, "") })
                  }
                />
                <TextField
                  id={idOf(p("price"))}
                  label={fractional ? t("pricePerUnit", { unit: tu(draft.unit) }) : t("price")}
                  value={variant.price}
                  inputMode="decimal"
                  required
                  errors={err(p("price"))}
                  onChange={(price) => patchVariant(index, { price })}
                />
                {canViewCosts ? (
                  variant.id ? (
                    <div className="flex flex-col gap-2">
                      <span className="text-sm leading-none font-medium">{t("cost")}</span>
                      <p className="flex h-11 items-center text-base">
                        {formatMoney(BigInt(variant.currentCost ?? "0"), { locale })}
                      </p>
                      <p className="text-sm text-muted-foreground">{t("costReadOnly")}</p>
                    </div>
                  ) : (
                    <TextField
                      id={idOf(p("cost"))}
                      label={t("openingCost")}
                      value={variant.cost}
                      inputMode="decimal"
                      hint={t("openingCostHint")}
                      errors={err(p("cost"))}
                      onChange={(cost) => patchVariant(index, { cost })}
                    />
                  )
                ) : null}
                {!hasOptions && draft.variants.length > 1 ? (
                  <TextField
                    id={idOf(p("name"))}
                    label={t("variantName")}
                    value={variant.name}
                    maxLength={80}
                    errors={err(p("name"))}
                    onChange={(name) => patchVariant(index, { name })}
                  />
                ) : null}
                {variant.id && draft.trackStock && variant.onHandMilli !== undefined ? (
                  <div className="flex flex-col gap-2">
                    <span className="text-sm leading-none font-medium">{t("onHand")}</span>
                    <p className="flex h-11 items-center text-base">
                      {formatQty(variant.onHandMilli, draft.unit, { locale })} {tu(draft.unit)}
                    </p>
                  </div>
                ) : null}
                <div className="sm:col-span-2 lg:col-span-3">
                  <BarcodeField
                    id={idOf(p("barcodes"))}
                    label={t("barcodes")}
                    codes={variant.barcodes}
                    max={MAX_BARCODES_PER_VARIANT}
                    errors={barcodeErrors}
                    onChange={(barcodes) => patchVariant(index, { barcodes })}
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80 md:left-60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-end gap-3">
          {errorMessage ? (
            <p role="alert" className="me-auto text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          <Button type="button" variant="outline" onClick={() => router.push("/catalog/products")}>
            {tc("cancel")}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? tc("loading") : tc("save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  errors,
  hint,
  maxLength,
  inputMode,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  errors: string[] | undefined;
  hint?: string;
  maxLength?: number;
  inputMode?: "numeric" | "decimal" | "text";
  required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        maxLength={maxLength}
        inputMode={inputMode}
        required={required}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        {...fieldA11y(id, errors)}
      />
      {hint ? <p className="text-sm text-muted-foreground">{hint}</p> : null}
      <FieldError id={`${id}-error`} errors={errors} />
    </div>
  );
}

function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
  error,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  error?: string[];
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border p-3">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <div className="flex flex-col gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p id={`${id}-hint`} className="text-sm text-muted-foreground">
          {hint}
        </p>
        <FieldError id={`${id}-error`} errors={error} />
      </div>
    </div>
  );
}
