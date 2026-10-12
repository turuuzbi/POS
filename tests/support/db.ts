import { db } from "@/server/db";

/** Empty every application table (TRUNCATE bypasses the append-only triggers by design). */
export async function resetDatabase(): Promise<void> {
  const tables = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map(({ tablename }) => `"public"."${tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

export { db };
