"use client";

import { Keyboard } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

const SHORTCUTS = [
  { keys: "/", id: "search" },
  { keys: "F2", id: "charge" },
  { keys: "F3", id: "hold" },
  { keys: "F4", id: "held" },
  { keys: "F7", id: "camera" },
  { keys: "F8", id: "discount" },
  { keys: "?", id: "help" },
  { keys: "Esc", id: "close" },
] as const;

/** The keyboard shortcuts of the register (also the scanner tips). */
export function HelpPopover({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("pos.help");
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={t("button")} aria-keyshortcuts="?">
          <Keyboard aria-hidden />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3">
        <h2 className="font-semibold">{t("title")}</h2>
        <dl className="space-y-2 text-sm">
          {SHORTCUTS.map(({ keys, id }) => (
            <div key={id} className="flex items-center justify-between gap-3">
              <dt className="text-muted-foreground">{t(`keys.${id}`)}</dt>
              <dd>
                <kbd className="rounded border bg-muted px-2 py-0.5 font-mono text-xs">{keys}</kbd>
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs text-muted-foreground">{t("scanner")}</p>
        <p className="text-xs text-muted-foreground">{t("quantity")}</p>
      </PopoverContent>
    </Popover>
  );
}
