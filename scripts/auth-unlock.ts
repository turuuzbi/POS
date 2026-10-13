/**
 * Clear every password sign-in lock on one account — the way back in when an
 * attack has locked the account from everywhere you'd sign in.
 *
 *   pnpm auth:unlock owner@example.com
 */
import { config as loadDotenv } from "dotenv";
import { clearAccountThrottle } from "@/server/auth/throttle";
import { db } from "@/server/db";

// The environment is read lazily, so loading .env here is early enough.
loadDotenv({ quiet: true });

async function main() {
  const email = process.argv[2]?.trim();
  if (!email || !email.includes("@")) {
    console.error("Usage: pnpm auth:unlock <email>");
    process.exitCode = 2;
    return;
  }
  const cleared = await clearAccountThrottle(db, email);
  const user = await db.user.findUnique({ where: { email: email.toLowerCase() } });
  await db.auditLog.create({
    data: {
      actorId: null,
      action: "auth.unlock_account",
      entityType: "User",
      entityId: user?.id ?? null,
      meta: { via: "cli", buckets: cleared },
    },
  });
  console.warn(`Cleared ${cleared} sign-in lock bucket(s) for ${email}.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
