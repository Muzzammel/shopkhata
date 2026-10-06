import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Lightweight deployment diagnostics; deliberately makes no business-data queries. */
export function GET() {
  const release = process.env.SHOPKHATA_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "unknown";
  return NextResponse.json(
    { status: "ok", release: /^[a-zA-Z0-9._-]{1,80}$/.test(release) ? release : "unknown" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
