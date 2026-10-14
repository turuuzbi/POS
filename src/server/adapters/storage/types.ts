/** Where uploaded files (product images) live. Implementations: local disk, Cloudflare R2. */
export interface StorageProvider {
  readonly name: "local" | "r2";
  /** Store `body` under `key` (e.g. "products/<uuid>.png"); returns the URL to save and serve. */
  put(key: string, body: Uint8Array, contentType: string): Promise<string>;
  /** Remove a file previously returned by `put`. Missing files and foreign URLs are ignored. */
  delete(url: string): Promise<void>;
}

/** Keys we generate: one folder, uuid name, known image extension. Anything else is refused. */
export const STORAGE_KEY = /^[a-z]+\/[0-9a-f-]{36}\.(?:jpg|png|webp)$/;

export function assertValidKey(key: string): void {
  if (!STORAGE_KEY.test(key)) throw new RangeError(`invalid storage key: ${key}`);
}
