import type { NextConfig } from "next";

import { deploymentConfigProblems, securityHeaders } from "./lib/deployment-config";

const development = process.env.NODE_ENV === "development";

// `next build` and `next start` stop here when the configuration is missing or unsafe.
if (process.env.NODE_ENV === "production") {
  const problems = deploymentConfigProblems(process.env);
  if (problems.length) throw new Error(`ShopKhata configuration is not deployable:\n  - ${problems.join("\n  - ")}\nSee docs/operations/environment.md.`);
}

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/:path*",
      headers: securityHeaders(process.env, development),
    }, {
      // The service worker must never be served stale, and may only load same-origin code.
      source: "/sw.js",
      headers: [
        { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
      ],
    }];
  },
};

export default nextConfig;
