"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { CatalogEntry } from "@/lib/pos/catalog-entry";
import { PosDialog } from "./pos-dialog";
import { useFormat } from "./use-format";

/** A quick key whose product has several variants: pick one. */
export function VariantDialog({
  title,
  entries,
  onClose,
  onPick,
}: {
  title: string;
  entries: readonly CatalogEntry[];
  onClose: () => void;
  onPick: (entry: CatalogEntry) => void;
}) {
  const t = useTranslations("pos.variant");
  const format = useFormat();
  return (
    <PosDialog open onClose={onClose} title={title} description={t("description")}>
      <ul className="max-h-[60dvh] space-y-2 overflow-y-auto">
        {entries.map((entry) => (
          <li key={entry.variantId}>
            <Button
              variant="outline"
              className="h-auto min-h-12 w-full justify-between gap-3 py-2 whitespace-normal"
              onClick={() => onPick(entry)}
            >
              <span className="text-left">{entry.label}</span>
              <span className="font-semibold tabular-nums">{format.money(entry.price)}</span>
            </Button>
          </li>
        ))}
      </ul>
    </PosDialog>
  );
}
