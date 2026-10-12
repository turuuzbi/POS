"use server";

import { AuthError } from "next-auth";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { APPROVABLE_PERMISSIONS } from "@/domain/permissions";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { grantApproval } from "../auth/approval";
import { readDeviceToken } from "../auth/device";
import { signIn, signOut } from "../auth/index";
import { pinLookup } from "../auth/pin";
import { db } from "../db";
import { ActionError, defineAction, definePublicAction } from "./define-action";

/** Only same-origin relative paths are allowed as post-login targets (no open redirects). */
function safeNextPath(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  return next;
}

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

/** Map Auth.js credential failures to our codes; rethrow anything else. */
function credentialsFailure(error: unknown): never {
  if (error instanceof AuthError) {
    const code = (error as AuthError & { code?: string }).code;
    throw new ActionError(code === "device" ? "DEVICE_REQUIRED" : "INVALID_CREDENTIALS");
  }
  throw error;
}

export const loginWithPassword = definePublicAction({
  name: "auth.loginWithPassword",
  input: z.object({
    email: z.string().trim().min(3).max(320),
    password: z.string().min(1).max(256),
    next: z.string().max(512).optional(),
  }),
  async run({ input }) {
    try {
      await signIn("password", { email: input.email, password: input.password, redirect: false });
    } catch (error) {
      credentialsFailure(error);
    }
    const user = await db.user.findUnique({
      where: { email: input.email.trim().toLowerCase() },
      select: { locale: true },
    });
    await applyPreferredLocale(user?.locale);
    // "/" routes each role to its home screen.
    redirect(safeNextPath(input.next));
  },
});

export const loginWithPin = definePublicAction({
  name: "auth.loginWithPin",
  input: z.object({ pin: z.string().regex(/^\d{4,8}$/) }),
  async run({ input }) {
    try {
      await signIn("pin", { pin: input.pin, redirect: false });
    } catch (error) {
      credentialsFailure(error);
    }
    const user = await db.user.findUnique({
      where: { pinLookup: pinLookup(input.pin) },
      select: { locale: true },
    });
    await applyPreferredLocale(user?.locale);
    redirect("/");
  },
});

export const logout = defineAction({
  name: "auth.logout",
  access: "authenticated",
  input: z.object({}),
  async run({ user }) {
    await signOut({ redirect: false });
    // On a paired register, go straight back to the PIN pad.
    const paired = user.deviceId !== null || (await readDeviceToken()) !== null;
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
    scope: z.string().min(1).max(200),
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
    if (result.reason === "DEVICE_REQUIRED") throw new ActionError("DEVICE_REQUIRED");
    if (result.reason === "NOT_PERMITTED") throw new ActionError("FORBIDDEN");
    throw new ActionError("INVALID_CREDENTIALS");
  },
});
