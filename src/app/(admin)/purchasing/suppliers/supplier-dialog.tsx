"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type * as React from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { useAction } from "@/hooks/use-action";
import { saveSupplierAction } from "@/server/actions/suppliers";

export interface EditableSupplier {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  taxId: string | null;
  address: string | null;
  notes: string | null;
}

/** Create (no `supplier`) or edit a supplier in a dialog. */
export function SupplierDialog({
  supplier,
  trigger,
}: {
  supplier?: EditableSupplier;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("purchasing.suppliers");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, pending, errorMessage, fieldErrors, reset } = useAction(saveSupplierAction);
  const initial = {
    name: supplier?.name ?? "",
    contactName: supplier?.contactName ?? "",
    phone: supplier?.phone ?? "",
    email: supplier?.email ?? "",
    taxId: supplier?.taxId ?? "",
    address: supplier?.address ?? "",
    notes: supplier?.notes ?? "",
  };
  const [form, setForm] = useState(initial);
  const set = (key: keyof typeof initial) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const field = (
    key: keyof typeof initial,
    label: string,
    props: React.ComponentProps<"input"> = {},
  ) => (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`supplier-${key}`}>{label}</Label>
      <Input
        id={`supplier-${key}`}
        value={form[key]}
        onChange={set(key)}
        {...props}
        {...fieldA11y(`supplier-${key}`, fieldErrors[key])}
      />
      <FieldError id={`supplier-${key}-error`} errors={fieldErrors[key]} />
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setForm(initial);
        else reset();
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent closeLabel={tc("close")}>
        <DialogHeader>
          <DialogTitle>{supplier ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex max-h-[70dvh] flex-col gap-4 overflow-y-auto px-1"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            run(
              { id: supplier?.id, ...form },
              {
                onSuccess: () => {
                  toast.success(tc("saved"));
                  setOpen(false);
                  router.refresh();
                },
              },
            );
          }}
        >
          {field("name", t("name"), { required: true, maxLength: 120, autoFocus: true })}
          {field("contactName", t("contactName"), { maxLength: 120 })}
          <div className="grid gap-4 sm:grid-cols-2">
            {field("phone", t("phone"), { type: "tel", maxLength: 40, inputMode: "tel" })}
            {field("email", t("email"), { type: "email", maxLength: 120, inputMode: "email" })}
          </div>
          {field("taxId", t("taxId"), { maxLength: 40 })}
          {field("address", t("address"), { maxLength: 300 })}
          <div className="flex flex-col gap-2">
            <Label htmlFor="supplier-notes">{t("notes")}</Label>
            <Textarea
              id="supplier-notes"
              value={form.notes}
              maxLength={1000}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
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
            <Button type="submit" disabled={pending}>
              {tc("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
