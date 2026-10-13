import "server-only";
import { deriveKey, hmacSha256, randomToken, safeEqual } from "../crypto";
import { env } from "../env";

/**
 * "Known browser" cookies (OWASP's device-cookie defence against lockout
 * attacks). After a successful password sign-in, the browser keeps a signed
 * cookie naming the accounts it has signed in to. Later attempts for one of
 * those accounts from that browser are throttled in a bucket of their own,
 * instead of the per-source and account-wide buckets an attacker can fill —
 * so someone on the shop's Wi-Fi, or a botnet, can't lock the owner out of
 * the browser they always use. The cookie grants nothing else: the password
 * is still required, and its own bucket still limits guessing.
 *
 * Format: `<browserId>.<tag>.<tag>…`, one tag per account,
 * tag = HMAC(browserId + emailKey). Unforgeable without AUTH_SECRET, and it
 * reveals no email.
 */

const SECURE_COOKIES = process.env.NODE_ENV === "production";
export const KNOWN_BROWSER_COOKIE = SECURE_COOKIES ? "__Host-pos_kb" : "pos_kb";
export const KNOWN_BROWSER_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
/** Accounts remembered per browser (a shared back-office PC). */
const MAX_ACCOUNTS = 5;

const PART = /^[A-Za-z0-9_-]{22}$/;

export const knownBrowserCookieOptions = {
  httpOnly: true,
  secure: SECURE_COOKIES,
  sameSite: "lax",
  path: "/",
  maxAge: KNOWN_BROWSER_MAX_AGE_SECONDS,
} as const;

function tagFor(browserId: string, account: string): string {
  return hmacSha256(deriveKey(env().AUTH_SECRET, "known-browser"), `${browserId}:${account}`).slice(
    0,
    22,
  );
}

function parse(value: string | null | undefined): { browserId: string; tags: string[] } | null {
  if (!value || value.length > 23 * (MAX_ACCOUNTS + 1)) return null;
  const [browserId, ...tags] = value.split(".");
  if (!browserId || !PART.test(browserId) || tags.length > MAX_ACCOUNTS) return null;
  if (!tags.every((tag) => PART.test(tag))) return null;
  return { browserId, tags };
}

/** The browser id if this cookie proves an earlier sign-in to `account`, else null. */
export function knownBrowserFor(value: string | null | undefined, account: string): string | null {
  const cookie = parse(value);
  if (!cookie) return null;
  const expected = tagFor(cookie.browserId, account);
  return cookie.tags.some((tag) => safeEqual(tag, expected)) ? cookie.browserId : null;
}

/** The cookie value to set after `account` signed in from this browser. */
export function rememberBrowser(value: string | null | undefined, account: string): string {
  const cookie = parse(value);
  const browserId = cookie?.browserId ?? randomToken(16);
  const tag = tagFor(browserId, account);
  const others = (cookie?.tags ?? []).filter((t) => t !== tag);
  return [browserId, tag, ...others].slice(0, MAX_ACCOUNTS + 1).join(".");
}
