import { afterEach, describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

const originalRelease = process.env.SHOPKHATA_RELEASE;
const originalVercelSha = process.env.VERCEL_GIT_COMMIT_SHA;

afterEach(() => {
  if (originalRelease === undefined) delete process.env.SHOPKHATA_RELEASE;
  else process.env.SHOPKHATA_RELEASE = originalRelease;
  if (originalVercelSha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
  else process.env.VERCEL_GIT_COMMIT_SHA = originalVercelSha;
});

describe("health route", () => {
  it("returns a minimal no-store response with release metadata", async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    process.env.SHOPKHATA_RELEASE = "shopkhata-v1-rc4";
    const response = GET();

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", release: "shopkhata-v1-rc4" });
  });

  it("reports the deployment commit even when a stale SHOPKHATA_RELEASE is configured", async () => {
    process.env.SHOPKHATA_RELEASE = "shopkhata-v1-rc5-f6a13cb";
    process.env.VERCEL_GIT_COMMIT_SHA = "593c2b3a47294014f3742424bbdf492e39359ab5";

    expect(await GET().json()).toEqual({ status: "ok", release: "593c2b3a47294014f3742424bbdf492e39359ab5" });
  });

  it("falls back to unknown when no release source is set", async () => {
    delete process.env.SHOPKHATA_RELEASE;
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    expect(await GET().json()).toEqual({ status: "ok", release: "unknown" });
  });

  it("omits malformed release metadata and reveals no environment details", async () => {
    process.env.SHOPKHATA_RELEASE = "token=should-not-appear";
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    const payload = await GET().json();
    expect(payload).toEqual({ status: "ok", release: "unknown" });
    expect(JSON.stringify(payload)).not.toContain("should-not-appear");
  });
});
