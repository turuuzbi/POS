import { describe, expect, it } from "vitest";
import { safeNextPath } from "./next-path";

describe("safeNextPath", () => {
  it.each([
    ["/dashboard", "/dashboard"],
    ["/settings/devices?tab=1#list", "/settings/devices?tab=1#list"],
    ["/dashboard/../register", "/register"],
  ])("keeps same-origin path %j", (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "",
    "dashboard",
    "//evil.example",
    "/\t/evil.example",
    "/\n/evil.example",
    "/\r/evil.example",
    "/\\evil.example",
    "\\/evil.example",
    "https://evil.example",
    "/%09/evil.example".replace("%09", "\t"),
    "javascript:alert(1)",
  ])("falls back to / for %j", (input) => {
    expect(safeNextPath(input)).toBe("/");
  });

  it("keeps an encoded slash as data, never as a second authority", () => {
    expect(safeNextPath("/%2F/evil.example")).toBe("/%2F/evil.example");
    expect(new URL(safeNextPath("/%2F/evil.example"), "https://pos.example").origin).toBe(
      "https://pos.example",
    );
  });

  it("percent-encodes non-ASCII so the Location header stays valid", () => {
    expect(safeNextPath("/dashboard?q=сүү")).toBe("/dashboard?q=%D1%81%D2%AF%D2%AF");
  });
});
