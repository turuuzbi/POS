/**
 * USB "keyboard wedge" scanner detection. A scanner types the code as a very
 * fast burst of printable keys (a few ms apart) and ends with Enter; a person
 * never types that fast. The detector is a pure state machine over key events
 * so it can be tested without a DOM.
 *
 * It only ever looks at keys that land OUTSIDE editable fields: inside a text
 * input the scan is just typing (the search box handles Enter itself), so a
 * real input never loses a keystroke to us.
 */

export interface BurstOptions {
  /** Largest gap between two keys of one burst, in ms. */
  maxGapMs?: number;
  /** Shortest code accepted as a scan. */
  minLength?: number;
  /** Longest code accepted; longer bursts are discarded. */
  maxLength?: number;
}

export interface BurstKey {
  key: string;
  /** Event time in ms (KeyboardEvent.timeStamp). */
  time: number;
  /** The event target is a text field / textarea / contenteditable. */
  editable: boolean;
  /** ctrl / alt / meta held: a shortcut, never a scan. */
  modified?: boolean;
}

export type BurstOutcome =
  | { action: "ignore" }
  /** Part of a burst: the caller should preventDefault so a focused button is not triggered. */
  | { action: "swallow" }
  | { action: "scan"; code: string };

export interface BurstDetector {
  feed(event: BurstKey): BurstOutcome;
  reset(): void;
}

export const DEFAULT_BURST: Required<BurstOptions> = {
  maxGapMs: 50,
  minLength: 4,
  maxLength: 64,
};

export function createBurstDetector(options: BurstOptions = {}): BurstDetector {
  const { maxGapMs, minLength, maxLength } = { ...DEFAULT_BURST, ...options };
  let buffer = "";
  let last = 0;
  let overflow = false;

  const reset = () => {
    buffer = "";
    last = 0;
    overflow = false;
  };

  return {
    reset,
    feed({ key, time, editable, modified }): BurstOutcome {
      if (editable || modified) {
        reset();
        return { action: "ignore" };
      }
      if (key === "Enter") {
        const code = buffer;
        const valid = code.length >= minLength && !overflow;
        reset();
        return valid ? { action: "scan", code } : { action: "ignore" };
      }
      if (key.length === 1) {
        if (buffer && time - last > maxGapMs) reset(); // too slow: that was a person
        buffer += key;
        last = time;
        if (buffer.length > maxLength) {
          overflow = true;
          buffer = buffer.slice(0, maxLength);
        }
        return buffer.length >= 2 ? { action: "swallow" } : { action: "ignore" };
      }
      // Shift (upper-case letters) and similar modifiers appear inside bursts.
      if (key === "Shift" || key === "CapsLock" || key === "AltGraph") return { action: "ignore" };
      reset();
      return { action: "ignore" };
    },
  };
}

/** True when the element accepts typed text (so a burst there is not a scan). */
export function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !["button", "checkbox", "radio", "submit", "reset", "file", "image"].includes(type);
  }
  return false;
}
