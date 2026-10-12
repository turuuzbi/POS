import "server-only";
import NextAuth, { CredentialsSignin } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";
import { verifyPasswordSignIn, verifyPinSignIn, type SignInResult } from "./credentials";
import { deviceTokenFromCookieHeader } from "./device";

/** Shift-length sessions: a cashier's sign-in doesn't outlive the working day. */
export const SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

class InvalidCredentials extends CredentialsSignin {
  override code = "invalid";
}
class DeviceNotPaired extends CredentialsSignin {
  override code = "device";
}

const passwordInput = z.object({ email: z.string().max(320), password: z.string().max(256) });
const pinInput = z.object({ pin: z.string().max(16) });

function requestContext(request: Request) {
  return {
    ip:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  };
}

function toAuthUser(result: SignInResult) {
  if (!result.ok)
    throw result.reason === "DEVICE_REQUIRED" ? new DeviceNotPaired() : new InvalidCredentials();
  const { user } = result;
  return { id: user.id, name: user.name, tokenVersion: user.tokenVersion, deviceId: user.deviceId };
}

/**
 * Auth.js v5 with two credentials providers and stateless JWT sessions
 * (horizontally scalable; no session table). Every request that matters
 * re-validates the user against the database in `getCurrentUser()`, so
 * deactivation or a role change takes effect immediately via `tokenVersion`.
 *
 * The /api/auth/* route handler is intentionally NOT mounted: sign-in and
 * sign-out run through server actions only, which keeps the attack surface
 * to the two credential checks below.
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
        if (!input.success) throw new InvalidCredentials();
        return toAuthUser(await verifyPasswordSignIn(db, input.data, requestContext(request)));
      },
    }),
    Credentials({
      id: "pin",
      credentials: { pin: {} },
      async authorize(raw, request) {
        const input = pinInput.safeParse(raw);
        if (!input.success) throw new InvalidCredentials();
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
        token.tv = user.tokenVersion;
        token.did = user.deviceId ?? null;
      }
      return token;
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
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
