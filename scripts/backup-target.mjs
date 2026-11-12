import { dockerCli, pinLocalDocker } from "./restore-lock.mjs";

const refuse = () => { throw new Error("Unsupported or ambiguous database target; use the exact local 127.0.0.1:55322/postgres target or an explicitly confirmed hosted Supabase project."); };

export function classifyDatabaseTarget(value) {
  let url;
  try { url = new URL(value); } catch { return refuse(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash || url.pathname !== "/postgres") return refuse();
  if (url.hostname === "127.0.0.1" && url.port === "55322" && ["postgres", "supabase_admin"].includes(url.username)) return "local";
  if (/^db\.[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) && url.username === "postgres" && (!url.port || url.port === "5432")) return "hosted";
  if (/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) && /^postgres\.[a-z0-9]{20}$/.test(url.username) && ["5432", "6543"].includes(url.port)) return "hosted";
  return refuse();
}

// Both the SQL and Storage endpoints must belong to this local stack on the pinned engine.
export function assertLocalEndpoint(container, port, internal, { docker = dockerCli } = {}) {
  if (docker === dockerCli) pinLocalDocker();
  const result = docker(["container", "inspect", "--format", "{{json .}}", container]);
  let info;
  try { info = JSON.parse(result.stdout); } catch { return refuse(); }
  const bindings = info.NetworkSettings?.Ports?.[`${internal}/tcp`];
  if (!result.ok || info.Name !== `/${container}` || info.Config?.Labels?.["com.supabase.cli.project"] !== "shopkhata"
      || !info.State?.Running || !bindings?.some((b) => ["127.0.0.1", "0.0.0.0"].includes(b.HostIp) && b.HostPort === String(port))) return refuse();
  return info.Id;
}

export function validateRestoreEndpoints(dbUrl, apiUrl) {
  const kind = classifyDatabaseTarget(dbUrl);
  const api = new URL(apiUrl);
  if (api.username || api.password || api.search || api.hash || api.pathname !== "/") return refuse();
  if (kind === "local") {
    if (api.origin !== "http://127.0.0.1:55321") return refuse();
    assertLocalEndpoint("supabase_db_shopkhata", 55322, 5432);
    assertLocalEndpoint("supabase_kong_shopkhata", 55321, 8000);
  } else {
    const db = new URL(dbUrl);
    const ref = db.hostname.startsWith("db.") ? db.hostname.split(".")[1] : db.username.split(".")[1];
    if (api.origin !== `https://${ref}.supabase.co`) return refuse();
  }
  return kind;
}
