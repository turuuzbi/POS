import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const serverOnlyStub = fileURLToPath(
  new URL("./tests/support/server-only-stub.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    // `server-only` throws outside the react-server condition; tests run plain Node.
    alias: { "server-only": serverOnlyStub },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx", "messages/**/*.test.ts"],
          environment: "node",
          setupFiles: ["tests/support/test-secrets.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/integration/**/*.test.ts"],
          environment: "node",
          globalSetup: ["tests/support/integration-global-setup.ts"],
          // next-auth imports "next/server" without an extension; let Vite
          // resolve it (as Next's bundler does) instead of Node's strict ESM.
          server: { deps: { inline: ["next-auth", "@auth/core"] } },
          setupFiles: ["tests/support/integration-env.ts"],
          // One shared database: run files serially, tests isolate via truncation.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
