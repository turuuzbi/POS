import { describe, expect, it } from "vitest";
import { parseQuantityPrefix } from "./quantity-prefix";

describe("parseQuantityPrefix", () => {
  it("reads a typed or scanned quantity prefix", () => {
    expect(parseQuantityPrefix("3*4901234567890")).toEqual({
      qtyMilli: 3000,
      code: "4901234567890",
    });
    expect(parseQuantityPrefix("0,5 x APPLE")).toEqual({ qtyMilli: 500, code: "APPLE" });
  });

  it("reports a prefix for SKUs that merely look like one, so the caller must try the whole text first", () => {
    // "2x4-BOARD" is a real SKU shape: the parser cannot know, the search box checks the raw text first.
    expect(parseQuantityPrefix("2x4-BOARD")).toEqual({ qtyMilli: 2000, code: "4-BOARD" });
  });

  it("returns null without a prefix", () => {
    expect(parseQuantityPrefix("4901234567890")).toBeNull();
    expect(parseQuantityPrefix("MILK-1L")).toBeNull();
  });
});
