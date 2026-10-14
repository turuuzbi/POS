import { describe, expect, it } from "vitest";
import {
  buildInternalEan13,
  generateInternalEan13,
  optionCombinations,
  parseOptionValues,
  reconcileVariants,
  sniffImageType,
} from "./product-form";
import { isValidEan13 } from "./scale-barcode";

describe("optionCombinations", () => {
  it("builds the cartesian product with the first option varying slowest", () => {
    expect(
      optionCombinations([
        { name: "Size", values: ["S", "M"] },
        { name: "Color", values: ["Black", "White"] },
      ]),
    ).toEqual([
      ["S", "Black"],
      ["S", "White"],
      ["M", "Black"],
      ["M", "White"],
    ]);
  });
  it("yields one empty row without options", () => {
    expect(optionCombinations([])).toEqual([[]]);
  });
});

describe("parseOptionValues", () => {
  it("trims, splits on commas/newlines and de-duplicates case-insensitively", () => {
    expect(parseOptionValues(" S, m\nM ;; L ,s")).toEqual(["S", "m", "L"]);
  });
});

describe("reconcileVariants", () => {
  type Row = { option1: string; option2: string; option3: string; sku: string };
  const create = (v: { option1: string; option2: string; option3: string }): Row => ({
    ...v,
    sku: "",
  });

  it("keeps rows whose combination survives and adds new ones", () => {
    const rows: Row[] = [
      { option1: "S", option2: "", option3: "", sku: "A" },
      { option1: "M", option2: "", option3: "", sku: "B" },
    ];
    const next = reconcileVariants([{ name: "Size", values: ["M", "L"] }], rows, create);
    expect(next.map((r) => [r.option1, r.sku])).toEqual([
      ["M", "B"],
      ["L", ""],
    ]);
  });
  it("collapses to a single row when all options are removed", () => {
    const rows: Row[] = [
      { option1: "S", option2: "", option3: "", sku: "A" },
      { option1: "M", option2: "", option3: "", sku: "B" },
    ];
    expect(reconcileVariants([], rows, create)).toEqual([
      { option1: "", option2: "", option3: "", sku: "A" },
    ]);
  });
  it("remaps rows when an option slot is removed or reordered", () => {
    type R = { option1: string; option2: string; option3: string; sku: string };
    const rows: R[] = [
      { option1: "Red", option2: "M", option3: "", sku: "RM" },
      { option1: "Red", option2: "L", option3: "", sku: "RL" },
      { option1: "Blue", option2: "M", option3: "", sku: "BM" },
    ];
    const previous = [
      { name: "Color", values: ["Red", "Blue"] },
      { name: "Size", values: ["M", "L"] },
    ];
    const swapped = reconcileVariants(
      [
        { name: "Size", values: ["M", "L"] },
        { name: "Color", values: ["Red", "Blue"] },
      ],
      rows,
      create,
      previous,
    );
    expect(swapped.map((r) => [r.option1, r.option2, r.sku])).toEqual([
      ["M", "Red", "RM"],
      ["M", "Blue", "BM"],
      ["L", "Red", "RL"],
      ["L", "Blue", ""],
    ]);
    // Removing Color: Size is now slot 1; rows keyed by size survive (first per size).
    const removed = reconcileVariants(
      [{ name: "Size", values: ["M", "L"] }],
      rows,
      create,
      previous,
    );
    expect(removed.map((r) => [r.option1, r.sku])).toEqual([
      ["M", "RM"],
      ["L", "RL"],
    ]);
    // A rename pairs positionally.
    const renamed = reconcileVariants(
      [
        { name: "Colour", values: ["Red", "Blue"] },
        { name: "Size", values: ["M", "L"] },
      ],
      rows,
      create,
      previous,
    );
    expect(renamed.filter((r) => r.sku).map((r) => r.sku)).toEqual(["RM", "RL", "BM"]);
  });
  it("keeps one row with cleared options when every option is removed", () => {
    const rows = [{ option1: "S", option2: "X", option3: "", sku: "A", id: "v1" }];
    const [only] = reconcileVariants([], rows, (v) => ({ ...v, sku: "", id: "" }), [
      { name: "Size", values: ["S"] },
    ]);
    expect(only).toEqual({ option1: "", option2: "", option3: "", sku: "A", id: "v1" });
  });
  it("creates a blank row when nothing exists", () => {
    expect(reconcileVariants([], [], create)).toEqual([
      { option1: "", option2: "", option3: "", sku: "" },
    ]);
  });
});

describe("internal EAN-13", () => {
  it("uses the 29 prefix and a valid check digit", () => {
    const code = buildInternalEan13("0000000001");
    expect(code.startsWith("29")).toBe(true);
    expect(isValidEan13(code)).toBe(true);
  });
  it("generates valid codes", () => {
    for (let i = 0; i < 50; i++) expect(isValidEan13(generateInternalEan13())).toBe(true);
  });
  it("rejects a malformed body", () => {
    expect(() => buildInternalEan13("123")).toThrow(RangeError);
  });
});

describe("sniffImageType", () => {
  it("recognises jpeg, png and webp by signature", () => {
    expect(sniffImageType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(
      "image/png",
    );
    const webp = new Uint8Array(12);
    webp.set([0x52, 0x49, 0x46, 0x46], 0);
    webp.set([0x57, 0x45, 0x42, 0x50], 8);
    expect(sniffImageType(webp)).toBe("image/webp");
  });
  it("rejects svg/html/gif", () => {
    expect(sniffImageType(new TextEncoder().encode("<svg xmlns="))).toBeNull();
    expect(sniffImageType(new TextEncoder().encode("GIF89a"))).toBeNull();
  });
});
