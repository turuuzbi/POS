import "dotenv/config";
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * E2E runs against a production build (`next start`) and a seeded database.
 * Locally that's your dev database (`pnpm db:seed` first) and the build is
 * made fresh unless a server is already running; CI builds in an earlier
 * step. global-setup.ts resets the state the tests depend on (seed users'
 * language, lockouts, devices paired by earlier runs).
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE lets a pre-installed Chromium be used when
 * the bundled revision isn't downloaded.
 */
export default defineConfig({
  testDir: "tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "mn-MN",
    timezoneId: "Asia/Ulaanbaatar",
  },
  projects: [
    {
      name: "tablet",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1180, height: 820 },
        hasTouch: true,
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {},
      },
    },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: process.env.CI
          ? `pnpm start --port ${PORT}`
          : `pnpm build && pnpm start --port ${PORT}`,
        url: `${baseURL}/login`,
        // Lets the register specs read an OPEN Shift row they insert, before the shifts service exists.
        env: { POS_E2E_SHIFT_FALLBACK: "1" },
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      },
});
