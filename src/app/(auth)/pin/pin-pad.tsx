"use client";

import { Delete } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { loginWithPin } from "@/server/actions/auth";

const MAX_DIGITS = 8;
const MIN_DIGITS = 4;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

/**
 * Touch PIN pad backed by a real (masked) input, so a hardware keyboard,
 * screen readers and password managers all keep working.
 */
export function PinPad() {
  const t = useTranslations("auth");
  const { run, pending, error, errorMessage, reset } = useAction(loginWithPin);
  const [pin, setPin] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const errorId = useId();

  const update = (next: string) => {
    if (error) reset();
    setPin(next.replace(/\D/g, "").slice(0, MAX_DIGITS));
    inputRef.current?.focus();
  };
  const submit = () => {
    if (pin.length < MIN_DIGITS || pending) return;
    run({ pin }, { onSuccess: () => setPin("") });
    setPin("");
  };

  return (
    <form
      className="flex w-full flex-col items-center gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        {t("pinLabel")}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        autoComplete="off"
        autoFocus
        maxLength={MAX_DIGITS}
        value={pin}
        onChange={(event) => update(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className={cn(
          "h-14 w-full rounded-lg border bg-background text-center font-mono text-3xl tracking-[0.5em] outline-none",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
          error && "border-destructive",
        )}
      />
      <p className="sr-only" aria-live="polite">
        {t("pinDigits", { count: pin.length })}
      </p>
      {error ? (
        <p id={errorId} role="alert" className="text-center text-sm text-destructive">
          {error.code === "INVALID_CREDENTIALS" || error.code === "VALIDATION"
            ? t("pinInvalid")
            : errorMessage}
        </p>
      ) : null}
      <div className="grid w-full grid-cols-3 gap-3">
        {KEYS.map((digit) => (
          <Button
            key={digit}
            type="button"
            variant="outline"
            size="xl"
            className="text-2xl"
            disabled={pending}
            onClick={() => update(pin + digit)}
          >
            {digit}
          </Button>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="xl"
          className="text-base"
          disabled={pending || pin.length === 0}
          onClick={() => update("")}
        >
          {t("pinClear")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xl"
          className="text-2xl"
          disabled={pending}
          onClick={() => update(`${pin}0`)}
        >
          {"0"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xl"
          disabled={pending || pin.length === 0}
          onClick={() => update(pin.slice(0, -1))}
          aria-label={t("pinBackspace")}
        >
          <Delete className="size-6" aria-hidden />
        </Button>
      </div>
      <Button
        type="submit"
        size="xl"
        className="w-full"
        disabled={pending || pin.length < MIN_DIGITS}
      >
        {t("submit")}
      </Button>
    </form>
  );
}
