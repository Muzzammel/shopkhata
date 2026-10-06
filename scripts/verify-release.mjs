import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const onWindows = process.platform === "win32";
const pnpm = onWindows ? "pnpm.cmd" : "pnpm";
const command = (args) => onWindows
  ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", pnpm, ...args], { stdio: "inherit" })
  : spawnSync(pnpm, args, { stdio: "inherit" });

const gates = [
  ["frozen dependency install", ["install", "--frozen-lockfile"]],
  ["lint", ["lint"]],
  ["typecheck", ["typecheck"]],
  ["unit tests", ["test", "--run"]],
  ["production build", ["build"]],
  ["working tree whitespace check", ["exec", "git", "diff", "--check"]],
];

for (const [name, args] of gates) {
  console.log(`\n[release] ${name}`);
  const result = command(args);
  if (result.error || result.status !== 0) {
    console.error(`[release] BLOCKED at ${name} (exit ${result.status ?? "unavailable"}).`);
    process.exit(result.status || 1);
  }
}

const cli = fileURLToPath(new URL("../node_modules/supabase/dist/supabase.js", import.meta.url));
const status = spawnSync(process.execPath, [cli, "--agent", "no", "status", "-o", "env"], {
  encoding: "utf8",
  env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

if (status.error || status.status !== 0) {
  console.error("\n[release] NOT EXECUTED: local Supabase runtime is unavailable; reset, pgTAP, DB lint, migration-upgrade, integration, and browser gates remain required.");
  console.error("[release] No database reset, deployment, or production write was performed.");
  process.exit(2);
}

const databaseGates = [
  ["pgTAP database tests", ["test", "db", "--local"]],
  ["database lint", ["db", "lint", "--local", "--level", "warning", "--fail-on", "error"]],
];
for (const [name, args] of databaseGates) {
  console.log(`\n[release] ${name}`);
  const result = spawnSync(process.execPath, [cli, "--agent", "no", ...args], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`[release] BLOCKED at ${name} (exit ${result.status ?? "unavailable"}).`);
    process.exit(result.status || 1);
  }
}

const suites = [
  "test:migration-upgrade", "test:integration:batches", "test:integration:payments",
  "test:integration:overpayment", "test:integration:operations", "test:integration:customer-expenses",
  "test:integration:offline-excel", "test:integration:closing-reports", "test:integration:acceptance",
];
for (const name of suites) {
  console.log(`\n[release] ${name}`);
  const result = command([name]);
  if (result.error || result.status !== 0) {
    console.error(`[release] BLOCKED at ${name} (exit ${result.status ?? "unavailable"}).`);
    process.exit(result.status || 1);
  }
}
console.log("\n[release] serial browser suite");
const browser = command(["test:e2e", "--workers=1"]);
if (browser.error || browser.status !== 0) {
  console.error(`[release] BLOCKED at serial browser suite (exit ${browser.status ?? "unavailable"}).`);
  process.exit(browser.status || 1);
}

console.log("\n[release] PASS. No database reset, deployment, or production write was performed.");
