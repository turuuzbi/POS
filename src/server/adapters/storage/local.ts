import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertValidKey, STORAGE_KEY, type StorageProvider } from "./types";

/** Public path prefix served by src/app/api/uploads/[...key]/route.ts. */
export const LOCAL_URL_PREFIX = "/api/uploads/";

export const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function root(): string {
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.UPLOAD_DIR ??
      path.join(process.cwd(), ".data", "uploads"),
  );
}

/** Absolute path for a validated key, guaranteed to sit inside the upload root. */
function resolveKey(key: string): string {
  assertValidKey(key);
  const base = root();
  const file = path.resolve(base, key);
  if (!file.startsWith(base + path.sep)) throw new RangeError("storage key escapes root");
  return file;
}

export function keyFromLocalUrl(url: string): string | null {
  if (!url.startsWith(LOCAL_URL_PREFIX)) return null;
  const key = url.slice(LOCAL_URL_PREFIX.length);
  return STORAGE_KEY.test(key) ? key : null;
}

export const localStorage: StorageProvider & {
  read(key: string): Promise<{ body: Buffer; contentType: string } | null>;
} = {
  name: "local",
  async put(key, body) {
    const file = resolveKey(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    return LOCAL_URL_PREFIX + key;
  },
  async delete(url) {
    const key = keyFromLocalUrl(url);
    if (key) await rm(resolveKey(key), { force: true });
  },
  async read(key) {
    if (!STORAGE_KEY.test(key)) return null;
    const contentType = CONTENT_TYPE_BY_EXTENSION[key.slice(key.lastIndexOf(".") + 1)];
    if (!contentType) return null;
    try {
      return { body: await readFile(/*turbopackIgnore: true*/ resolveKey(key)), contentType };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
};
