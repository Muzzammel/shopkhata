import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
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
      testIgnore: /pwa\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
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
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
