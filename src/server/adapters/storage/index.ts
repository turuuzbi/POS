import "server-only";
import { createBlobStorage } from "./blob";
import { localStorage } from "./local";
import type { StorageProvider } from "./types";

export type { StorageProvider } from "./types";

/**
 * Vercel Blob when BLOB_READ_WRITE_TOKEN is set (production), otherwise
 * local disk under .data/uploads (development, tests, single-box installs).
 */
export function getStorage(): StorageProvider {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  return token ? createBlobStorage(token) : localStorage;
}
