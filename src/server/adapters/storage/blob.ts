import "server-only";
import { assertValidKey, type StorageProvider } from "./types";

const API = "https://blob.vercel-storage.com";
const API_VERSION = "12";

/**
 * Vercel Blob over its REST API (no SDK dependency). Public, immutable
 * objects with random-suffix-free keys: our keys already carry a uuid.
 */
export function createBlobStorage(token: string): StorageProvider {
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${token}`,
    "x-api-version": API_VERSION,
    ...extra,
  });
  return {
    name: "blob",
    async put(key, body, contentType) {
      assertValidKey(key);
      const response = await fetch(`${API}/${key}`, {
        method: "PUT",
        headers: headers({
          "x-content-type": contentType,
          "x-add-random-suffix": "0",
          "x-cache-control-max-age": "31536000",
        }),
        body: Buffer.from(body),
      });
      if (!response.ok) throw new Error(`blob upload failed: ${response.status}`);
      const { url } = (await response.json()) as { url?: unknown };
      if (typeof url !== "string" || !url.startsWith("https://")) {
        throw new Error("blob upload returned no url");
      }
      return url;
    },
    async delete(url) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        return;
      }
      if (!host.endsWith(".public.blob.vercel-storage.com")) return; // not ours
      const response = await fetch(`${API}/delete`, {
        method: "POST",
        headers: headers({ "content-type": "application/json" }),
        body: JSON.stringify({ urls: [url] }),
      });
      if (!response.ok) throw new Error(`blob delete failed: ${response.status}`);
    },
  };
}
