"use client";

import { useTranslations } from "next-intl";
import type * as React from "react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { TILE_COLOR_KEYS, TILE_COLORS } from "@/components/catalog/tile-colors";
import { FieldError, fieldA11y } from "@/components/form/field-error";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { useAction } from "@/hooks/use-action";
import { cn } from "@/lib/utils";
import { saveCategoryAction } from "@/server/actions/categories";

export interface CategoryOption {
  id: string;
  path: string;
}

export interface EditableCategory {
  id: string;
  name: string;
  parentId: string | null;
  color: string | null;
  sortOrder: number;
}

/** Create (no `category`) or edit a category in a dialog. */
export function CategoryDialog({
  category,
  parents,
  trigger,
}: {
  category?: EditableCategory;
  parents: CategoryOption[];
  trigger: React.ReactNode;
}) {
  const t = useTranslations("categories");
  const tc = useTranslations("common");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, pending, errorMessage, fieldErrors, reset } = useAction(saveCategoryAction);
  const [name, setName] = useState(category?.name ?? "");
  const [parentId, setParentId] = useState(category?.parentId ?? "");
  const [color, setColor] = useState(category?.color ?? "");
  const [sortOrder, setSortOrder] = useState(String(category?.sortOrder ?? 0));
  // A category can't be moved under itself (the server also refuses deeper cycles).
  const parentChoices = parents.filter((p) => p.id !== category?.id);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        reset();
        if (next) {
          // Start from the stored values: an abandoned edit must not linger.
          setName(category?.name ?? "");
          setParentId(category?.parentId ?? "");
          setColor(category?.color ?? "");
          setSortOrder(String(category?.sortOrder ?? 0));
        }
      }}
    >
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent closeLabel={tc("close")}>
        <DialogHeader>
          <DialogTitle>{category ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription className="sr-only">{t("description")}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            run(
              {
                id: category?.id,
                name,
                parentId: parentId || null,
                color: color || null,
                sortOrder: Number.parseInt(sortOrder, 10) || 0,
              },
              {
                onSuccess: () => {
                  toast.success(tc("saved"));
                  setOpen(false);
                  if (!category) {
                    setName("");
                    setParentId("");
                    setColor("");
                    setSortOrder("0");
                  }
                  router.refresh();
                },
              },
            );
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="category-name">{t("name")}</Label>
            <Input
              id="category-name"
              value={name}
              maxLength={80}
              required
              autoFocus
              onChange={(e) => setName(e.target.value)}
              {...fieldA11y("category-name", fieldErrors.name)}
            />
            <FieldError id="category-name-error" errors={fieldErrors.name} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="category-parent">{t("parent")}</Label>
            <NativeSelect
              id="category-parent"
              value={parentId}
              onChange={(e) => setParentId(e.target.value)}
              {...fieldA11y("category-parent", fieldErrors.parentId)}
            >
              <option value="">{t("noParent")}</option>
              {parentChoices.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.path}
                </option>
              ))}
            </NativeSelect>
            <FieldError id="category-parent-error" errors={fieldErrors.parentId} />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 text-sm font-medium">{t("color")}</legend>
            <div className="flex flex-wrap gap-2">
              <ColorChoice
                label={t("noColor")}
                selected={!color}
                onSelect={() => setColor("")}
                className="bg-muted"
              />
              {TILE_COLOR_KEYS.map((key) => (
                <ColorChoice
                  key={key}
                  label={t(`colors.${key}`)}
                  selected={color === key}
                  onSelect={() => setColor(key)}
                  className={TILE_COLORS[key]}
                />
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-2">
            <Label htmlFor="category-sort">{t("sortOrder")}</Label>
            <Input
              id="category-sort"
              inputMode="numeric"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value.replace(/\D/g, "").slice(0, 5))}
              className="w-32"
            />
          </div>
          {errorMessage && !Object.keys(fieldErrors).length ? (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={pending}>
              {tc("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ColorChoice({
  label,
  selected,
  onSelect,
  className,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
  className: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onSelect}
      className={cn(
        "size-11 rounded-full border-2 border-transparent outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected && "border-foreground ring-2 ring-background ring-inset",
        className,
      )}
    />
  );
}
