"use client";

import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAction } from "@/hooks/use-action";
import { isLocale, LOCALES } from "@/i18n/config";
import { setLocale } from "@/server/actions/preferences";

/** Language + theme switcher, available on every screen including sign-in. */
export function PreferencesMenu() {
  const t = useTranslations("preferences");
  const locale = useLocale();
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { run, pending } = useAction(setLocale);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`${t("language")} / ${t("theme")}`}>
          <Languages className="size-5" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("language")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={locale}
            onValueChange={(value) => {
              if (isLocale(value) && value !== locale) {
                run({ locale: value }, { onSuccess: () => router.refresh(), toastOnError: true });
              }
            }}
          >
            {LOCALES.map((code) => (
              <DropdownMenuRadioItem key={code} value={code} disabled={pending} lang={code}>
                {t(`languageNames.${code}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("theme")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme ?? "system"} onValueChange={setTheme}>
            <DropdownMenuRadioItem value="light">
              <Sun aria-hidden />
              {t("themeLight")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark">
              <Moon aria-hidden />
              {t("themeDark")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="system">
              <Monitor aria-hidden />
              {t("themeSystem")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
