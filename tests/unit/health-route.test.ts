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
    process.env.SHOPKHATA_RELEASE = "shopkhata-v1-rc4";
    const response = GET();

    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", release: "shopkhata-v1-rc4" });
  });

  it("omits malformed release metadata and reveals no environment details", async () => {
    process.env.SHOPKHATA_RELEASE = "token=should-not-appear";
    delete process.env.VERCEL_GIT_COMMIT_SHA;

    const payload = await GET().json();
    expect(payload).toEqual({ status: "ok", release: "unknown" });
    expect(JSON.stringify(payload)).not.toContain("should-not-appear");
  });
});
