import "server-only";
import { localStorage } from "./local";
import { createR2Storage, r2ConfigFromEnv } from "./r2";
import type { StorageProvider } from "./types";

export type { StorageProvider } from "./types";

/**
 * Cloudflare R2 when the R2_* variables are set (production), otherwise
 * local disk under .data/uploads (development, tests, single-box installs).
 */
export function getStorage(): StorageProvider {
  const config = r2ConfigFromEnv();
  return config ? createR2Storage(config) : localStorage;
}
