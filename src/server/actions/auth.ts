"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { APPROVABLE_PERMISSIONS } from "@/domain/permissions";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { isApprovalScope } from "@/domain/discounts";
import { isCashMovementApprovalScope } from "@/domain/shift-contract";
import { grantApproval } from "../auth/approval";
import { readDeviceToken } from "../auth/device";
import { KNOWN_BROWSER_COOKIE, knownBrowserCookieOptions } from "../auth/known-browser";
import { auth, CredentialsSignin, SIGN_IN_CODES, signInVerified, signOut } from "../auth/index";
import { safeNextPath } from "../auth/next-path";
import { db } from "../db";
import { ActionError, defineAction, definePublicAction } from "./define-action";

/** Carry the user's saved language preference into the locale cookie. */
async function applyPreferredLocale(locale: string | null | undefined) {
  if (isLocale(locale)) {
    (await cookies()).set(LOCALE_COOKIE, locale, {
      path: "/",
      sameSite: "lax",
      maxAge: 31_536_000,
    });
  }
}

/**
 * Sign in and return the user our own authorize() verified. Known credential
 * failures become typed action errors; anything else (database down, …)
 * propagates and is reported as INTERNAL — never as "wrong password".
 */
async function verifiedSignIn(provider: "password" | "pin", fields: Record<string, string>) {
  let verified;
  try {
    verified = await signInVerified(provider, fields);
  } catch (error) {
    if (!(error instanceof CredentialsSignin)) throw error;
    switch (error.code) {
      case SIGN_IN_CODES.device:
        throw new ActionError("DEVICE_REQUIRED");
      case SIGN_IN_CODES.locked:
      case SIGN_IN_CODES.rateLimited:
        throw new ActionError("RATE_LIMITED");
      default:
        throw new ActionError("INVALID_CREDENTIALS");
    }
  }
  const { user, knownBrowser } = verified;
  if (!user) throw new ActionError("INVALID_CREDENTIALS");
  if (knownBrowser) {
    (await cookies()).set(KNOWN_BROWSER_COOKIE, knownBrowser, knownBrowserCookieOptions);
  }
  return user;
}

export const loginWithPassword = definePublicAction({
  name: "auth.loginWithPassword",
  input: z.object({
    email: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(256),
    next: z.string().max(512).optional(),
  }),
  async run({ input }) {
    const user = await verifiedSignIn("password", { email: input.email, password: input.password });
    await applyPreferredLocale(user.locale);
    // "/" routes each role to its home screen.
    redirect(safeNextPath(input.next));
  },
});

export const loginWithPin = definePublicAction({
  name: "auth.loginWithPin",
  input: z.object({ pin: z.string().regex(/^\d{4,8}$/) }),
  async run({ input }) {
    const user = await verifiedSignIn("pin", { pin: input.pin });
    await applyPreferredLocale(user.locale);
    redirect("/");
  },
});

/**
 * Sign out (or "lock" / "switch user" on a register). Public on purpose: it
 * must work even when the session has already become invalid, so a stale
 * screen can always be left. The session id is revoked server-side, so a
 * copied session cookie stops working too.
 */
export const logout = definePublicAction({
  name: "auth.logout",
  input: z.object({}),
  async run({ user }) {
    const session = await auth();
    if (session?.sid) {
      const expiresAt = new Date(session.expires);
      await db.revokedSession.upsert({
        where: { sid: session.sid },
        update: {},
        create: { sid: session.sid, expiresAt },
      });
    }
    await signOut({ redirect: false });
    // On a paired register, go straight back to the PIN pad.
    const paired = (user?.deviceId ?? null) !== null || (await readDeviceToken()) !== null;
    redirect(paired ? "/pin" : "/login");
  },
});

/**
 * A manager types their PIN on the cashier's paired device to approve one
 * gated action. Returns a short-lived token bound to permission + scope +
 * device, which the gated action verifies before proceeding.
 */
export const requestApproval = defineAction({
  name: "auth.requestApproval",
  access: "authenticated",
  input: z.object({
    pin: z.string().regex(/^\d{4,8}$/),
    permission: z.enum(APPROVABLE_PERMISSIONS),
    scope: z
      .string()
      .max(200)
      .refine((scope) => isApprovalScope(scope) || isCashMovementApprovalScope(scope)),
  }),
  async run({ input, user, meta }) {
    const result = await grantApproval(
      db,
      {
        pin: input.pin,
        deviceToken: await readDeviceToken(),
        permission: input.permission,
        scope: input.scope,
        requestedById: user.id,
      },
      meta,
    );
    if (result.ok) return { token: result.token, approverName: result.approverName };
    switch (result.reason) {
      case "DEVICE_REQUIRED":
        throw new ActionError("DEVICE_REQUIRED");
      case "LOCKED":
        throw new ActionError("RATE_LIMITED");
      default:
        throw new ActionError("INVALID_CREDENTIALS");
    }
  },
});
