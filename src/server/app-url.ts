import "server-only";
import { headers } from "next/headers";

/**
 * Public origin of the app, used to build links that leave the building (the
 * receipt share link in an SMS / e-mail). APP_URL (or AUTH_URL, which Auth.js
 * already uses for the same purpose) wins; on Vercel the production domain is
 * the next choice. Only when none is configured is the origin read from the
 * request (fine on a single-host install; set APP_URL behind unusual proxies).
 */
export async function appBaseUrl(): Promise<string> {
  const configured =
    process.env.APP_URL ||
    process.env.AUTH_URL ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "");
  if (configured) return configured.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? "http";
  return `${proto}://${host}`;
}
