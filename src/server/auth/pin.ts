import "server-only";
import { z } from "zod";
import { hmacSha256 } from "../crypto";
import { env } from "../env";

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;
export const pinSchema = z.string().regex(/^\d{4,8}$/);

/**
 * Deterministic, keyed lookup value for a PIN. A PIN uniquely identifies a
 * staff member on a paired device, so it must be indexable; HMAC with a
 * server-side pepper means a database leak alone doesn't reveal PINs.
 */
export function pinLookup(pin: string): string {
  return hmacSha256(env().PIN_PEPPER, `pin:v1:${pin}`);
}

/** Reject PINs that are trivially guessed: one repeated digit or a straight run. */
export function isWeakPin(pin: string): boolean {
  const digits = [...pin].map(Number);
  if (digits.every((d) => d === digits[0])) return true;
  const ascending = digits.every((d, i) => i === 0 || d === ((digits[i - 1] ?? 0) + 1) % 10);
  const descending = digits.every((d, i) => i === 0 || d === ((digits[i - 1] ?? 0) + 9) % 10);
  return ascending || descending;
}
