import { describe, expect, it } from "vitest";
import {
  createBurstDetector,
  createShortcutGuard,
  type BurstKey,
  type BurstOutcome,
} from "./scan-burst";

/** Feed a string as keystrokes `gap` ms apart; returns every outcome. */
function type(
  detector: ReturnType<typeof createBurstDetector>,
  text: string,
  { gap = 8, start = 1000, editable = false, enter = true } = {},
): { outcomes: BurstOutcome[]; end: number } {
  const outcomes: BurstOutcome[] = [];
  let time = start;
  const feed = (key: string) => {
    const event: BurstKey = { key, time, editable };
    outcomes.push(detector.feed(event));
    time += gap;
  };
  for (const char of text) feed(char);
  if (enter) feed("Enter");
  return { outcomes, end: time };
}

describe("scan burst detector", () => {
  it("recognises a fast burst ending in Enter as a scan", () => {
    const detector = createBurstDetector();
    const { outcomes } = type(detector, "8650001000019");
    expect(outcomes.at(-1)).toEqual({ action: "scan", code: "8650001000019" });
  });

  it("swallows the keys of an established burst but never the first one", () => {
    const detector = createBurstDetector();
    const { outcomes } = type(detector, "1234", { enter: false });
    expect(outcomes.map((o) => o.action)).toEqual(["ignore", "swallow", "swallow", "swallow"]);
  });

  it("treats slow typing as a person, not a scanner", () => {
    const detector = createBurstDetector();
    const { outcomes } = type(detector, "123456", { gap: 200 });
    expect(outcomes.some((o) => o.action === "scan")).toBe(false);
    expect(outcomes.some((o) => o.action === "swallow")).toBe(false);
  });

  it("restarts the buffer after a pause so earlier stray keys do not pollute the code", () => {
    const detector = createBurstDetector();
    const first = type(detector, "ab", { gap: 8 });
    const second = type(detector, "99887766", { start: first.end + 2000 });
    expect(second.outcomes.at(-1)).toEqual({ action: "scan", code: "99887766" });
  });

  it("ignores bursts shorter than the minimum length", () => {
    const detector = createBurstDetector({ minLength: 4 });
    const { outcomes } = type(detector, "123");
    expect(outcomes.at(-1)).toEqual({ action: "ignore" });
  });

  it("never touches keys typed into an editable field", () => {
    const detector = createBurstDetector();
    const { outcomes } = type(detector, "8650001000019", { editable: true });
    expect(outcomes.every((o) => o.action === "ignore")).toBe(true);
  });

  it("ignores shortcuts with a modifier", () => {
    const detector = createBurstDetector();
    expect(detector.feed({ key: "a", time: 1, editable: false, modified: true })).toEqual({
      action: "ignore",
    });
  });

  it("allows Shift inside a burst (upper-case codes)", () => {
    const detector = createBurstDetector();
    let t = 0;
    const outcomes: BurstOutcome[] = [];
    for (const key of ["A", "Shift", "B", "C", "D", "Enter"]) {
      outcomes.push(detector.feed({ key, time: (t += 6), editable: false }));
    }
    expect(outcomes.at(-1)).toEqual({ action: "scan", code: "ABCD" });
  });

  it("drops bursts longer than the maximum length", () => {
    const detector = createBurstDetector({ maxLength: 8 });
    const { outcomes } = type(detector, "123456789012");
    expect(outcomes.at(-1)).toEqual({ action: "ignore" });
  });

  it("a bare Enter is not a scan", () => {
    const detector = createBurstDetector();
    expect(detector.feed({ key: "Enter", time: 5, editable: false })).toEqual({ action: "ignore" });
  });

  it("does not carry a finished code into the next one", () => {
    const detector = createBurstDetector();
    const first = type(detector, "11112222");
    const second = type(detector, "33334444", { start: first.end + 500 });
    expect(second.outcomes.at(-1)).toEqual({ action: "scan", code: "33334444" });
  });
});

describe("createShortcutGuard", () => {
  const key = (
    k: string,
    time: number,
    extra: { defaultPrevented?: boolean; repeat?: boolean } = {},
  ) => ({
    key: k,
    time,
    defaultPrevented: false,
    repeat: false,
    ...extra,
  });

  it("lets a deliberate '/' through and ignores one inside a fast burst", () => {
    const guard = createShortcutGuard();
    expect(guard.ignore(key("/", 1000))).toBe(false);
    // scanner: 'A' 'B' '/' 8ms apart
    const burst = createShortcutGuard();
    expect(burst.ignore(key("A", 2000))).toBe(false);
    expect(burst.ignore(key("B", 2008))).toBe(false); // the wedge swallows this one itself
    expect(burst.ignore(key("/", 2016))).toBe(true);
    expect(burst.ignore(key("?", 2024))).toBe(true);
  });

  it("ignores swallowed events and held keys, never function keys in a burst", () => {
    const guard = createShortcutGuard();
    expect(guard.ignore(key("/", 1000, { defaultPrevented: true }))).toBe(true);
    expect(guard.ignore(key("/", 3000, { repeat: true }))).toBe(true);
    expect(guard.ignore(key("F2", 3010))).toBe(false);
  });

  it("a Shift keydown right before '?' does not make it part of a burst", () => {
    const guard = createShortcutGuard();
    expect(guard.ignore(key("/", 1000))).toBe(false);
    expect(guard.ignore(key("Shift", 1400))).toBe(false);
    expect(guard.ignore(key("?", 1410))).toBe(false);
    expect(guard.ignore(key("Shift", 1420))).toBe(false);
    expect(guard.ignore(key("?", 1430))).toBe(false); // two quick keys: still a person
  });

  it("a person typing at normal speed is not a burst", () => {
    const guard = createShortcutGuard();
    expect(guard.ignore(key("a", 1000))).toBe(false);
    expect(guard.ignore(key("/", 1300))).toBe(false);
  });
});
