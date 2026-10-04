import { describe, expect, it } from "vitest";

import { accountAdminError, effectiveAccess, registerAccountInput, shopAssignmentInput, updateAccountInput } from "@/lib/account-admin";
import { safeReturnPath } from "@/lib/auth/return-path";
import { deploymentConfigProblems, securityHeaders } from "@/lib/deployment-config";

const jwt = (role: string) => `x.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.y`;
const valid = { NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_abc" };

describe("deployment configuration", () => {
  it("accepts a complete configuration, including the legacy anon key and a local stack", () => {
    expect(deploymentConfigProblems(valid)).toEqual([]);
    expect(deploymentConfigProblems({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt("anon") })).toEqual([]);
    expect(deploymentConfigProblems({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55321" })).toEqual([]);
  });

  it("names every missing or malformed value", () => {
    expect(deploymentConfigProblems({})).toEqual(["NEXT_PUBLIC_SUPABASE_URL is not set.", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set."]);
    expect(deploymentConfigProblems({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "project.supabase.co" })).toEqual(["NEXT_PUBLIC_SUPABASE_URL is not a valid URL."]);
    expect(deploymentConfigProblems({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "http://project.supabase.co" })).toEqual(["NEXT_PUBLIC_SUPABASE_URL must use https."]);
  });

  it("refuses a secret key or secret-named variable that would reach the browser", () => {
    expect(deploymentConfigProblems({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: jwt("service_role") })[0]).toContain("service-role");
    expect(deploymentConfigProblems({ ...valid, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_abc" })[0]).toContain("service-role");
    expect(deploymentConfigProblems({ ...valid, NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY: "x" })[0]).toContain("NEXT_PUBLIC_SUPABASE_SERVICE_ROLE_KEY");
  });

  it("sends restrictive headers that still allow the configured Supabase project", () => {
    const headers = Object.fromEntries(securityHeaders(valid, false).map((header) => [header.key, header.value]));
    expect(headers["Content-Security-Policy"]).toContain("connect-src 'self' https://project.supabase.co wss://project.supabase.co");
    expect(headers["Content-Security-Policy"]).toContain("frame-ancestors 'none'");
    expect(headers["Content-Security-Policy"]).not.toContain("unsafe-eval");
    expect(headers).toMatchObject({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin" });
    expect(headers["Strict-Transport-Security"]).toBeUndefined();
    expect(securityHeaders({ ...valid, SHOPKHATA_ENABLE_HSTS: "true" }, false).some((header) => header.key === "Strict-Transport-Security")).toBe(true);
    expect(securityHeaders(valid, true)[0].value).toContain("'unsafe-eval'");
  });
});

describe("return path after sign-in", () => {
  const origin = "https://shop.example";

  it("keeps a path on this site, with its query and fragment", () => {
    expect(safeReturnPath("/customers?shop=1#ledger", origin)).toBe("/customers?shop=1#ledger");
    expect(safeReturnPath("/", origin)).toBe("/");
  });

  it("never returns an address that leaves the site", () => {
    for (const hostile of ["https://evil.example/x", "//evil.example/x", "/\\evil.example", "/\\/evil.example", "\\\\evil.example", "javascript:alert(1)",
      "/\tevil", "/%0d%0a".replace("%0d%0a", "\r\n"), "evil.example", "", null, undefined]) {
      expect(safeReturnPath(hostile, origin)).toBe("/");
    }
  });
});

describe("account administration input", () => {
  const id = "10000000-0000-4000-8000-000000000102";

  it("normalizes a registration and rejects anything outside the role model", () => {
    expect(registerAccountInput.parse({ email: "  New.Hire@Example.com ", display_name: " New Hire ", role: "staff" })).toEqual({ email: "new.hire@example.com", display_name: "New Hire", role: "staff" });
    expect(registerAccountInput.safeParse({ email: "not-an-email", display_name: "x", role: "staff" }).success).toBe(false);
    expect(registerAccountInput.safeParse({ email: "a@b.co", display_name: "x", role: "admin" }).success).toBe(false);
  });

  it("rejects client-supplied extras that could smuggle authority", () => {
    expect(updateAccountInput.safeParse({ user_id: id, role: "owner", is_active: true }).success).toBe(true);
    expect(updateAccountInput.safeParse({ user_id: id, role: "owner", is_active: true, actor_role: "owner" }).success).toBe(false);
    expect(updateAccountInput.safeParse({ user_id: id, role: "owner", is_active: "true" }).success).toBe(false);
    expect(shopAssignmentInput.safeParse({ user_id: id, shop_id: "not-a-uuid", assigned: true }).success).toBe(false);
  });

  it("describes effective access and maps errors to operator language", () => {
    expect(effectiveAccess({ role: "staff", isActive: false, shopNames: ["Shop 1"] })).toBe("No access (deactivated)");
    expect(effectiveAccess({ role: "owner", isActive: true, shopNames: [] })).toBe("All shops (owner)");
    expect(effectiveAccess({ role: "manager", isActive: true, shopNames: [] })).toBe("No access (no shop assigned)");
    expect(effectiveAccess({ role: "staff", isActive: true, shopNames: ["Shop 1", "Shop 2"] })).toBe("Shop 1, Shop 2");
    expect(accountAdminError("SELF_CHANGE_FORBIDDEN")).toContain("your own");
    expect(accountAdminError("anything else")).toContain("not saved");
  });
});
