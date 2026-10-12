import "server-only";
import { headers } from "next/headers";

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Client IP and user agent for audit records. On Vercel the platform sets
 * x-forwarded-for / x-real-ip; elsewhere they are only as trustworthy as
 * the reverse proxy in front of the app.
 */
export async function requestMeta(): Promise<RequestMeta> {
  try {
    const h = await headers();
    const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
    return {
      ip: forwarded || h.get("x-real-ip") || null,
      userAgent: h.get("user-agent"),
    };
  } catch {
    return { ip: null, userAgent: null }; // outside a request (scripts, tests)
  }
}
