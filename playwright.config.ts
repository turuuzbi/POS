import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3100);
const baseURL = process.env.E2E_BASE_URL ?? `http://localhost:${PORT}`;

/**
 * E2E runs against a production build (`next start`) and a seeded database.
 * Locally that's your dev database (`pnpm db:seed` first); CI provisions a
 * fresh one. PLAYWRIGHT_CHROMIUM_EXECUTABLE lets a pre-installed Chromium be
 * used when the bundled revision isn't downloaded.
 */
export default defineConfig({
  testDir: "tests/e2e",
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
        command: `pnpm start --port ${PORT}`,
        url: `${baseURL}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
