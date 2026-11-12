import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

import { restoreLock } from "./tests/integration/restore-lock.config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    // Holds the local database's restore lock for the whole run (scripts/restore-lock.mjs).
    ...restoreLock,
    environment: "node",
    include: ["tests/integration/payments/**/*.test.ts"],
    testTimeout: 60_000,
    fileParallelism: false,
    maxWorkers: 1,
    pool: "forks",
  },
});
