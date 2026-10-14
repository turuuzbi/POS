import "server-only";
import { AwsClient } from "aws4fetch";
import { assertValidKey, type StorageProvider } from "./types";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public base URL of the bucket (custom domain or r2.dev), no trailing slash. */
  publicUrl: string;
}

/** R2 settings from the environment, or null when any is missing (use local disk). */
export function r2ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID;
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const bucket = env.R2_BUCKET;
  const publicUrl = env.R2_PUBLIC_URL?.replace(/\/+$/, "");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) return null;
  if (!publicUrl.startsWith("https://")) throw new Error("R2_PUBLIC_URL must be an https URL");
  return { accountId, accessKeyId, secretAccessKey, bucket, publicUrl };
}

/**
 * Cloudflare R2 over its S3-compatible API (SigV4 via aws4fetch). Objects are
 * public and immutable (keys carry a uuid), served from `publicUrl`.
 */
export function createR2Storage(config: R2Config): StorageProvider {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const objectUrl = (key: string) =>
    `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`;
  const publicPrefix = `${config.publicUrl}/`;
  return {
    name: "r2",
    async put(key, body, contentType) {
      assertValidKey(key);
      const response = await client.fetch(objectUrl(key), {
        method: "PUT",
        headers: {
          "content-type": contentType,
          "cache-control": "public, max-age=31536000, immutable",
        },
        body: Buffer.from(body),
      });
      if (!response.ok) throw new Error(`r2 upload failed: ${response.status}`);
      return publicPrefix + key;
    },
    async delete(url) {
      if (!url.startsWith(publicPrefix)) return; // not ours
      const key = url.slice(publicPrefix.length);
      try {
        assertValidKey(key);
      } catch {
        return;
      }
      const response = await client.fetch(objectUrl(key), { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new Error(`r2 delete failed: ${response.status}`);
      }
    },
  };
}
