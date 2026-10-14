"use client";

import { Delete } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { applyKeypad } from "@/lib/pos/money-input";

const ROWS = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
] as const;

/** Touch keypad; every key is a 56px target. */
export function Keypad({
  onKey,
  decimals = 0,
  className,
}: {
  onKey: (key: string) => void;
  decimals?: number;
  className?: string;
}) {
  const t = useTranslations("pos.keypad");
  const key = (value: string, label: string, aria?: string) => (
    <Button
      key={value}
      type="button"
      variant="outline"
      className="h-14 text-xl font-medium"
      aria-label={aria}
      onClick={() => onKey(value)}
    >
      {label}
    </Button>
  );
  return (
    <div className={cn("grid grid-cols-3 gap-2", className)}>
      {ROWS.flat().map((digit) => key(digit, digit))}
      {decimals > 0 ? key(".", ".", t("decimal")) : key("00", "00")}
      {key("0", "0")}
      <Button
        type="button"
        variant="secondary"
        className="h-14"
        aria-label={t("backspace")}
        onClick={() => onKey("backspace")}
      >
        <Delete className="size-6" aria-hidden />
      </Button>
    </div>
  );
}

/** Replace any character a hardware keyboard may add that the field cannot hold. */
export function sanitizeTyped(
  raw: string,
  decimals: number,
  maxLength = 12,
  leadingZeros = false,
): string {
  let out = "";
  const options = { decimals, maxLength, leadingZeros };
  for (const char of raw.replace(",", ".")) {
    if (/\d/.test(char)) out = applyKeypad(out, char, options);
    else if (char === ".") out = applyKeypad(out, ".", options);
  }
  return out;
}

/**
 * A numeric field fed by the on-screen keypad and, equally, by a hardware
 * keyboard. The OS keyboard stays hidden (inputMode="none") so it never covers
 * the pad; screen readers get a normal labelled input.
 */
export function KeypadField({
  value,
  onChange,
  label,
  suffix,
  decimals = 0,
  maxLength = 12,
  autoFocus = true,
  invalid,
  describedBy,
  onEnter,
  hideLabel,
  mask,
  leadingZeros,
}: {
  value: string;
  onChange: (next: string) => void;
  label: string;
  suffix?: string;
  decimals?: number;
  maxLength?: number;
  autoFocus?: boolean;
  invalid?: boolean;
  describedBy?: string;
  onEnter?: () => void;
  hideLabel?: boolean;
  /** Hide the typed digits (PIN entry). */
  mask?: boolean;
  /** Keep leading zeros (PIN entry). */
  leadingZeros?: boolean;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <label htmlFor={id} className={hideLabel ? "sr-only" : "text-sm font-medium"}>
        {label}
      </label>
      <div className="flex items-baseline gap-2 rounded-lg border border-input-border bg-background px-3 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50">
        <input
          id={id}
          type="text"
          inputMode="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={value}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) =>
            onChange(sanitizeTyped(event.target.value, decimals, maxLength, leadingZeros))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && onEnter) {
              event.preventDefault();
              onEnter();
            }
          }}
          className={cn(
            "h-16 min-w-0 flex-1 bg-transparent text-right text-3xl font-semibold tabular-nums outline-none",
            mask && "tracking-[0.4em] [-webkit-text-security:disc]",
          )}
          data-1p-ignore
          data-lpignore="true"
          placeholder="0"
        />
        {suffix ? <span className="text-xl text-muted-foreground">{suffix}</span> : null}
      </div>
      <Keypad
        onKey={(key) => onChange(applyKeypad(value, key, { decimals, maxLength, leadingZeros }))}
        decimals={decimals}
      />
    </div>
  );
}
