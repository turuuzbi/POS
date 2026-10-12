import "server-only";
import { hash, verify } from "@node-rs/argon2";
import { z } from "zod";
import { randomToken } from "../crypto";

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

let dummyHash: Promise<string> | undefined;

/**
 * Spend the same time as a real verification when the account doesn't exist,
 * so response timing doesn't reveal which emails are registered.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomToken());
  await verifyPassword(await dummyHash, password);
}
