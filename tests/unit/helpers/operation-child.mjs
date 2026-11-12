// Real child-process boundary exercising production inheritance and operation orchestration.
import { readFileSync, writeFileSync } from "node:fs";
import { withRestoreLock, queueRestoreCompletion } from "../../../scripts/restore-lock.mjs";
import { runRestoreChecks } from "../../../scripts/backup-verification.mjs";
import { operationDocker } from "./operation-docker.mjs";

const [root, mode, evidence, folder] = process.argv.slice(2);
const message = () => new Promise((resolve) => process.once("message", resolve));
const docker = operationDocker(root);
try {
  await withRestoreLock("supabase_db_shopkhata", `${mode} ${folder}`, async (owner) => {
    if (mode === "verify" || mode === "checked-crash") {
      await runRestoreChecks(evidence, async (_check, record) => {
        record({ manifestSha256: "a" });
        process.send({ held: true, mode, folder });
        await message();
      }, { complete: (value) => queueRestoreCompletion(owner, evidence, value, { docker }) });
      if (mode === "checked-crash") {
        process.send({ checked: true });
        await message();
      }
    } else {
      const read = readFileSync(evidence, "utf8");
      process.send({ held: true, mode, folder });
      const action = await message();
      if (action === "fail") throw new Error("simulated record write failure");
      // The database-write boundary is deliberately a file in this non-database fixture.
      writeFileSync(`${evidence}.recorded`, read);
    }
  }, { docker, exclusive: true });
  process.send({ done: true });
} catch (error) {
  process.send({ refused: true, error: error.message });
  process.exitCode = 1;
}
process.disconnect();
