// Non-database daemon substitute shared by real sibling processes. mkdirSync supplies the
// same atomic unique-name primitive as Docker create; no real Docker executable is invoked.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function operationDocker(root) {
  const ok = (stdout) => ({ ok: true, stdout, stderr: "" });
  const fail = (stderr) => ({ ok: false, stdout: "", stderr });
  const db = "supabase_db_shopkhata";
  return (args) => {
    if (args[0] === "info") return ok("unit-test-engine");
    if (args[1] === "inspect" && args.at(-1) === db) {
      if (args[3] === "{{.Image}}") return ok(`sha256:${"7".repeat(64)}`);
      return ok(JSON.stringify({ Id: "d".repeat(64), Name: `/${db}`, Image: `sha256:${"7".repeat(64)}`, State: { Running: true }, Config: { Image: "public.ecr.aws/supabase/postgres:17.11.0.003", Labels: { "com.supabase.cli.project": "shopkhata", "com.docker.compose.project": "shopkhata" } }, NetworkSettings: { Ports: { "5432/tcp": [{ HostIp: "0.0.0.0", HostPort: "55322" }] } } }));
    }
    const find = (ref) => {
      for (const name of readdirSync(root)) {
        try {
          const entry = JSON.parse(readFileSync(join(root, name, "container.json"), "utf8"));
          if (entry.Id === ref || entry.Name === `/${ref}`) return { name, entry };
        } catch { /* another process may be completing creation or removal */ }
      }
      return null;
    };
    if (args[1] === "inspect") {
      const found = find(args.at(-1));
      return found ? ok(JSON.stringify(found.entry)) : fail("No such container");
    }
    if (args[1] === "create") {
      const name = args[args.indexOf("--name") + 1];
      try { mkdirSync(join(root, name)); } catch (error) {
        if (error.code === "EEXIST") return fail("Conflict: already in use");
        throw error;
      }
      const labels = Object.fromEntries(readFileSync(args[args.indexOf("--label-file") + 1], "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
      const entry = { Id: randomBytes(32).toString("hex"), Name: `/${name}`, Config: { Labels: labels } };
      writeFileSync(join(root, name, "container.json"), JSON.stringify(entry));
      return ok(entry.Id);
    }
    if (args[1] === "rm") {
      const found = find(args[2]);
      if (!found) return fail("No such container");
      rmSync(join(root, found.name), { recursive: true });
      return ok(found.entry.Id);
    }
    return fail("Unexpected fake Docker call");
  };
}
