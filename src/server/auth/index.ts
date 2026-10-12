import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import {
  verifyPasswordSignIn,
  verifyPinSignIn,
  type AuthenticatedUser,
  type SignInResult,
} from "./credentials";
import { deviceTokenFromCookieHeader } from "./device";

/** Shift-length sessions: a cashier's sign-in doesn't outlive the working day. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

/** Failure codes surfaced through CredentialsSignin.code. */
export const SIGN_IN_CODES = {
  invalid: "invalid",
  device: "device",
  locked: "locked",
  rateLimited: "rate_limited",
} as const;

class SignInFailed extends CredentialsSignin {
  constructor(code: string) {
    super();
    this.code = code;
  }
}

const FAILURE_CODE: Record<Exclude<SignInResult, { ok: true }>["reason"], string> = {
  INVALID: SIGN_IN_CODES.invalid,
  DEVICE_REQUIRED: SIGN_IN_CODES.device,
  LOCKED: SIGN_IN_CODES.locked,
  RATE_LIMITED: SIGN_IN_CODES.rateLimited,
};

const passwordInput = z.object({ email: z.string().max(320), password: z.string().max(256) });
const pinInput = z.object({ pin: z.string().max(16) });

/**
 * Request-scoped record of the user our own authorize() verified. Auth.js's
 * signIn() can return normally on failure (e.g. when the caller sends
 * `X-Auth-Return-Redirect` or a malformed callback-url cookie), so success
 * must never be inferred from "signIn() did not throw".
 */
const signInScope = new AsyncLocalStorage<{ user?: AuthenticatedUser }>();

function requestContext(request: Request) {
  return {
    ip:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  };
}

function toAuthUser(result: SignInResult) {
  if (!result.ok) throw new SignInFailed(FAILURE_CODE[result.reason]);
  const store = signInScope.getStore();
  if (store) store.user = result.user;
  const { user } = result;
  return { id: user.id, name: user.name, tokenVersion: user.tokenVersion, deviceId: user.deviceId };
}

/**
 * Auth.js v5 with two credentials providers and stateless JWT sessions
 * (horizontally scalable). Every request re-validates the user against the
 * database in `getCurrentUser()` (active, tokenVersion, device binding,
 * not signed out), so revocations take effect immediately.
 *
 * The /api/auth/* route handler is intentionally NOT mounted: sign-in and
 * sign-out run through server actions only.
 */
export const { auth, signIn, signOut } = NextAuth(() => ({
  secret: env().AUTH_SECRET,
  trustHost: true,
  session: { strategy: "jwt", maxAge: SESSION_MAX_AGE_SECONDS },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      id: "password",
      credentials: { email: {}, password: {} },
      async authorize(raw, request) {
        const input = passwordInput.safeParse(raw);
        if (!input.success) throw new SignInFailed(SIGN_IN_CODES.invalid);
        return toAuthUser(await verifyPasswordSignIn(db, input.data, requestContext(request)));
      },
    }),
    Credentials({
      id: "pin",
      credentials: { pin: {} },
      async authorize(raw, request) {
        const input = pinInput.safeParse(raw);
        if (!input.success) throw new SignInFailed(SIGN_IN_CODES.invalid);
        const deviceToken = deviceTokenFromCookieHeader(request.headers.get("cookie"));
        return toAuthUser(
          await verifyPinSignIn(db, { pin: input.data.pin, deviceToken }, requestContext(request)),
        );
      },
    }),
  ],
  callbacks: {
    jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.sid = randomUUID(); // lets sign-out revoke this session server-side
        token.tv = user.tokenVersion;
        token.did = user.deviceId ?? null;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      session.sid = token.sid;
      session.tokenVersion = token.tv;
      session.deviceId = token.did ?? null;
      return session;
    },
  },
  logger: {
    error(error) {
      // Wrong credentials are expected traffic, not server errors.
      if (error instanceof CredentialsSignin || error.name === "CredentialsSignin") return;
      console.error(error);
    },
  },
}));

/**
 * Sign in through Auth.js and return the user verified by our authorize(),
 * or null. Throws CredentialsSignin (with a SIGN_IN_CODES code) on known
 * failures; any other error is an infrastructure failure.
 */
export async function signInVerified(
  provider: "password" | "pin",
  fields: Record<string, string>,
): Promise<AuthenticatedUser | null> {
  const holder: { user?: AuthenticatedUser } = {};
  await signInScope.run(holder, () => signIn(provider, { ...fields, redirect: false }));
  return holder.user ?? null;
}

export { CredentialsSignin };
