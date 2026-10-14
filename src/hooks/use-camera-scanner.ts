"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type CameraState =
  | "idle"
  | "starting"
  | "scanning"
  /** The browser has no camera API (or the page is not a secure context). */
  | "unsupported"
  | "denied"
  | "no-camera"
  | "error";

interface DetectorLike {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
declare const BarcodeDetector:
  | {
      new (options?: { formats?: string[] }): DetectorLike;
      getSupportedFormats?: () => Promise<string[]>;
    }
  | undefined;

const FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code"];
/** Same code again within this window is the same item still in view. */
const REPEAT_COOLDOWN_MS = 1500;

export function cameraSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === "function"
  );
}

/**
 * Camera barcode scanner. Uses the native BarcodeDetector when the browser has
 * it, otherwise @zxing/browser (loaded on demand). The stream is stopped when
 * `active` turns false and on unmount, so the camera light never stays on.
 */
export function useCameraScanner({
  active,
  onDetect,
}: {
  active: boolean;
  onDetect: (code: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [state, setState] = useState<CameraState>("idle");
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const onDetectRef = useRef(onDetect);
  useEffect(() => {
    onDetectRef.current = onDetect;
  });

  useEffect(() => {
    if (!active) return;
    if (!cameraSupported()) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    let stopLoop: (() => void) | null = null;
    const last = { code: "", at: 0 };
    const emit = (code: string) => {
      const now = Date.now();
      if (code === last.code && now - last.at < REPEAT_COOLDOWN_MS) {
        last.at = now;
        return;
      }
      last.code = code;
      last.at = now;
      onDetectRef.current(code);
    };

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false,
        });
      } catch (error) {
        if (cancelled) return;
        const name = (error as { name?: string }).name;
        setState(
          name === "NotAllowedError" || name === "SecurityError"
            ? "denied"
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "no-camera"
              : "error",
        );
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0] ?? null;
      trackRef.current = track;
      const capabilities = track?.getCapabilities?.() as { torch?: boolean } | undefined;
      setTorchAvailable(!!capabilities?.torch);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      try {
        await video.play();
      } catch {
        // autoplay quirks: the frames still flow once the element is visible
      }
      if (cancelled) return;
      setState("scanning");

      if (typeof BarcodeDetector !== "undefined") {
        let formats = FORMATS;
        try {
          const supported = await BarcodeDetector.getSupportedFormats?.();
          if (supported?.length) formats = FORMATS.filter((f) => supported.includes(f));
        } catch {
          // fall back to the default list
        }
        const detector = new BarcodeDetector({ formats });
        const timer = setInterval(async () => {
          if (video.readyState < 2) return;
          try {
            const found = await detector.detect(video);
            const code = found[0]?.rawValue;
            if (code) emit(code);
          } catch {
            // a frame that cannot be read is skipped
          }
        }, 250);
        stopLoop = () => clearInterval(timer);
        return;
      }

      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (cancelled) return;
        const reader = new BrowserMultiFormatReader();
        const controls = await reader.decodeFromStream(stream, video, (result) => {
          if (result) emit(result.getText());
        });
        if (cancelled) controls.stop();
        else stopLoop = () => controls.stop();
      } catch {
        if (!cancelled) setState("error");
      }
    };
    void start();
    const video = videoRef.current;

    return () => {
      cancelled = true;
      stopLoop?.();
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      trackRef.current = null;
      setTorchOn(false);
      setTorchAvailable(false);
      setState("idle");
    };
  }, [active]);

  const toggleTorch = useCallback(async () => {
    const track = trackRef.current;
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setTorchAvailable(false);
    }
  }, [torchOn]);

  const effective: CameraState = active && !cameraSupported() ? "unsupported" : state;
  return { videoRef, state: effective, torchAvailable, torchOn, toggleTorch };
}
