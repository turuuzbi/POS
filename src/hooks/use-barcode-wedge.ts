"use client";

import { useEffect, useRef } from "react";
import { createBurstDetector, isEditableTarget } from "@/lib/pos/scan-burst";

/**
 * Listen for a USB "keyboard wedge" scanner anywhere on the page. A scan is a
 * fast burst of keys ending in Enter that lands outside a text field; typing
 * in a field is never touched. While disabled (a dialog is open) bursts are
 * ignored so a scan cannot slip into a payment.
 */
export function useBarcodeWedge({
  enabled,
  onScan,
}: {
  enabled: boolean;
  onScan: (code: string) => void;
}) {
  const onScanRef = useRef(onScan);
  useEffect(() => {
    onScanRef.current = onScan;
  });

  useEffect(() => {
    if (!enabled) return;
    const detector = createBurstDetector();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      const outcome = detector.feed({
        key: event.key,
        time: event.timeStamp,
        editable: isEditableTarget(event.target),
        modified: event.ctrlKey || event.altKey || event.metaKey,
      });
      if (outcome.action === "swallow") {
        event.preventDefault(); // a burst on a focused button must not click it
      } else if (outcome.action === "scan") {
        event.preventDefault();
        onScanRef.current(outcome.code);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
