"use client";

import { useTranslations } from "next-intl";
import { VALIDATION_CODES, type ValidationCode } from "@/domain/catalog";

function isCode(value: string | undefined): value is ValidationCode {
  return (VALIDATION_CODES as readonly string[]).includes(value ?? "");
}

/**
 * The first validation error for one field, translated. Pair it with the
 * input via `id` / aria-describedby, and set aria-invalid on the input.
 */
export function FieldError({ id, errors }: { id: string; errors: string[] | undefined }) {
  const t = useTranslations("validation");
  const code = errors?.[0];
  if (!code) return null;
  return (
    <p id={id} className="text-sm text-destructive">
      {t(isCode(code) ? code : "invalid")}
    </p>
  );
}

/** Props that wire an input to its <FieldError>. */
export function fieldA11y(id: string, errors: string[] | undefined) {
  return errors?.length ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {};
}
