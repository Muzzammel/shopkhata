import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Lightweight deployment diagnostics; deliberately makes no business-data queries.
 * The release is the deployment's own git commit, which Vercel sets per build, so it
 * cannot go stale. SHOPKHATA_RELEASE is only a fallback for hosts without a commit SHA.
 */
export function GET() {
  const release = process.env.VERCEL_GIT_COMMIT_SHA || process.env.SHOPKHATA_RELEASE || "unknown";
  return NextResponse.json(
    { status: "ok", release: /^[a-zA-Z0-9._-]{1,80}$/.test(release) ? release : "unknown" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
