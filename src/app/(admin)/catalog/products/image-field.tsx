"use client";

import { ImageIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FieldError } from "@/components/form/field-error";
import { Button } from "@/components/ui/button";
import { useAction } from "@/hooks/use-action";
import { IMAGE_MAX_BYTES } from "@/domain/product-form";
import { removeProductImageAction, uploadProductImageAction } from "@/server/actions/products";

const ACCEPT = "image/jpeg,image/png,image/webp";

/**
 * One image per product. On an existing product the file uploads at once; on a
 * new product it is held (`pending`) and uploaded by the form after saving.
 */
export function ImageField({
  productId,
  imageUrl,
  pending,
  onPending,
}: {
  productId?: string;
  imageUrl: string | null;
  pending: File | null;
  onPending: (file: File | null) => void;
}) {
  const t = useTranslations("products");
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const upload = useAction(uploadProductImageAction);
  const remove = useAction(removeProductImageAction);
  const [localError, setLocalError] = useState<string | null>(null);
  const preview = useMemo(() => (pending ? URL.createObjectURL(pending) : null), [pending]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  function choose(file: File | undefined) {
    if (!file) return;
    // Quick feedback only; the server re-checks the real bytes.
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setLocalError("invalid");
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setLocalError("tooLong");
      return;
    }
    setLocalError(null);
    if (!productId) {
      onPending(file);
      return;
    }
    const data = new FormData();
    data.set("productId", productId);
    data.set("file", file);
    upload.run(data, {
      onSuccess: () => {
        toast.success(t("imageSaved"));
        router.refresh();
      },
    });
  }

  const shown = preview ?? imageUrl;
  const busy = upload.pending || remove.pending;
  const errors = localError ? [localError] : upload.fieldErrors.file;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
      <div className="flex size-28 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
        {shown ? (
          // eslint-disable-next-line @next/next/no-img-element -- user upload, served by our own route or R2
          <img src={shown} alt={t("imageAlt")} className="size-full object-cover" />
        ) : (
          <ImageIcon className="size-8 text-muted-foreground" aria-hidden />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <input
          ref={input}
          id="pf-image"
          type="file"
          accept={ACCEPT}
          className="sr-only"
          // The visible button drives this input; keep the unnamed native control out of
          // the tab order and the accessibility tree.
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = ""; // allow picking the same file again
          }}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => input.current?.click()}
          >
            {shown ? t("imageReplace") : t("imageChoose")}
          </Button>
          {shown ? (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (pending || !productId) return onPending(null);
                remove.run(
                  { productId },
                  {
                    toastOnError: true,
                    onSuccess: () => {
                      toast.success(t("imageRemoved"));
                      router.refresh();
                    },
                  },
                );
              }}
            >
              {t("imageRemove")}
            </Button>
          ) : null}
        </div>
        <p id="pf-image-hint" className="text-sm text-muted-foreground">
          {t("imageHint")}
        </p>
        <FieldError id="pf-image-error" errors={errors} />
        {upload.errorMessage && !upload.fieldErrors.file ? (
          <p role="alert" className="text-sm text-destructive">
            {upload.errorMessage}
          </p>
        ) : null}
      </div>
    </div>
  );
}
