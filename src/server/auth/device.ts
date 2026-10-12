import "server-only";
import { cookies } from "next/headers";
import { randomToken, sha256 } from "../crypto";
import type { Db } from "../db";

/**
 * Register devices. A manager pairs a browser/tablet to a location (and
 * optionally a register); the browser keeps a 256-bit secret in an httpOnly
 * cookie and the database stores only its SHA-256. PIN sign-in and manager
 * approvals are accepted only from a paired, non-revoked device.
 */

const SECURE_COOKIES = process.env.NODE_ENV === "production";
/** `__Host-` pins the cookie to this exact origin over HTTPS (no Domain, Path=/). */
export const DEVICE_COOKIE = SECURE_COOKIES ? "__Host-pos_device" : "pos_device";
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60; // browsers cap cookie lifetime at 400 days

export interface PairDeviceInput {
  locationId: string;
  registerId: string | null;
  name: string;
  pairedById: string;
}

/** Create the device row and return the plaintext secret (shown to nobody; set as cookie). */
export async function createDevice(client: Db, input: PairDeviceInput) {
  const token = randomToken(32);
  const device = await client.device.create({
    data: {
      locationId: input.locationId,
      registerId: input.registerId,
      name: input.name,
      pairedById: input.pairedById,
      tokenHash: sha256(token),
    },
  });
  return { device, token };
}

export async function findActiveDevice(client: Db, token: string | null | undefined) {
  if (!token || token.length < 32 || token.length > 128) return null;
  const device = await client.device.findUnique({
    where: { tokenHash: sha256(token) },
    include: { location: { select: { id: true, name: true, isActive: true } }, register: true },
  });
  if (!device || device.revokedAt || !device.location.isActive) return null;
  if (device.register && !device.register.isActive) return null;
  return device;
}

export type ActiveDevice = NonNullable<Awaited<ReturnType<typeof findActiveDevice>>>;

/** Read the device secret from a raw Cookie header (Auth.js authorize() gets a Request). */
export function deviceTokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === DEVICE_COOKIE) {
      try {
        return decodeURIComponent(part.slice(index + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function readDeviceToken(): Promise<string | null> {
  return (await cookies()).get(DEVICE_COOKIE)?.value ?? null;
}

const cookieOptions = {
  httpOnly: true,
  secure: SECURE_COOKIES,
  sameSite: "strict",
  path: "/",
} as const;

export async function setDeviceCookie(token: string): Promise<void> {
  (await cookies()).set(DEVICE_COOKIE, token, { ...cookieOptions, maxAge: DEVICE_COOKIE_MAX_AGE });
}

export async function clearDeviceCookie(): Promise<void> {
  // Same attributes as when set, or a `__Host-` cookie deletion is ignored.
  (await cookies()).set(DEVICE_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}
