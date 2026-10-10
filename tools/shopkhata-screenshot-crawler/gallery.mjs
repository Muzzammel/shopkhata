import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve("tools/shopkhata-screenshot-crawler");

const outputName =
  process.env.SHOPKHATA_SCREENSHOT_SET ?? "screenshots-desktop";

const pagesJson = path.join(root, `${outputName}.json`);
const galleryFile = path.join(root, `${outputName}-gallery.html`);

const data = JSON.parse(await fs.readFile(pagesJson, "utf8"));

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const cards = data.pages
  .filter((page) => page.screenshot)
  .map(
    (page) => `
      <article class="card">
        <a
          class="image-link"
          href="./${escapeHtml(outputName)}/${escapeHtml(page.screenshot)}"
          target="_blank"
          rel="noreferrer"
        >
          <img
            src="./${escapeHtml(outputName)}/${escapeHtml(page.screenshot)}"
            alt="${escapeHtml(page.path)}"
            loading="lazy"
          />
        </a>

        <div class="meta">
          <div class="route">${escapeHtml(page.path)}</div>
          ${
            page.heading
              ? `<div class="heading">${escapeHtml(page.heading)}</div>`
              : ""
          }
          <div class="status ${escapeHtml(page.status)}">
            ${escapeHtml(page.status)}
          </div>
        </div>
      </article>
    `,
  )
  .join("\n");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  />
  <title>ShopKhata UI Screenshot Gallery</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: #f4f6f8;
      color: #111827;
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
    }

    header {
      position: sticky;
      top: 0;
      z-index: 10;
      padding: 18px 24px;
      background: rgba(255, 255, 255, 0.94);
      border-bottom: 1px solid #e5e7eb;
      backdrop-filter: blur(14px);
    }

    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.25;
    }

    .summary {
      margin-top: 4px;
      color: #6b7280;
      font-size: 13px;
    }

    main {
      display: grid;
      grid-template-columns: repeat(
        auto-fill,
        minmax(360px, 1fr)
      );
      gap: 20px;
      padding: 24px;
    }

    .card {
      overflow: hidden;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 14px;
      box-shadow:
        0 1px 2px rgba(0, 0, 0, 0.04),
        0 4px 14px rgba(0, 0, 0, 0.04);
    }

    .image-link {
      display: block;
      max-height: 520px;
      overflow: hidden;
      background: #e5e7eb;
      border-bottom: 1px solid #e5e7eb;
    }

    img {
      display: block;
      width: 100%;
      height: auto;
    }

    .meta {
      padding: 14px 16px 16px;
    }

    .route {
      font-family:
        ui-monospace,
        SFMono-Regular,
        Menlo,
        Consolas,
        monospace;
      font-size: 12px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }

    .heading {
      margin-top: 7px;
      color: #4b5563;
      font-size: 14px;
    }

    .status {
      display: inline-flex;
      margin-top: 10px;
      padding: 3px 8px;
      border-radius: 999px;
      background: #ecfdf5;
      color: #047857;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
    }

    .status.error {
      background: #fef2f2;
      color: #b91c1c;
    }

    @media (max-width: 600px) {
      main {
        grid-template-columns: 1fr;
        padding: 12px;
      }

      header {
        padding: 14px 16px;
      }
    }
  </style>
</head>

<body>
  <header>
    <h1>ShopKhata UI Screenshot Gallery</h1>
    <div class="summary">
      ${data.pages.length} discovered pages ·
      ${escapeHtml(`${data.viewport.width}×${data.viewport.height}`)} ·
      ${escapeHtml(data.createdAt)}
    </div>
  </header>

  <main>
    ${cards}
  </main>
</body>
</html>`;

await fs.writeFile(galleryFile, html, "utf8");

console.log(`Gallery created: ${galleryFile}`);