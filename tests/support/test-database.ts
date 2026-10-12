/**
 * Integration tests run against a dedicated database, never the dev one.
 * TEST_DATABASE_URL wins; otherwise DATABASE_URL's database name gets a
 * `_test` suffix (pos_dev → pos_test).
 */
import "dotenv/config";

export function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error("Set TEST_DATABASE_URL or DATABASE_URL for integration tests");
  const url = new URL(base);
  const name = url.pathname.replace(/^\//, "");
  url.pathname = `/${name.replace(/_dev$/, "")}_test`;
  return url.toString();
}
