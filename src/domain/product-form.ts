/**
 * Pure helpers behind the product form: variant matrix generation, internal
 * EAN-13 barcodes and image validation. No I/O; shared by client and server.
 */
import { ean13CheckDigit } from "./scale-barcode";

export interface OptionDraft {
  name: string;
  values: string[];
}

/** Prefix of store-internal EAN-13 codes (GS1 reserves 20-29 for in-store use). */
export const INTERNAL_BARCODE_PREFIX = "29";

/** Cartesian product of option values, in option order (first option varies slowest). */
export function optionCombinations(options: readonly OptionDraft[]): string[][] {
  const usable = options.filter((o) => o.values.length > 0);
  return usable.reduce<string[][]>(
    (rows, option) => rows.flatMap((row) => option.values.map((value) => [...row, value])),
    [[]],
  );
}

/** Split free text ("S, M\nL") into trimmed, de-duplicated option values. */
export function parseOptionValues(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of text.split(/[,\n;]/)) {
    const value = part.trim();
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      out.push(value);
    }
  }
  return out;
}

export interface MatrixRow {
  option1: string;
  option2: string;
  option3: string;
}

const rowKey = (values: readonly (string | null | undefined)[]) =>
  values.map((v) => v ?? "").join("\u0000");

/** The options that take part in the matrix, in slot order (option1..3 follow this order). */
export function usableOptions(options: readonly OptionDraft[]): OptionDraft[] {
  return options.filter((o) => o.name.trim() && o.values.length > 0);
}

const nameKey = (name: string) => name.trim().toLowerCase();

/**
 * Reconcile variant rows with the option values: keep rows whose combination
 * still exists (so SKU, price and ids survive), drop the rest, add new
 * combinations via `create`. Rows come back in matrix order.
 *
 * `previous` are the options the rows' option1..3 were generated from (slot
 * order). Rows are remapped to the new slot order by option name (options
 * that were renamed pair up positionally), so removing or reordering an
 * option keeps the variants. Without options the product has a single
 * variant: the first existing row, with its option values cleared.
 */
export function reconcileVariants<R extends MatrixRow>(
  options: readonly OptionDraft[],
  rows: readonly R[],
  create: (values: MatrixRow, template: R | undefined) => R,
  previous?: readonly OptionDraft[],
): R[] {
  const usable = usableOptions(options);
  if (usable.length === 0) {
    return rows.length
      ? [{ ...rows[0]!, option1: "", option2: "", option3: "" }]
      : [create({ option1: "", option2: "", option3: "" }, undefined)];
  }
  const old = previous ? usableOptions(previous) : usable;
  // Old slot of each new slot: by name first, then leftover options in order (renames).
  const oldSlot: number[] = usable.map(() => -1);
  const taken = new Set<number>();
  usable.forEach((option, j) => {
    const i = old.findIndex((o, k) => !taken.has(k) && nameKey(o.name) === nameKey(option.name));
    if (i >= 0) {
      oldSlot[j] = i;
      taken.add(i);
    }
  });
  usable.forEach((_, j) => {
    if (oldSlot[j] !== -1) return;
    const i = old.findIndex((_o, k) => !taken.has(k));
    if (i >= 0) {
      oldSlot[j] = i;
      taken.add(i);
    }
  });
  const byKey = new Map<string, R>();
  for (const row of rows) {
    const slots = [row.option1, row.option2, row.option3];
    const key = rowKey(oldSlot.map((i) => (i >= 0 ? slots[i] : "")));
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return optionCombinations(usable).map((combo) => {
    const values: MatrixRow = {
      option1: combo[0] ?? "",
      option2: combo[1] ?? "",
      option3: combo[2] ?? "",
    };
    const kept = byKey.get(rowKey(combo));
    return kept ? { ...kept, ...values } : create(values, rows[0]);
  });
}

/** A valid EAN-13 from 10 body digits: "29" + body + check digit. */
export function buildInternalEan13(body: string): string {
  if (!/^\d{10}$/.test(body)) throw new RangeError("buildInternalEan13: expected 10 digits");
  const first12 = INTERNAL_BARCODE_PREFIX + body;
  return first12 + String(ean13CheckDigit(first12));
}

/** Random internal EAN-13. `random` yields uniform integers in [0, 10). */
export function generateInternalEan13(
  random: () => number = () => {
    // Rejection sampling keeps digits uniform.
    for (;;) {
      const byte = crypto.getRandomValues(new Uint8Array(1))[0]!;
      if (byte < 250) return byte % 10;
    }
  },
): string {
  let body = "";
  for (let i = 0; i < 10; i++) body += String(random());
  return buildInternalEan13(body);
}

export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;
export type ImageType = keyof typeof IMAGE_TYPES;

/** Identify an image by its magic bytes (never trust the client's MIME type). */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const startsWith = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) {
    return "image/webp";
  }
  return null;
}
