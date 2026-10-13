import { config as loadDotenv } from "dotenv";
import { defineConfig } from "prisma/config";

// Values set on the command line win over .env — and a command-line
// DATABASE_URL must not be silently overridden by a DIRECT_DATABASE_URL that
// .env points at another database (e.g. Neon) for destructive commands.
const shellDatabaseUrl = process.env.DATABASE_URL;
// A direct URL from the environment (incl. Vercel's DATABASE_URL_UNPOOLED)
// always beats the pooled one: migrations break through a pooler.
const shellDirectUrl = process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL_UNPOOLED;
loadDotenv({ quiet: true });

function migrationUrl(): string | undefined {
  if (shellDirectUrl) return shellDirectUrl;
  if (shellDatabaseUrl) return shellDatabaseUrl;
  // `||`, not `??`: an empty DIRECT_DATABASE_URL="" falls back too.
  return (
    process.env.DIRECT_DATABASE_URL ||
    // Set automatically by Vercel's Neon integration.
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.DATABASE_URL ||
    undefined
  );
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx --conditions=react-server prisma/seed.ts",
  },
  datasource: {
    // Prisma Migrate needs a direct connection: a transaction pooler (Neon's
    // "-pooler" host / PgBouncer) breaks its session-level advisory lock.
    // The app itself connects with DATABASE_URL (src/server/db.ts).
    // Read from process.env (not prisma's env()) so `prisma generate` — e.g.
    // during `pnpm install` — works before any database is configured.
    url: migrationUrl(),
  },
});
