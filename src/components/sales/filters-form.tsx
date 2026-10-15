import Link from "next/link";
import type * as React from "react";
import { getTranslations } from "next-intl/server";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { RECEIPT_PAYMENT_METHODS } from "@/domain/receipt";
import { SALE_STATUSES } from "@/domain/sale-status";
import { salesFilterParams, type SalesFilter } from "@/domain/sales-filter";
import { cn } from "@/lib/utils";
import type { SalesFilterOptions } from "@/server/queries/sales";

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

/**
 * Plain GET form (works without JavaScript, every filter lives in the URL so
 * a filtered list can be shared and the CSV export reuses it).
 */
export async function SalesFiltersForm({
  filter,
  options,
  exportHref,
}: {
  filter: SalesFilter;
  options: SalesFilterOptions;
  exportHref: string;
}) {
  const [t, tm] = await Promise.all([
    getTranslations("sales.filters"),
    getTranslations("receipt.method"),
  ]);
  const ts = await getTranslations("sales.status");
  const params = salesFilterParams(filter);
  const registers = options.registers.filter(
    (r) => !filter.locationId || r.locationId === filter.locationId,
  );
  return (
    <form
      method="get"
      action="/sales"
      role="search"
      aria-label={t("heading")}
      className="space-y-4 rounded-xl border bg-card p-4"
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field id="f-q" label={t("search")}>
          <Input
            id="f-q"
            name="q"
            type="search"
            defaultValue={params.q ?? ""}
            placeholder={t("searchPlaceholder")}
            autoComplete="off"
            maxLength={40}
          />
        </Field>
        <Field id="f-from" label={t("from")}>
          <Input id="f-from" name="from" type="date" defaultValue={params.from ?? ""} />
        </Field>
        <Field id="f-to" label={t("to")}>
          <Input id="f-to" name="to" type="date" defaultValue={params.to ?? ""} />
        </Field>
        <Field id="f-status" label={t("status")}>
          <NativeSelect id="f-status" name="status" defaultValue={params.status ?? ""}>
            <option value="">{t("all")}</option>
            {SALE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ts(s)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        {options.locations.length > 1 ? (
          <Field id="f-location" label={t("location")}>
            <NativeSelect id="f-location" name="location" defaultValue={params.location ?? ""}>
              <option value="">{t("all")}</option>
              {options.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
        <Field id="f-register" label={t("register")}>
          <NativeSelect id="f-register" name="register" defaultValue={params.register ?? ""}>
            <option value="">{t("all")}</option>
            {registers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.code}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="f-cashier" label={t("cashier")}>
          <NativeSelect id="f-cashier" name="cashier" defaultValue={params.cashier ?? ""}>
            <option value="">{t("all")}</option>
            {options.cashiers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="f-method" label={t("method")}>
          <NativeSelect id="f-method" name="method" defaultValue={params.method ?? ""}>
            <option value="">{t("all")}</option>
            {RECEIPT_PAYMENT_METHODS.map((m) => (
              <option key={m} value={m}>
                {tm(m)}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field id="f-min" label={t("minAmount")}>
          <Input
            id="f-min"
            name="min"
            inputMode="decimal"
            defaultValue={params.min ?? ""}
            autoComplete="off"
          />
        </Field>
        <Field id="f-max" label={t("maxAmount")}>
          <Input
            id="f-max"
            name="max"
            inputMode="decimal"
            defaultValue={params.max ?? ""}
            autoComplete="off"
          />
        </Field>
      </div>
      {filter.invalid.length > 0 ? (
        <p role="status" className="text-sm text-destructive">
          {t("invalid")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit">{t("apply")}</Button>
        <Link href="/sales" className={cn(buttonVariants({ variant: "outline" }))}>
          {t("reset")}
        </Link>
        <a href={exportHref} className={cn(buttonVariants({ variant: "outline" }), "sm:ml-auto")}>
          {t("export")}
        </a>
      </div>
    </form>
  );
}
