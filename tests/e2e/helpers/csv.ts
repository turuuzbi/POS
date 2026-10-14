import { expect, type Locator, type Page } from "@playwright/test";
import { withE2eDb } from "../db";
import { enterPin, mn, SEED, signInWithPassword, signOut } from "../fixtures";

/** Short random token so every run creates uniquely named data. */
export function token(): string {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** A valid EAN-13 starting with 2 (in-store range) built from random digits. */
export function randomEan13(): string {
  const first12 = `2${Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join("")}`;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
  return first12 + String((10 - (sum % 10)) % 10);
}

/** Run a read-only query against the e2e database and return the rows. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  let rows: T[] = [];
  await withE2eDb(async (db) => {
    rows = (await db.query(sql, params)).rows as T[];
  });
  return rows;
}

/** RFC 4180 cell: quoted when needed. */
export function cell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A CSV text with CRLF line endings and a UTF-8 BOM. */
export function csv(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => cells.map(cell).join(",");
  return `﻿${[header, ...rows].map(line).join("\r\n")}\r\n`;
}

export function csvFile(content: string | Buffer, name = "import.csv") {
  return { name, mimeType: "text/csv", buffer: Buffer.from(content) };
}

/** Record console errors, page errors and failed/erroring network requests. */
export function watchProblems(page: Page): { problems: string[] } {
  const state = { problems: [] as string[] };
  page.on("console", (msg) => {
    if (msg.type() === "error") state.problems.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => state.problems.push(`pageerror: ${err.message}`));
  page.on("requestfailed", (req) => {
    const reason = req.failure()?.errorText ?? "";
    // Navigations away abort in-flight RSC prefetches; that is not a failure.
    if (!reason.includes("ERR_ABORTED")) state.problems.push(`failed: ${req.url()} ${reason}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) state.problems.push(`http ${res.status()}: ${res.url()}`);
  });
  return state;
}

export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

export async function signInAsOwner(page: Page) {
  await signInWithPassword(page, SEED.owner.email);
  await expect(page).toHaveURL(/\/dashboard$/);
}

/** Pair the browser as a till (as the manager), then sign in as the cashier by PIN. */
export async function signInAsCashier(page: Page) {
  await signInWithPassword(page, SEED.manager.email);
  await page.goto("/settings/devices");
  await page.getByLabel(mn.devices.name).fill(`E2E csv ${token()}`);
  await page.getByRole("button", { name: mn.devices.pair }).click();
  await expect(page.getByText(mn.devices.paired)).toBeVisible();
  await signOut(page, SEED.manager.name, mn.auth.signOut);
  await enterPin(page, SEED.cashier.pin);
  await expect(page).toHaveURL(/\/register$/);
}

// ── Import page helpers ──────────────────────────────────────────────────

export const t = mn.importExport;

export function fileInput(page: Page): Locator {
  return page.getByLabel(t.import.file);
}

export async function chooseAndPreview(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
) {
  await fileInput(page).setInputFiles(file);
  await page.getByRole("button", { name: t.import.preview, exact: true }).click();
}

/** The number shown in a summary tile ("Шинэ бараа" → 3). */
export function summaryValue(page: Page, label: string): Locator {
  return page
    .locator("dl > div")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");
}

/** The issues table rows as [line, column, message]. */
export function issueRows(page: Page): Locator {
  return page.locator("section[aria-labelledby=import-issues] tbody tr");
}
