import { describe, expect, it } from "vitest";
import { LOCALES } from "@/i18n/config";
import en from "./en.json";
import mn from "./mn.json";

type Tree = { [key: string]: string | Tree };
const catalogs: Record<(typeof LOCALES)[number], Tree> = { mn, en };

function flatten(tree: Tree, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

/** Top-level ICU argument names, e.g. "{name}" or "{count, plural, …}" → name, count. */
function placeholders(message: string): string[] {
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    const char = message[i];
    if (char === "{") {
      if (depth === 0) {
        const match = /^\{\s*([A-Za-z0-9_]+)/.exec(message.slice(i));
        if (match?.[1]) names.add(match[1]);
      }
      depth++;
    } else if (char === "}") {
      depth--;
    }
  }
  return [...names].sort();
}

describe("message catalogs", () => {
  const reference = flatten(catalogs.mn);

  it.each(LOCALES)("%s has exactly the same keys as mn", (locale) => {
    const keys = [...flatten(catalogs[locale]).keys()].sort();
    expect(keys).toEqual([...reference.keys()].sort());
  });

  it.each(LOCALES)("%s uses the same placeholders as mn", (locale) => {
    const messages = flatten(catalogs[locale]);
    for (const [key, message] of reference) {
      expect(placeholders(messages.get(key) ?? ""), key).toEqual(placeholders(message));
    }
  });

  it.each(LOCALES)("%s has no empty messages and balanced braces", (locale) => {
    for (const [key, message] of flatten(catalogs[locale])) {
      expect(message.trim(), key).not.toBe("");
      const opens = (message.match(/\{/g) ?? []).length;
      const closes = (message.match(/\}/g) ?? []).length;
      expect(opens, key).toBe(closes);
    }
  });
});
