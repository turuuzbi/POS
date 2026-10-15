import "server-only";
import { deriveKey, hmacSha256, safeEqual } from "../crypto";
import { env } from "../env";

/**
 * Share tokens for credit notes (refund receipts) and void slips.
 *
 * `Refund` has no token column and the service slice owns the only migration,
 * so these tokens are derived, not stored:
 *
 *     token = base64url(16-byte id) "." base64url(HMAC-SHA256(key, kind ":" id))
 *
 * The key is `deriveKey(AUTH_SECRET, "credit-note-token")`, independent of the
 * approval-token and throttle keys. Without the server secret the signature
 * (256 bits) cannot be produced, so a token is unguessable even though the
 * refund/sale id inside it is not secret. The signature covers the KIND, so a
 * refund token never opens a void slip (or the reverse), and a sale's
 * `publicToken` has a different shape and is rejected by the shape check.
 * Verification is shape check -> constant-time signature compare -> only then
 * a database lookup by id. Rotating AUTH_SECRET invalidates every issued
 * credit-note link (the sale receipt links, which are stored, keep working).
 */
export type CreditNoteKind = "refund" | "void";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 16 bytes -> 22 base64url chars, "." and a 32-byte HMAC -> 43 chars. */
const TOKEN = /^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/;

function signingKey(): Buffer {
  return deriveKey(env().AUTH_SECRET, "credit-note-token");
}

const sign = (kind: CreditNoteKind, hex: string) => hmacSha256(signingKey(), `${kind}:${hex}`);

/** Token for a refund id or a (voided) sale id; null if `id` is not a UUID. */
export function creditNoteToken(kind: CreditNoteKind, id: string): string | null {
  if (!UUID.test(id)) return null;
  const hex = id.replaceAll("-", "").toLowerCase();
  return `${Buffer.from(hex, "hex").toString("base64url")}.${sign(kind, hex)}`;
}

/** Cheap shape check done before any crypto or database work. */
export function isPlausibleCreditNoteToken(token: string): boolean {
  return TOKEN.test(token);
}

/** The id a token was issued for, or null if the token is malformed, tampered or of another kind. */
export function verifyCreditNoteToken(kind: CreditNoteKind, token: string): string | null {
  if (!TOKEN.test(token)) return null;
  const [idPart, signature] = token.split(".") as [string, string];
  const bytes = Buffer.from(idPart, "base64url");
  // Non-canonical base64url (stray trailing bits) must not alias a valid token.
  if (bytes.length !== 16 || bytes.toString("base64url") !== idPart) return null;
  const hex = bytes.toString("hex");
  if (!safeEqual(signature, sign(kind, hex))) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
