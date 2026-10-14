import { getCurrentUser } from "@/server/auth/session";
import { localStorage } from "@/server/adapters/storage/local";

/**
 * Serves locally stored uploads (dev / single-box installs) to signed-in
 * users only. The key is validated against a strict pattern (no traversal),
 * the content type comes from our own extension map, and the response can
 * never be sniffed or rendered as a document.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ key: string[] }> }) {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });

  const key = (await params).key.join("/");
  const file = await localStorage.read(key);
  if (!file) return new Response(null, { status: 404 });

  return new Response(new Uint8Array(file.body), {
    headers: {
      "content-type": file.contentType,
      "content-length": String(file.body.length),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": "inline",
      // File names are random and never reused, so the bytes behind a URL never change.
      "cache-control": "private, max-age=31536000, immutable",
    },
  });
}
