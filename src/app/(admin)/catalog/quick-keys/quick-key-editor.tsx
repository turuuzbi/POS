"use client";

import { ArrowDown, ArrowUp, Grid3x3, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/app/empty-state";
import { VariantPicker } from "@/components/catalog/variant-picker";
import { TILE_COLOR_KEYS, TILE_COLORS, isTileColor } from "@/components/catalog/tile-colors";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { useAction } from "@/hooks/use-action";
import { moveId, type ReorderQuickKeysInput } from "@/domain/quick-keys";
import { cn } from "@/lib/utils";
import {
  addQuickKeyAction,
  removeQuickKeyAction,
  reorderQuickKeysAction,
  setQuickKeyColorAction,
} from "@/server/actions/quick-keys";
import { KeyTile } from "./key-tile";

export interface EditorKey {
  id: string;
  productId: string;
  name: string;
  color: string | null;
  isActive: boolean;
  variantCount: number;
  priceLabel: string | null;
}

const HEADING_KEYS = "quick-keys-list";

/** Grid editor for one tab of one location: add, recolour, reorder, remove, preview. */
export function QuickKeyEditor({
  locationId,
  categoryId,
  tabName,
  keys,
  max,
}: {
  locationId: string;
  categoryId: string | null;
  tabName: string;
  keys: EditorKey[];
  max: number;
}) {
  const t = useTranslations("quickKeys");
  const tc = useTranslations("common");
  const router = useRouter();
  const add = useAction(addQuickKeyAction);
  const recolor = useAction(setQuickKeyColorAction);

  const byId = new Map(keys.map((k) => [k.id, k]));
  const serverIds = keys.map((k) => k.id);
  const serverOrder = serverIds.join();
  // Show a move at once; it only applies while the server's order is the one
  // it was made against, so a refresh (or a failed save) falls back to the truth.
  const [optimistic, setOptimistic] = useState<{ base: string; ids: string[] } | null>(null);
  const order = optimistic && optimistic.base === serverOrder ? optimistic.ids : serverIds;
  const ordered = order.flatMap((id) => byId.get(id) ?? []);

  const reorder = useAction(async (input: ReorderQuickKeysInput) => {
    const result = await reorderQuickKeysAction(input);
    if (!result.ok) {
      setOptimistic(null);
      router.refresh();
    }
    return result;
  });

  const [status, setStatus] = useState("");
  const focusAfter = useRef<string | null>(null);
  const orderKey = order.join();
  useEffect(() => {
    if (!focusAfter.current) return;
    document.getElementById(focusAfter.current)?.focus();
    focusAfter.current = null;
  }, [orderKey]);

  const move = (key: EditorKey, direction: "earlier" | "later") => {
    if (reorder.pending) return; // one save at a time (the buttons stay enabled to keep focus)
    const next = moveId(order, key.id, direction);
    if (next.join() === order.join()) return;
    const index = next.indexOf(key.id);
    // A disabled button can't hold focus: land on the opposite arrow at an end.
    const atEnd = direction === "earlier" ? index === 0 : index === next.length - 1;
    focusAfter.current = `qk-${key.id}-${atEnd ? (direction === "earlier" ? "later" : "earlier") : direction}`;
    setOptimistic({ base: serverOrder, ids: next });
    setStatus(`${key.name}: ${t("position", { position: index + 1 })}`);
    reorder.run(
      { locationId, categoryId, orderedIds: next },
      {
        onSuccess: () => router.refresh(),
        toastOnError: true,
      },
    );
  };

  const addError = add.error?.fieldErrors?.productId?.[0];
  const addMessage = add.error
    ? addError && ["duplicate", "full", "inactive"].includes(addError)
      ? t(`errors.${addError as "duplicate" | "full" | "inactive"}`)
      : add.errorMessage
    : null;

  return (
    <div className="space-y-8">
      <section aria-labelledby="quick-keys-add" className="space-y-3">
        <div className="space-y-1">
          <h2 id="quick-keys-add" className="text-lg font-semibold">
            {t("addHeading")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("addHint", { tab: tabName })}</p>
        </div>
        <div className="max-w-xl">
          <VariantPicker
            label={t("pickerLabel")}
            onPick={(variant) => {
              add.reset();
              add.run(
                { locationId, categoryId, productId: variant.productId, color: null },
                {
                  onSuccess: () => {
                    toast.success(t("added"));
                    router.refresh();
                  },
                },
              );
            }}
          />
        </div>
        {addMessage ? (
          <p role="alert" className="text-sm text-destructive">
            {addMessage}
          </p>
        ) : null}
      </section>

      <section aria-labelledby={HEADING_KEYS} className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 id={HEADING_KEYS} tabIndex={-1} className="text-lg font-semibold outline-none">
            {t("keysHeading", { tab: tabName })}
          </h2>
          <span className="text-sm text-muted-foreground tabular-nums">
            {t("keysCount", { count: ordered.length, max })}
          </span>
        </div>
        <p role="status" aria-live="polite" className="sr-only">
          {status}
        </p>
        {ordered.length === 0 ? (
          <EmptyState icon={Grid3x3} title={t("empty")} description={t("emptyDescription")} />
        ) : (
          <ol className="divide-y rounded-xl border bg-card">
            {ordered.map((key, index) => (
              <li
                key={key.id}
                aria-label={key.name}
                className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center"
              >
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span
                    aria-hidden
                    className={cn(
                      "size-4 shrink-0 rounded-full border",
                      isTileColor(key.color) ? TILE_COLORS[key.color] : "bg-muted",
                    )}
                  />
                  <div className="min-w-0">
                    <p className="font-medium break-words">{key.name}</p>
                    <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                      <span>{t("variantCount", { count: key.variantCount })}</span>
                      {key.isActive ? null : (
                        <Badge variant="secondary">{t("archivedProduct")}</Badge>
                      )}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <NativeSelect
                    aria-label={t("colorFor", { name: key.name })}
                    className="w-40"
                    value={isTileColor(key.color) ? key.color : ""}
                    onChange={(event) =>
                      recolor.run(
                        { id: key.id, color: event.target.value || null },
                        {
                          onSuccess: () => {
                            toast.success(t("colorSaved"));
                            router.refresh();
                          },
                          toastOnError: true,
                        },
                      )
                    }
                  >
                    <option value="">{t("defaultColor")}</option>
                    {TILE_COLOR_KEYS.map((color) => (
                      <option key={color} value={color}>
                        {t(`colors.${color}`)}
                      </option>
                    ))}
                  </NativeSelect>
                  <Button
                    id={`qk-${key.id}-earlier`}
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("moveEarlier", { name: key.name })}
                    disabled={index === 0}
                    onClick={() => move(key, "earlier")}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    id={`qk-${key.id}-later`}
                    type="button"
                    variant="outline"
                    size="icon"
                    aria-label={t("moveLater", { name: key.name })}
                    disabled={index === ordered.length - 1}
                    onClick={() => move(key, "later")}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <RemoveKey keyItem={key} cancel={tc("cancel")} />
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="quick-keys-preview" className="space-y-3">
        <div className="space-y-1">
          <h2 id="quick-keys-preview" className="text-lg font-semibold">
            {t("previewHeading")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("previewHint")}</p>
        </div>
        <ul
          data-testid="quick-keys-preview"
          className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/40 p-3 min-[480px]:grid-cols-3 md:grid-cols-4 lg:grid-cols-6"
        >
          {ordered.map((key) => (
            <li key={key.id} className="min-w-0">
              <KeyTile
                name={key.name}
                color={key.color}
                priceLabel={key.priceLabel}
                dimmed={!key.isActive}
              />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function RemoveKey({ keyItem, cancel }: { keyItem: EditorKey; cancel: string }) {
  const t = useTranslations("quickKeys");
  const router = useRouter();
  const { run, pending } = useAction(removeQuickKeyAction);
  const confirmed = useRef(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={t("removeLabel", { name: keyItem.name })}
        >
          <Trash2 aria-hidden />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          // The row is gone after a removal: park focus on the list heading.
          if (!confirmed.current) return;
          confirmed.current = false;
          event.preventDefault();
          document.getElementById(HEADING_KEYS)?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{t("remove")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("removeConfirm", { name: keyItem.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{cancel}</AlertDialogCancel>
          <AlertDialogAction
            disabled={pending}
            onClick={() => {
              confirmed.current = true;
              run(
                { id: keyItem.id },
                {
                  toastOnError: true,
                  onSuccess: () => {
                    toast.success(t("removed"));
                    router.refresh();
                  },
                },
              );
            }}
          >
            {t("remove")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
