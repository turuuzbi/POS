/**
 * What a cashier types or scans into the "find the sale" box. Three shapes:
 *  - a receipt number ("UB1-000123"; a Code 128 barcode or a hand-typed text),
 *  - the receipt's share link / QR text (".../receipt/<token>"),
 *  - a bare sale id (some QR printers encode it).
 * Nothing here trusts the text: the server validates and scopes the lookup.
 */

export type ReceiptKey =
  | { kind: "number"; number: string }
  | { kind: "token"; token: string }
  | { kind: "id"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;
/** "<LOCATION CODE>-<digits>", e.g. UB1-000123 (also E2E-AB12CD style codes). */
const NUMBER = /^[A-Z0-9]{1,12}-[A-Z0-9]{1,12}$/;

export const MAX_RECEIPT_INPUT = 300;

/** Parse the raw box text; null when it cannot be any of the shapes. */
export function parseReceiptInput(raw: string): ReceiptKey | null {
  const text = raw.trim();
  if (!text || text.length > MAX_RECEIPT_INPUT) return null;

  if (/^https?:\/\//i.test(text) || text.includes("/receipt/")) {
    const match = /\/receipt\/(?:refund\/)?([^/?#\s]+)/i.exec(text);
    const piece = match?.[1];
    if (!piece) return null;
    if (UUID.test(piece)) return { kind: "id", id: piece.toLowerCase() };
    return TOKEN.test(piece) ? { kind: "token", token: piece } : null;
  }
  if (UUID.test(text)) return { kind: "id", id: text.toLowerCase() };

  // Scanners and keyboards differ in case, and some insert spaces or a dash variant.
  const normalised = text
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s+/g, "")
    .toUpperCase();
  if (NUMBER.test(normalised)) return { kind: "number", number: normalised };
  return null;
}

/** A search box entry for the recent-sales list (digits or part of a number). */
export function normaliseSearch(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase().slice(0, 40);
}
