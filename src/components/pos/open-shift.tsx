"use client";

import { Wallet } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { parseKeypadMoney } from "@/lib/pos/money-input";
import { openShiftAction } from "@/server/actions/shifts";
import { KeypadField } from "./keypad";

/** No open shift on this register: count the drawer and open one. */
export function OpenShiftScreen({ registerName }: { registerName: string }) {
  const t = useTranslations("pos.shift");
  const router = useRouter();
  const { run, pending, errorMessage } = useAction(openShiftAction);
  const [text, setText] = useState("");
  const errorId = useId();
  const parsed = parseKeypadMoney(text === "" ? "0" : text);

  const submit = () => {
    if (parsed === null || pending) return;
    run({ openingFloat: text === "" ? "0" : text }, { onSuccess: () => router.refresh() });
  };

  return (
    <main id="main" className="flex flex-1 items-center justify-center p-4">
      <section
        aria-labelledby="open-shift-title"
        className="w-full max-w-sm space-y-4 rounded-xl border bg-background p-5 shadow-sm"
        data-testid="open-shift"
      >
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <Wallet className="size-5" aria-hidden />
          </div>
          <div>
            <h1 id="open-shift-title" className="text-lg font-semibold">
              {t("title")}
            </h1>
            <p className="text-sm text-muted-foreground">
              {t("description", { register: registerName })}
            </p>
          </div>
        </div>
        <KeypadField
          value={text}
          onChange={setText}
          label={t("openingFloat")}
          suffix="₮"
          decimals={0}
          describedBy={errorMessage ? errorId : undefined}
          invalid={!!errorMessage}
          onEnter={submit}
        />
        {errorMessage ? (
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {errorMessage}
          </p>
        ) : null}
        <Button size="lg" className="w-full" disabled={pending || parsed === null} onClick={submit}>
          {pending ? t("opening") : t("open")}
        </Button>
      </section>
    </main>
  );
}
