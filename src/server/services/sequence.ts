import "server-only";
import type { Tx } from "../db";

/**
 * Gap-free document numbers ("PO-000123"). The counter row is incremented
 * inside the caller's transaction, so a rolled-back document gives its number
 * back and concurrent documents queue on the row lock.
 */
export const DOCUMENT_PREFIXES = {
  purchaseOrder: "PO",
  goodsReceipt: "GR",
  stocktake: "ST",
} as const;

export type DocumentKind = keyof typeof DOCUMENT_PREFIXES;

export async function nextSequenceValue(tx: Tx, key: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ value: number }[]>`
    INSERT INTO "Sequence" ("key", "value") VALUES (${key}, 1)
    ON CONFLICT ("key") DO UPDATE SET "value" = "Sequence"."value" + 1
    RETURNING "value"`;
  return Number(row!.value);
}

export function formatDocumentNumber(kind: DocumentKind, value: number): string {
  return `${DOCUMENT_PREFIXES[kind]}-${String(value).padStart(6, "0")}`;
}

export async function nextDocumentNumber(tx: Tx, kind: DocumentKind): Promise<string> {
  return formatDocumentNumber(kind, await nextSequenceValue(tx, `doc:${kind}`));
}
