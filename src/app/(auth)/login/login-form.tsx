"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAction } from "@/hooks/use-action";
import { loginWithPassword } from "@/server/actions/auth";

export function LoginForm({ next }: { next?: string }) {
  const t = useTranslations("auth");
  const { run, pending, error, errorMessage } = useAction(loginWithPassword);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const errorId = useId();
  const invalid = error?.code === "INVALID_CREDENTIALS" || error?.code === "VALIDATION";

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        run({ email, password, next });
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{t("password")}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={invalid || undefined}
          aria-describedby={error ? errorId : undefined}
        />
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {invalid ? t("invalid") : errorMessage}
        </p>
      ) : null}
      <Button type="submit" size="lg" disabled={pending || !email || !password}>
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
