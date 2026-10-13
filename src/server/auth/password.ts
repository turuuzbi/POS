import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";

/** OWASP baseline for argon2id (the library default algorithm): 19 MiB, t=2, p=1. */
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export const PASSWORD_MIN_LENGTH = 10;
export const passwordSchema = z.string().min(PASSWORD_MIN_LENGTH).max(256);

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false; // malformed hash → treat as mismatch
  }
}

/**
 * A fixed argon2id hash of a random, discarded secret, made with
 * ARGON2_OPTIONS. Built in rather than computed on first use, so the first
 * miss on a fresh server instance costs the same as every other one.
 */
const DUMMY_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$+Lfu/LkJZaErr5yKfeA6+Q$mE2QEj9xpBti8vevRrtcbwNO3t0TVaHJNaDH8o41K3Q";

/**
 * Spend the same time as a real verification when the account doesn't exist
 * (or the attempt is refused), so response timing doesn't reveal which
 * emails are registered.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, password);
}
