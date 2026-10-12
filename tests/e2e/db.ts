import { Client } from "pg";

/**
 * Direct database access for e2e housekeeping only (never for assertions the
 * UI should make). Plain `pg`: Playwright's CommonJS loader can't import the
 * ESM-only generated Prisma client.
 *
 * Which database: E2E_DATABASE_URL if set; otherwise DATABASE_URL, but only
 * when testing the local server (no E2E_BASE_URL) — a remote target's
 * database is never guessed. Refuses anything but a dev/e2e/test database.
 */
function housekeepingUrl(): string | null {
  if (process.env.E2E_DATABASE_URL) return process.env.E2E_DATABASE_URL;
  if (process.env.E2E_BASE_URL) return null;
  return process.env.DATABASE_URL ?? null;
}

export async function withE2eDb(fn: (client: Client) => Promise<unknown>): Promise<void> {
  const url = housekeepingUrl();
  if (!url) {
    console.warn("e2e: no database for housekeeping (set E2E_DATABASE_URL); skipping resets");
    return;
  }
  const name = new URL(url).pathname.replace(/^\//, "");
  if (!/_(dev|e2e|test)$/.test(name)) {
    throw new Error(`Refusing e2e housekeeping on database "${name}"`);
  }
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

/** Seed users back to the default language. */
export function resetSeedLocales() {
  return withE2eDb((db) => db.query(`UPDATE "User" SET "locale" = NULL`));
}
