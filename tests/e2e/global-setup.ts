import { withE2eDb } from "./db";

/**
 * Make runs independent of earlier runs (or of normal dev use): seed users
 * back to the default language, no lockouts, and devices paired by previous
 * e2e runs revoked.
 */
export default async function globalSetup() {
  await withE2eDb(async (db) => {
    await db.query(`UPDATE "User" SET "locale" = NULL`);
    await db.query(`DELETE FROM "AuthThrottle"`);
    await db.query(
      `UPDATE "Device" SET "revokedAt" = now() WHERE "name" LIKE 'E2E %' AND "revokedAt" IS NULL`,
    );
  });
}
