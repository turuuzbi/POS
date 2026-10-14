import type { Client } from "pg";
import { sweepQuickKeyFixtures, withE2eDb } from "./db";

const FAVOURITES = 20;
const PER_CATEGORY_TAB = 8;

/**
 * Sweep what quick-keys.spec leaves behind, then make sure the seed's starter grid exists: when the location
 * has no favourites tab at all (it was wiped or never seeded), insert the same
 * grid prisma/seed.ts builds. Idempotent, and it never touches a grid that is
 * there.
 */
async function ensureSeedQuickKeys(db: Client) {
  await sweepQuickKeyFixtures(db);
  const location = await db.query(`SELECT id FROM "Location" WHERE "isActive" ORDER BY id LIMIT 1`);
  const locationId = location.rows[0]?.id as string | undefined;
  if (!locationId) return;
  const favourites = await db.query(
    `SELECT 1 FROM "QuickKey" WHERE "categoryId" IS NULL AND ("locationId" = $1 OR "locationId" IS NULL) LIMIT 1`,
    [locationId],
  );
  if (favourites.rows.length > 0) return;

  const products = await db.query(
    `SELECT p.id, p."categoryId", c.color FROM "Product" p JOIN "Category" c ON c.id = p."categoryId"
      WHERE p."isActive" AND p."type" = 'STANDARD' AND p."categoryId" IS NOT NULL
      ORDER BY p."createdAt", p.id`,
  );
  const byCategory = new Map<string, { id: string; color: string | null }[]>();
  for (const row of products.rows) {
    const list = byCategory.get(row.categoryId) ?? [];
    list.push({ id: row.id, color: row.color });
    byCategory.set(row.categoryId, list);
  }
  const queues = [...byCategory.values()].map((list) => [...list]);
  const chosen: { id: string; color: string | null }[] = [];
  for (let progressed = true; progressed && chosen.length < FAVOURITES;) {
    progressed = false;
    for (const queue of queues) {
      const next = queue.shift();
      if (next && chosen.length < FAVOURITES) {
        chosen.push(next);
        progressed = true;
      }
    }
  }
  const insert = (categoryId: string | null, position: number, p: { id: string }) =>
    db.query(
      `INSERT INTO "QuickKey" ("id", "locationId", "categoryId", "productId", "position")
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [locationId, categoryId, p.id, position],
    );
  for (const [position, p] of chosen.entries()) await insert(null, position, p);
  for (const [categoryId, list] of byCategory) {
    for (const [position, p] of list.slice(0, PER_CATEGORY_TAB).entries()) {
      await insert(categoryId, position, p);
    }
  }
}

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
    await ensureSeedQuickKeys(db);
  });
}
