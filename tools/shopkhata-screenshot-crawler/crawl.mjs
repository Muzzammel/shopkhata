import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.SHOPKHATA_URL ?? "http://localhost:3000";

const root = path.resolve("tools/shopkhata-screenshot-crawler");
const authFile = path.join(root, "auth", "owner.json");

const outputName =
  process.env.SHOPKHATA_SCREENSHOT_SET ?? "screenshots-desktop";

const outputDir = path.join(root, outputName);
const pagesJson = path.join(root, `${outputName}.json`);
const pagesCsv = path.join(root, `${outputName}.csv`);

const viewport = {
  width: Number(process.env.CRAWLER_WIDTH ?? 1440),
  height: Number(process.env.CRAWLER_HEIGHT ?? 1000),
};

const MAX_PAGES = Number(process.env.CRAWLER_MAX_PAGES ?? 100);

const SAFE_START_PATHS = [
  "/",
  "/admin",
  "/offline",
];

const BLOCKED_PATH_PATTERNS = [
  /\/logout/i,
  /\/signout/i,
  /\/api\//i,
];

const BLOCKED_TEXT_PATTERNS = [
  /^delete$/i,
  /^remove$/i,
  /^approve$/i,
  /^reject$/i,
  /^close day$/i,
  /^reopen/i,
  /^save/i,
  /^submit/i,
  /^record payment/i,
  /^apply credit/i,
  /^create expense/i,
  /^request correction/i,
  /^request replacement/i,
  /^deactivate/i,
  /^activate/i,
];

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl, BASE_URL);

  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().includes("token") ||
      key.toLowerCase().includes("code")
    ) {
      url.searchParams.delete(key);
    }
  }

  return url;
}

function isSameOrigin(url) {
  return url.origin === new URL(BASE_URL).origin;
}

function isBlockedUrl(url) {
  return BLOCKED_PATH_PATTERNS.some((pattern) =>
    pattern.test(url.pathname),
  );
}

function safeFilename(url, index) {
  const route =
    url.pathname === "/"
      ? "home"
      : url.pathname
          .replace(/^\/+|\/+$/g, "")
          .replace(/[^a-zA-Z0-9-_]+/g, "-")
          .replace(/-+/g, "-")
          .slice(0, 120);

  const search = url.search
    ? `-${url.search
        .replace(/^\?/, "")
        .replace(/[^a-zA-Z0-9-_]+/g, "-")
        .slice(0, 40)}`
    : "";

  return `${String(index).padStart(3, "0")}-${route || "page"}${search}.png`;
}

function csvEscape(value) {
  const text = String(value ?? "");

  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }

  return text;
}

async function collectLinks(page) {
  return page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: anchor.href,
      text: (anchor.textContent ?? "").trim(),
    })),
  );
}

async function waitForStablePage(page) {
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

  // Let hydration/layout settle.
  await page.waitForTimeout(500);
}

async function hideTransientUi(page) {
  await page.evaluate(() => {
    const selectors = [
      "[data-sonner-toaster]",
      "[role='tooltip']",
    ];

    for (const selector of selectors) {
      document.querySelectorAll(selector).forEach((node) => {
        node.style.visibility = "hidden";
      });
    }
  }).catch(() => {});
}

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
});

const context = await browser.newContext({
  storageState: authFile,
  viewport,
  colorScheme: "light",
});

const page = await context.newPage();

// Extra guard: abort mutation requests.
await page.route("**/*", async (route) => {
  const request = route.request();

  if (
    ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
  ) {
    console.warn(
      `BLOCKED ${request.method()} ${request.url()}`,
    );
    return route.abort();
  }

  return route.continue();
});

const queue = SAFE_START_PATHS.map(
  (pathname) => new URL(pathname, BASE_URL).href,
);

const queued = new Set(queue);
const visited = new Set();
const results = [];

let screenshotIndex = 1;

while (queue.length > 0 && visited.size < MAX_PAGES) {
  const nextRaw = queue.shift();
  const url = normalizeUrl(nextRaw);

  if (!isSameOrigin(url)) continue;
  if (isBlockedUrl(url)) continue;
  if (visited.has(url.href)) continue;

  visited.add(url.href);

  console.log(
    `[${visited.size}/${MAX_PAGES}] ${url.pathname}${url.search}`,
  );

  let status = "ok";
  let title = "";
  let heading = "";
  let screenshot = "";
  let error = "";

  try {
    const response = await page.goto(url.href, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    await waitForStablePage(page);

    // If session unexpectedly redirected to login, don't crawl login links.
    const currentUrl = new URL(page.url());

    if (currentUrl.pathname.includes("/login")) {
      throw new Error(`Redirected to login from ${url.pathname}`);
    }

    title = await page.title();

    heading =
      (await page
        .locator("h1")
        .first()
        .textContent()
        .catch(() => ""))?.trim() ?? "";

    await hideTransientUi(page);

    const filename = safeFilename(url, screenshotIndex++);
    const fullPath = path.join(outputDir, filename);

    await page.screenshot({
      path: fullPath,
      fullPage: true,
      animations: "disabled",
    });

    screenshot = filename;

    if (response && !response.ok()) {
      status = `http-${response.status()}`;
    }

    const links = await collectLinks(page);

    for (const link of links) {
      if (!link.href) continue;

      let candidate;

      try {
        candidate = normalizeUrl(link.href);
      } catch {
        continue;
      }

      if (!isSameOrigin(candidate)) continue;
      if (isBlockedUrl(candidate)) continue;

      const text = link.text.trim();

      if (
        BLOCKED_TEXT_PATTERNS.some((pattern) => pattern.test(text))
      ) {
        continue;
      }

      if (!visited.has(candidate.href) && !queued.has(candidate.href)) {
        queue.push(candidate.href);
        queued.add(candidate.href);
      }
    }
  } catch (caught) {
    status = "error";
    error =
      caught instanceof Error ? caught.message : String(caught);

    console.error(`  ERROR: ${error}`);
  }

  results.push({
    url: url.href,
    path: `${url.pathname}${url.search}`,
    title,
    heading,
    screenshot,
    status,
    error,
  });
}

await fs.writeFile(
  pagesJson,
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      viewport,
      pages: results,
    },
    null,
    2,
  ),
  "utf8",
);

const csv = [
  ["path", "title", "heading", "status", "screenshot", "error"]
    .map(csvEscape)
    .join(","),
  ...results.map((row) =>
    [
      row.path,
      row.title,
      row.heading,
      row.status,
      row.screenshot,
      row.error,
    ]
      .map(csvEscape)
      .join(","),
  ),
].join("\n");

await fs.writeFile(pagesCsv, csv, "utf8");

console.log("");
console.log(`Captured ${results.length} pages.`);
console.log(`Screenshots: ${outputDir}`);
console.log(`JSON:        ${pagesJson}`);
console.log(`CSV:         ${pagesCsv}`);

await browser.close();