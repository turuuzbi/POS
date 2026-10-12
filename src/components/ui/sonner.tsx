"use client";

import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  const { theme = "system" } = useTheme();
  const t = useTranslations("common");
  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      richColors
      closeButton
      containerAriaLabel={t("notifications")}
      {...props}
      toastOptions={{ ...props.toastOptions, closeButtonAriaLabel: t("close") }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          // Theme tokens instead of Sonner's light palette (which is < 4.5:1).
          "--success-bg": "var(--popover)",
          "--success-text": "var(--success)",
          "--success-border": "var(--border)",
          "--error-bg": "var(--popover)",
          "--error-text": "var(--destructive)",
          "--error-border": "var(--border)",
          ...props.style,
        } as React.CSSProperties
      }
    />
  );
}

export { Toaster };
