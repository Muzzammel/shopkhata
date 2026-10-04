import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: { environment: "node", include: ["tests/integration/production-acceptance.test.ts"], testTimeout: 120_000, fileParallelism: false, maxWorkers: 1, pool: "forks" },
});
