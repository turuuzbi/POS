import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface User {
    tokenVersion?: number;
    deviceId?: string | null;
  }
  interface Session {
    tokenVersion?: number;
    deviceId?: string | null;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    /** User.tokenVersion at sign-in; a mismatch invalidates the session. */
    tv?: number;
    /** Paired device the session was opened on (PIN sign-in), if any. */
    did?: string | null;
  }
}
