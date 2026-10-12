/**
 * Post-sign-in redirect target. Only same-origin paths survive: the value is
 * normalised with the same WHATWG URL parser browsers use, so tricks like
 * "/\t/evil.example" (tab/CR/LF are stripped → "//evil.example") or
 * backslashes can't turn it into an off-site URL. Non-ASCII is percent-encoded,
 * which also keeps the Location header valid.
 */
const BASE = "http://pos.invalid";

export function safeNextPath(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return "/";
  let url: URL;
  try {
    url = new URL(next, BASE);
  } catch {
    return "/";
  }
  if (url.origin !== BASE) return "/";
  const path = url.pathname + url.search + url.hash;
  return path.startsWith("//") ? "/" : path;
}
