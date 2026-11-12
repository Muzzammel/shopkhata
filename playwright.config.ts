import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  // The e2e suite changes the local database destructively: the whole run holds its restore lock (scripts/restore-lock.mjs).
  globalSetup: "./tests/e2e/restore-lock.global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /pwa\.spec\.ts|maintenance\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    // Maintenance mode is global: it would refuse the writes of any test running beside it, so it runs alone, after
    // the Chromium suite (`--project=maintenance --no-deps` to run it by itself).
    { name: "maintenance", testMatch: /maintenance\.spec\.ts/, dependencies: ["chromium"], use: { ...devices["Desktop Chrome"] } },
    // The other engines run the critical-workflow smoke only; the full
    // financial suite stays on Chromium as the deterministic gate.
    { name: "firefox", testMatch: /cross-browser\.spec\.ts/, use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", testMatch: /cross-browser\.spec\.ts/, use: { ...devices["Desktop Safari"] } },
    {
      // A development server cannot start a page without its hot-reload
      // connection, so real offline page loads are verified on a production build.
      name: "pwa",
      testMatch: /pwa\.spec\.ts/,
      use: { ...devices["Desktop Chrome"], baseURL: "http://localhost:3100" },
    },
  ],
  webServer: [
    {
      command: "pnpm dev",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
    },
    {
      command: "pnpm build && pnpm exec next start -p 3100",
      url: "http://localhost:3100/login",
      env: { SHOPKHATA_ENV: "local" },
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
