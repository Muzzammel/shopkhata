// Production configuration checks and response headers. Used by next.config.ts,
// so a build or start with unsafe or missing configuration stops with a clear
// message instead of producing an application that fails at the first request.

type Env = Readonly<Record<string, string | undefined>>;

function jwtRole(key: string): string | null {
  try { return JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")).role ?? null; } catch { return null; }
}

/** Returns every problem found; an empty list means the configuration is deployable. */
export function deploymentConfigProblems(env: Env, options: { production?: boolean } = {}): string[] {
  const problems: string[] = [];
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  let parsed: URL | null = null;
  try { parsed = url ? new URL(url) : null; } catch { parsed = null; }
  if (!url) problems.push("NEXT_PUBLIC_SUPABASE_URL is not set.");
  else if (!parsed) problems.push("NEXT_PUBLIC_SUPABASE_URL is not a valid URL.");
  else if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(parsed.hostname)) problems.push("NEXT_PUBLIC_SUPABASE_URL must use https.");
  else if (options.production && parsed && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) problems.push("Production cannot use a local Supabase URL.");

  if (!key) problems.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set.");
  else if (key.startsWith("sb_secret_") || jwtRole(key) === "service_role") {
    problems.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY holds a secret (service-role) key. It would be sent to every browser. Use the publishable key and rotate the secret key.");
  }

  // Anything NEXT_PUBLIC_ is compiled into the browser bundle.
  for (const name of Object.keys(env)) {
    if (name.startsWith("NEXT_PUBLIC_") && /SERVICE_ROLE|SECRET|PASSWORD|DB_URL/i.test(name)) problems.push(`${name} would expose a secret to the browser; remove the NEXT_PUBLIC_ prefix and never use it in client code.`);
  }
  return problems;
}

export function securityHeaders(env: Env, development: boolean): { key: string; value: string }[] {
  let supabase = "";
  try {
    const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL ?? "");
    supabase = ` ${url.origin} ${url.origin.replace(/^http/, "ws")}`;
  } catch { /* unset in development: the application redirects to the login page */ }
  // ponytail: no nonces. Next.js needs inline scripts and the app uses inline styles, so both keep
  // 'unsafe-inline'; scripts are still limited to this origin. Move to nonces in proxy.ts if a
  // stricter script policy is ever required (it forces every page to render dynamically).
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${supabase}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  return [
    { key: "Content-Security-Policy", value: csp },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
    // Only correct once the site is served over HTTPS on its final domain, so it is opt-in.
    ...(env.SHOPKHATA_ENABLE_HSTS === "true" ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }] : []),
  ];
}
