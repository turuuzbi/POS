import { describe, expect, it } from "vitest";
import {
  addQuickKeyInputSchema,
  isPermutation,
  moveId,
  tileTextClass,
  toTileColor,
} from "./quick-keys";

const uuid = "0190a000-0000-7000-8000-000000000001";

describe("moveId", () => {
  it("swaps with the neighbour", () => {
    expect(moveId(["a", "b", "c"], "b", "earlier")).toEqual(["b", "a", "c"]);
    expect(moveId(["a", "b", "c"], "b", "later")).toEqual(["a", "c", "b"]);
  });
  it("stays put at the ends and for unknown ids", () => {
    expect(moveId(["a", "b"], "a", "earlier")).toEqual(["a", "b"]);
    expect(moveId(["a", "b"], "b", "later")).toEqual(["a", "b"]);
    expect(moveId(["a", "b"], "x", "later")).toEqual(["a", "b"]);
  });
});

describe("isPermutation", () => {
  it("accepts reorders only", () => {
    expect(isPermutation(["a", "b"], ["b", "a"])).toBe(true);
    expect(isPermutation(["a", "b"], ["a"])).toBe(false);
    expect(isPermutation(["a", "b"], ["a", "a"])).toBe(false);
    expect(isPermutation(["a", "b"], ["a", "c"])).toBe(false);
  });
});

describe("colours", () => {
  it("only accepts palette colours", () => {
    const base = { locationId: uuid, categoryId: null, productId: uuid };
    expect(addQuickKeyInputSchema.safeParse({ ...base, color: "red" }).success).toBe(true);
    expect(addQuickKeyInputSchema.safeParse({ ...base, color: null }).success).toBe(true);
    expect(addQuickKeyInputSchema.safeParse({ ...base }).success).toBe(true);
    expect(addQuickKeyInputSchema.safeParse({ ...base, color: "hotpink" }).success).toBe(false);
  });
  it("maps non-palette seed colours and picks readable text", () => {
    expect(toTileColor("sky")).toBe("blue");
    expect(toTileColor("red")).toBe("red");
    expect(toTileColor("nope")).toBeNull();
    expect(tileTextClass("blue")).toBe("text-white");
    expect(tileTextClass("amber")).toBe("text-black");
    expect(tileTextClass(null)).toBe("text-foreground");
  });
});
