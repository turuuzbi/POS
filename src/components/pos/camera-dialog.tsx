"use client";

import { CameraOff, Flashlight, FlashlightOff, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { DialogFooter } from "@/components/ui/dialog";
import { useCameraScanner } from "@/hooks/use-camera-scanner";
import { PosDialog } from "./pos-dialog";

/** Camera scanner fallback for devices without a wedge scanner. Stays open for continuous scanning. */
export function CameraDialog({
  onClose,
  onDetect,
}: {
  onClose: () => void;
  /** Resolve a code; returns true when it matched a product. */
  onDetect: (code: string) => Promise<boolean>;
}) {
  const t = useTranslations("pos.camera");
  const [last, setLast] = useState<{ code: string; found: boolean } | null>(null);
  const { videoRef, state, torchAvailable, torchOn, toggleTorch } = useCameraScanner({
    active: true,
    onDetect: (code) => {
      void onDetect(code).then((found) => setLast({ code, found }));
    },
  });

  const problem =
    state === "unsupported"
      ? t("unsupported")
      : state === "denied"
        ? t("denied")
        : state === "no-camera"
          ? t("noCamera")
          : state === "error"
            ? t("error")
            : null;

  return (
    <PosDialog open onClose={onClose} title={t("title")} description={t("description")}>
      {problem ? (
        <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center">
          <CameraOff className="size-10 text-muted-foreground" aria-hidden />
          <p>{problem}</p>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-lg bg-black">
          <video
            ref={videoRef}
            muted
            playsInline
            aria-label={t("preview")}
            className="aspect-[4/3] w-full object-cover"
          />
          {state === "starting" || state === "idle" ? (
            <div className="absolute inset-0 flex items-center justify-center text-white">
              <Loader2 className="size-8 animate-spin motion-reduce:animate-none" aria-hidden />
              <span className="sr-only">{t("starting")}</span>
            </div>
          ) : null}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-8 top-1/2 h-0.5 -translate-y-1/2 bg-red-500/80"
          />
        </div>
      )}
      <p role="status" className="min-h-5 text-center text-sm">
        {last
          ? last.found
            ? t("added", { code: last.code })
            : t("notFound", { code: last.code })
          : ""}
      </p>
      <DialogFooter>
        {torchAvailable ? (
          <Button variant="outline" aria-pressed={torchOn} onClick={() => void toggleTorch()}>
            {torchOn ? <FlashlightOff aria-hidden /> : <Flashlight aria-hidden />}
            {torchOn ? t("torchOff") : t("torchOn")}
          </Button>
        ) : null}
        <Button onClick={onClose}>{t("done")}</Button>
      </DialogFooter>
    </PosDialog>
  );
}
