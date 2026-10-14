/** Typed-input helpers for the register (money, percent, keypad editing). */
import { MINOR_PER_MAJOR, parseMoney, type Money } from "@/domain/money";

/** möngö -> the plain tögrög text the server's `moneyField` parses ("12500" / "12500.50"). */
export function moneyToInput(amount: Money): string {
  if (amount < 0n) throw new RangeError("moneyToInput: negative amount");
  const major = amount / MINOR_PER_MAJOR;
  const minor = amount % MINOR_PER_MAJOR;
  return minor === 0n ? major.toString() : `${major}.${minor.toString().padStart(2, "0")}`;
}

/** Tögrög typed on the keypad -> möngö; null when empty/invalid or above `max`. */
export function parseKeypadMoney(text: string, max?: Money): Money | null {
  if (!text) return null;
  const value = parseMoney(text);
  if (value === null) return null;
  return max !== undefined && value > max ? null : value;
}

const PERCENT = /^(\d{1,3})(?:[.,](\d{1,2}))?$/;

/** "12.5" -> 1250 bps. Valid range is 0.01% .. 100%. */
export function parsePercentBps(text: string): number | null {
  const match = PERCENT.exec(text.trim());
  if (!match) return null;
  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0") || "0");
  return bps >= 1 && bps <= 10_000 ? bps : null;
}

export interface KeypadOptions {
  /** Allow one decimal mark, up to `decimals` digits after it. */
  decimals?: number;
  maxLength?: number;
  /** Keep leading zeros (PINs): "007" stays "007". */
  leadingZeros?: boolean;
}

/**
 * Apply one keypad key to the typed text. Keys: "0".."9", ".", "00",
 * "backspace", "clear". Leading zeros collapse; a second "." is ignored.
 */
export function applyKeypad(text: string, key: string, options: KeypadOptions = {}): string {
  const { decimals = 0, maxLength = 12, leadingZeros = false } = options;
  if (key === "clear") return "";
  if (key === "backspace") return text.slice(0, -1);
  if (key === "." || key === ",") {
    if (decimals === 0 || text.includes(".")) return text;
    return text === "" ? "0." : `${text}.`;
  }
  if (!/^\d{1,2}$/.test(key)) return text;
  if (!leadingZeros && key === "00" && (text === "" || text === "0")) {
    return text === "" ? "0" : text;
  }
  let next = text + key;
  const dot = next.indexOf(".");
  if (dot !== -1 && next.length - dot - 1 > decimals) return text;
  if (dot === -1 && !leadingZeros) next = next.replace(/^0+(?=\d)/, "");
  return next.length > maxLength ? text : next;
}

/** Milli quantity -> plain typed text: 1250 -> "1.25", 3000 -> "3". */
export function qtyToInput(qtyMilli: number): string {
  const whole = Math.trunc(qtyMilli / 1000);
  const fraction = String(qtyMilli % 1000)
    .padStart(3, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
