import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const BASE_URL = process.env.SHOPKHATA_URL ?? "http://localhost:3000";

const EMAIL =
  process.env.SHOPKHATA_CRAWLER_EMAIL ?? "owner@shopkhata.local";

const PASSWORD =
  process.env.SHOPKHATA_CRAWLER_PASSWORD ??
  "ShopKhata-Local-Owner-E2E-Only-2026!";

const root = path.resolve("tools/shopkhata-screenshot-crawler");
const authDir = path.join(root, "auth");
const authFile = path.join(authDir, "owner.json");

await fs.mkdir(authDir, { recursive: true });

const browser = await chromium.launch({
  headless: true,
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});

const page = await context.newPage();

console.log(`Opening ${BASE_URL}/login`);

await page.goto(`${BASE_URL}/login`, {
  waitUntil: "domcontentloaded",
});

await page.getByLabel(/email/i).fill(EMAIL);
await page.getByLabel(/password/i).fill(PASSWORD);
await page.getByRole("button", { name: /sign in|log in/i }).click();

await page.waitForURL(
  (url) => !url.pathname.includes("/login"),
  { timeout: 30_000 },
);

await page.waitForLoadState("networkidle").catch(() => {});

console.log(`Authenticated at ${page.url()}`);

await context.storageState({
  path: authFile,
});

console.log(`Saved auth state to ${authFile}`);

await browser.close();