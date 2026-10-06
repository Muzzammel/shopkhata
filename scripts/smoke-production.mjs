const smokeArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const target = smokeArgs.find((arg) => !arg.startsWith("--"));
const allowLocal = smokeArgs.includes("--allow-local");
if (!target) {
  console.error("Usage: pnpm smoke:production -- https://YOUR-PRODUCTION-DOMAIN");
  process.exit(2);
}

let base;
try { base = new URL(target); } catch {
  console.error("Production smoke target must be a valid HTTPS URL.");
  process.exit(2);
}
const isLocal = ["localhost", "127.0.0.1", "::1"].includes(base.hostname);
if ((base.protocol !== "https:" && !(allowLocal && isLocal && base.protocol === "http:")) || (isLocal && !allowLocal)) {
  console.error("Target must use HTTPS. For a local production build only, pass http://localhost:<port> with --allow-local.");
  process.exit(2);
}

const check = async (path, validate) => {
  const url = new URL(path, base);
  const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
  const issue = validate(response);
  if (issue) throw new Error(`${path}: ${issue}`);
  console.log(`[smoke] PASS ${path} (${response.status})`);
  return response;
};

try {
  const login = await check("/login", (response) => response.status !== 200 ? `expected 200, got ${response.status}` : null);
  if (!login.headers.has("content-security-policy")) throw new Error("/login: missing content-security-policy response header");
  if (login.headers.get("x-content-type-options") !== "nosniff") throw new Error("/login: x-content-type-options must be nosniff");
  if (login.headers.get("x-frame-options") !== "DENY") throw new Error("/login: x-frame-options must be DENY");
  if (!(login.headers.get("content-security-policy") ?? "").includes("frame-ancestors 'none'")) {
    throw new Error("/login: Content-Security-Policy must prevent framing");
  }

  const manifestResponse = await check("/manifest.webmanifest", (response) => response.status !== 200 ? `expected 200, got ${response.status}` : null);
  const manifest = await manifestResponse.json();
  if (manifest.name !== "ShopKhata" || manifest.display !== "standalone" || !Array.isArray(manifest.icons)) {
    throw new Error("/manifest.webmanifest: required ShopKhata install metadata is missing");
  }
  for (const icon of manifest.icons) {
    await check(icon.src, (response) => response.status !== 200 ? `expected 200, got ${response.status}` : null);
  }

  await check("/sw.js", (response) => response.status !== 200 || !/no-cache|no-store/.test(response.headers.get("cache-control") ?? "")
    ? `expected 200 and a non-stale Cache-Control policy, got ${response.status}` : null);
  const healthResponse = await check("/api/health", (response) => response.status !== 200 ? `expected 200, got ${response.status}` : null);
  const health = await healthResponse.json();
  if (health.status !== "ok" || typeof health.release !== "string") throw new Error("/api/health: invalid readiness response");
  console.log(`[smoke] release=${health.release}`);

  const protectedRoute = await check("/reports", (response) => {
    const location = response.headers.get("location") ?? "";
    return ![307, 308].includes(response.status) || !new URL(location, base).pathname.startsWith("/login")
      ? `expected an unauthenticated redirect to /login, got ${response.status}` : null;
  });
  void protectedRoute;
  console.log("[smoke] PASS read-only unauthenticated production smoke. No financial writes were made.");
} catch (error) {
  console.error(`[smoke] FAIL ${error instanceof Error ? error.message : "request failed"}`);
  process.exit(1);
}
