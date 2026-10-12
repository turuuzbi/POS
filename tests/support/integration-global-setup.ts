import { execFileSync } from "node:child_process";
import { testDatabaseUrl } from "./test-database";

/**
 * Bring the dedicated test database up to the latest migrations once per run
 * (non-destructive). Each test file then isolates itself by truncating the
 * tables it uses (see support/db.ts).
 */
export default function setup() {
  const url = testDatabaseUrl();
  const database = new URL(url).pathname.replace(/^\//, "");
  if (!database.endsWith("_test")) {
    throw new Error(`Refusing to run integration tests against a non-test database: "${database}"`);
  }
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: url },
  });
}
