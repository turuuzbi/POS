import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guard rail: every server action must go through defineAction /
 * definePublicAction (validation + authorisation + safe errors). This scans
 * the source so a hand-rolled "use server" export fails CI.
 */
const ROOT = join(__dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "generated" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts") ? [path] : [];
  });
}

const files = sourceFiles(ROOT).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));
const DIRECTIVE = /^\s*["']use server["'];?\s*$/m;
const isServerModule = (text: string) =>
  /^\s*["']use server["']/.test(text.replace(/^\s*\/\/.*\n/gm, ""));

describe("server actions", () => {
  const serverModules = files.filter((f) => isServerModule(f.text));

  it("exist only under src/server/actions", () => {
    expect(serverModules.length).toBeGreaterThan(0);
    for (const { path } of serverModules)
      expect(path.startsWith("server/actions/"), path).toBe(true);
  });

  it("never use inline 'use server' functions", () => {
    for (const { path, text } of files) {
      const occurrences = text.match(new RegExp(DIRECTIVE.source, "gm"))?.length ?? 0;
      expect(occurrences - (isServerModule(text) ? 1 : 0), path).toBe(0);
    }
  });

  it("export only defineAction / definePublicAction results", () => {
    for (const { path, text } of serverModules) {
      const exports = text.match(/^export\s+.*$/gm) ?? [];
      expect(exports.length, path).toBeGreaterThan(0);
      for (const line of exports) {
        expect(line, `${path}: ${line}`).toMatch(
          /^export const \w+ = (defineAction|definePublicAction)\(\{$/,
        );
      }
    }
  });
});
