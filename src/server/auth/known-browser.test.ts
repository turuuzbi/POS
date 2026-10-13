import { describe, expect, it } from "vitest";
import { knownBrowserFor, rememberBrowser } from "./known-browser";

describe("known-browser cookie", () => {
  it("recognises the accounts that signed in from this browser, and only those", () => {
    const first = rememberBrowser(null, "account-a");
    const browserId = first.split(".")[0];
    expect(knownBrowserFor(first, "account-a")).toBe(browserId);
    expect(knownBrowserFor(first, "account-b")).toBeNull();

    const both = rememberBrowser(first, "account-b");
    expect(both.split(".")[0]).toBe(browserId);
    expect(knownBrowserFor(both, "account-a")).toBe(browserId);
    expect(knownBrowserFor(both, "account-b")).toBe(browserId);
  });

  it("doesn't grow when the same account signs in again", () => {
    const once = rememberBrowser(null, "account-a");
    expect(rememberBrowser(once, "account-a")).toBe(once);
  });

  it("keeps at most five accounts, most recent first", () => {
    let cookie = rememberBrowser(null, "account-0");
    for (let i = 1; i <= 6; i++) cookie = rememberBrowser(cookie, `account-${i}`);
    expect(cookie.split(".")).toHaveLength(6);
    expect(knownBrowserFor(cookie, "account-6")).not.toBeNull();
    expect(knownBrowserFor(cookie, "account-0")).toBeNull();
  });

  it.each([
    null,
    "",
    "garbage",
    `${"A".repeat(22)}.${"B".repeat(22)}`,
    `${"A".repeat(22)}.${"B".repeat(23)}`,
    "x".repeat(1000),
  ])("rejects malformed or forged values (%j)", (value) => {
    expect(knownBrowserFor(value, "account-a")).toBeNull();
  });

  it("starts a fresh browser id when the old cookie is unreadable", () => {
    const cookie = rememberBrowser("garbage", "account-a");
    expect(cookie).toMatch(/^[\w-]{22}\.[\w-]{22}$/);
  });
});
