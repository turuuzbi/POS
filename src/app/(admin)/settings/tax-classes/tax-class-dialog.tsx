"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { FieldError, fieldA11y } from "@/components/form/field-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { TAX_TREATMENTS } from "@/domain/catalog";
import { useAction } from "@/hooks/use-action";
import { saveTaxClassAction } from "@/server/actions/tax-classes";
import { bpsToPercent } from "./percent";

export interface EditableTaxClass {
  id: string;
  name: string;
  treatment: (typeof TAX_TREATMENTS)[number];
  vatRateBps: number;
  cityTaxRateBps: number;
}

/** Create (no `taxClass`) or edit a tax class in a dialog. */
export function TaxClassDialog({
  taxClass,
  trigger,
}: {
  taxClass?: EditableTaxClass;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("taxClasses");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, pending, errorMessage, fieldErrors, reset } = useAction(saveTaxClassAction);
  const initialVat = taxClass ? bpsToPercent(taxClass.vatRateBps) : "10";
  const [name, setName] = useState(taxClass?.name ?? "");
  const [treatment, setTreatment] = useState<EditableTaxClass["treatment"]>(
    taxClass?.treatment ?? "STANDARD",
  );
  const [vatRate, setVatRate] = useState(initialVat);
  const [cityTaxRate, setCityTaxRate] = useState(
    taxClass ? bpsToPercent(taxClass.cityTaxRateBps) : "0",
  );
  const standard = treatment === "STANDARD";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent closeLabel={tc("close")}>
        <DialogHeader>
          <DialogTitle>{taxClass ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            run(
              {
                id: taxClass?.id,
                name,
                treatment,
                vatRate: standard ? vatRate : "0",
                cityTaxRate,
              },
              {
                onSuccess: () => {
                  toast.success(tc("saved"));
                  setOpen(false);
                  if (!taxClass) {
                    setName("");
                    setTreatment("STANDARD");
                    setVatRate("10");
                    setCityTaxRate("0");
                  }
                  router.refresh();
                },
              },
            );
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="tax-class-name">{t("name")}</Label>
            <Input
              id="tax-class-name"
              value={name}
              maxLength={60}
              required
              autoFocus
              onChange={(e) => setName(e.target.value)}
              {...fieldA11y("tax-class-name", fieldErrors.name)}
            />
            <FieldError id="tax-class-name-error" errors={fieldErrors.name} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="tax-class-treatment">{t("treatment")}</Label>
            <NativeSelect
              id="tax-class-treatment"
              value={treatment}
              onChange={(e) => setTreatment(e.target.value as EditableTaxClass["treatment"])}
              {...fieldA11y("tax-class-treatment", fieldErrors.treatment)}
            >
              {TAX_TREATMENTS.map((value) => (
                <option key={value} value={value}>
                  {t(`treatments.${value}`)}
                </option>
              ))}
            </NativeSelect>
            <FieldError id="tax-class-treatment-error" errors={fieldErrors.treatment} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="tax-class-vat">{t("vatRate")}</Label>
              <Input
                id="tax-class-vat"
                inputMode="decimal"
                value={standard ? vatRate : "0"}
                disabled={!standard}
                onChange={(e) => setVatRate(e.target.value)}
                aria-describedby="tax-class-vat-hint"
                {...fieldA11y("tax-class-vat", fieldErrors.vatRate)}
              />
              <p id="tax-class-vat-hint" className="text-sm text-muted-foreground">
                {standard ? t("percentHint") : t("noVatNote")}
              </p>
              <FieldError id="tax-class-vat-error" errors={fieldErrors.vatRate} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="tax-class-city">{t("cityTaxRate")}</Label>
              <Input
                id="tax-class-city"
                inputMode="decimal"
                value={cityTaxRate}
                onChange={(e) => setCityTaxRate(e.target.value)}
                {...fieldA11y("tax-class-city", fieldErrors.cityTaxRate)}
              />
              <FieldError id="tax-class-city-error" errors={fieldErrors.cityTaxRate} />
            </div>
          </div>
          {errorMessage && !Object.keys(fieldErrors).length ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {tc("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
