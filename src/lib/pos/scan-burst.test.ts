import { describe, expect, it } from "vitest";
import { createBurstDetector, type BurstKey, type BurstOutcome } from "./scan-burst";

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
