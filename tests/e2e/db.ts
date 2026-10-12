import { Client } from "pg";

/**
 * Direct database access for e2e housekeeping only (never for assertions the
 * UI should make). Plain `pg`: Playwright's CommonJS loader can't import the
 * ESM-only generated Prisma client. Refuses anything but a dev/e2e/test DB.
 */
export async function withE2eDb<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set (copy .env.example to .env)");
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/_(dev|e2e|test)$/.test(name)) {
    throw new Error(`Refusing e2e housekeeping on database "${name}"`);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Seed users back to the default language. */
export function resetSeedLocales() {
  return withE2eDb((db) => db.query(`UPDATE "User" SET "locale" = NULL`));
}
