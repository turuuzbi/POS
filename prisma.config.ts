import "dotenv/config";
import { defineConfig } from "prisma/config";

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
    // Read with process.env (not env()) so `prisma generate` — e.g. during
    // `pnpm install` — works before any database is configured.
    url: process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL,
  },
});
