import "server-only";
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token with `bytes` bytes of entropy (default 32 = 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

export function hmacSha256(key: string | Buffer, value: string): string {
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Derive an independent sub-key from a master secret, so one AUTH_SECRET can
 * sign several token types without cross-protocol confusion.
 */
export function deriveKey(masterSecret: string, purpose: string): Buffer {
  return Buffer.from(hkdfSync("sha256", masterSecret, "pos.v1", purpose, 32));
}
