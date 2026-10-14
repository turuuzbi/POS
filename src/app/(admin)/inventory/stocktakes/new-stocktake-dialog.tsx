"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
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
import { useAction } from "@/hooks/use-action";
import { startStocktakeAction } from "@/server/actions/stocktakes";

export function NewStocktakeDialog({
  locations,
  categories,
  defaultLocationId,
  trigger,
}: {
  locations: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  defaultLocationId: string | null;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("stocktakes");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, pending, errorMessage, fieldErrors, reset } = useAction(startStocktakeAction);
  const [locationId, setLocationId] = useState(defaultLocationId ?? locations[0]?.id ?? "");
  const [categoryId, setCategoryId] = useState("");
  const [note, setNote] = useState("");

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
          <DialogTitle>{t("createTitle")}</DialogTitle>
          <DialogDescription>{t("createDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending || !locationId) return;
            run(
              { locationId, categoryId: categoryId || null, note },
              {
                onSuccess: (data) => {
                  toast.success(t("started", { number: data.number }));
                  setOpen(false);
                  router.push(`/inventory/stocktakes/${data.id}`);
                },
              },
            );
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="stocktake-location">{t("location")}</Label>
            <NativeSelect
              id="stocktake-location"
              value={locationId}
              required
              onChange={(e) => setLocationId(e.target.value)}
              {...fieldA11y("stocktake-location", fieldErrors.locationId)}
            >
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </NativeSelect>
            <FieldError id="stocktake-location-error" errors={fieldErrors.locationId} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="stocktake-scope">{t("scope")}</Label>
            <NativeSelect
              id="stocktake-scope"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">{t("scopeAll")}</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {t("scopeCategory", { name: category.name })}
                </option>
              ))}
            </NativeSelect>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="stocktake-note">
              {t("note")} <span className="text-muted-foreground">{`(${tc("optional")})`}</span>
            </Label>
            <Input
              id="stocktake-note"
              value={note}
              maxLength={500}
              placeholder={t("notePlaceholder")}
              onChange={(e) => setNote(e.target.value)}
            />
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
            <Button type="submit" disabled={pending || !locationId}>
              {t("start")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
