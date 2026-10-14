"use client";

import { useTranslations } from "next-intl";
import type * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/**
 * Register dialog: Radix traps focus inside, closes on Escape and returns focus
 * to where it came from. `locked` stops outside-click/Escape dismissal while a
 * payment is being sent.
 */
export function PosDialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  locked,
  onCloseAutoFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  locked?: boolean;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations("common");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !locked) onClose();
      }}
    >
      <DialogContent
        className={cn("sm:max-w-md", className)}
        closeLabel={locked ? undefined : t("close")}
        onInteractOutside={(event) => {
          // A scan or a stray tap must not dismiss a dialog full of typed input.
          event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (locked) event.preventDefault();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : (
            <DialogDescription className="sr-only">{title}</DialogDescription>
          )}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}
