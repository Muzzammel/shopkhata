// Local harness entry point: acquire BEFORE destructive setup, hold through server teardown.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { INHERIT_ENV, withRestoreLock } from "./restore-lock.mjs";

/** @param {string} command @param {string[]} args @param {{run?: (command: string, args: string[], options: object) => {status: number | null, error?: Error, signal?: string | null}, env?: Record<string, string | undefined>, docker?: import('./restore-lock.mjs').Docker}} [options] */
export async function runLockedCommand(command, args, { run = spawnSync, ...deps } = {}) {
  if (!command) throw new Error("A harness command is required.");
  return withRestoreLock("supabase_db_shopkhata", `local harness ${command}`, async (owner) => {
    const child = run(command, args, { stdio: "inherit", windowsHide: true, env: {
      ...process.env, [INHERIT_ENV.id]: owner.id, [INHERIT_ENV.token]: owner.token,
    } });
    if (child.error || child.signal || child.status !== 0) throw new Error(`Local harness failed (${child.signal || child.status || child.error?.message}).`);
    return 0;
  }, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--assert") {
      const { inheritRestoreLock } = await import("./restore-lock.mjs");
      inheritRestoreLock("supabase_db_shopkhata", process.env);
    } else await runLockedCommand(process.argv[2], process.argv.slice(3));
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
