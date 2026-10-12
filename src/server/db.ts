import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, type Prisma } from "@/generated/prisma/client";
import { env } from "./env";

/** A Prisma client or an interactive-transaction client. */
export type Db = PrismaClient | Prisma.TransactionClient;
export type Tx = Prisma.TransactionClient;

function createClient(): PrismaClient {
  const { DATABASE_URL, DATABASE_POOL_MAX } = env();
  const adapter = new PrismaPg({ connectionString: DATABASE_URL, max: DATABASE_POOL_MAX });
  return new PrismaClient({ adapter });
}

// Reuse one client across hot reloads in development.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) globalForPrisma.prisma = createClient();
  return globalForPrisma.prisma;
}

/**
 * Lazily-initialised shared client: the connection pool is only created on
 * first query, so importing this module has no side effects.
 */
export const db: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property) {
    const client = getClient();
    const value = Reflect.get(client, property, client) as unknown;
    return typeof value === "function"
      ? (value as (...a: unknown[]) => unknown).bind(client)
      : value;
  },
});
