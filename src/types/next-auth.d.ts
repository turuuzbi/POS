import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    tokenVersion?: number;
    deviceId?: string | null;
  }
  interface Session {
    /** Session id; sign-out records it in RevokedSession. */
    sid?: string;
    tokenVersion?: number;
    deviceId?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** Session id, minted at sign-in. */
    sid?: string;
    /** User.tokenVersion at sign-in; a mismatch invalidates the session. */
    tv?: number;
    /** Paired device the session was opened on (PIN sign-in), if any. */
    did?: string | null;
  }
}
