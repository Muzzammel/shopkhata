// ShopKhata service worker. Deliberately small and conservative:
//  - caches only build assets (/_next/static), the icons and the static,
//    data-free /offline page;
//  - never caches a page, RSC payload, Server Action, export or Supabase
//    response, so no financial data is ever served from a cache;
//  - always asks the network first, so nothing stale is shown while online.
const CACHE = "shopkhata-shell-v1";
const SHELL = "/offline";
const ICONS = ["/icon-192.png", "/icon-512.png"];

async function precache() {
  const cache = await caches.open(CACHE);
  const response = await fetch(SHELL, { cache: "no-store", credentials: "omit" });
  if (!response.ok || response.redirected) throw new Error("offline page unavailable");
  const html = await response.clone().text();
  await cache.put(SHELL, response);
  // The page's own scripts and styles, so it can start with no network.
  const assets = [...new Set(html.match(/\/_next\/static\/[^"'\\\s)<>]+/g) ?? [])];
  await Promise.all([...assets, ...ICONS].map((url) => cache.add(url).catch(() => undefined)));
}

self.addEventListener("install", (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

async function networkFirstAsset(request) {
  try {
    const response = await fetch(request);
    if (response.ok) (await caches.open(CACHE)).put(request, response.clone());
    return response;
  } catch {
    return (await caches.match(request)) ?? Response.error();
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  // Mutations and every non-GET request go straight to the network, untouched.
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/") || ICONS.includes(url.pathname)) {
    event.respondWith(networkFirstAsset(request));
    return;
  }
  // Only the workspace has an offline form. Every other page needs live server
  // data, so its navigations are left to the browser untouched.
  // ponytail: falls back only when the network request fails outright, not on
  // a slow connection. Add a timeout if "connected but dead" networks matter.
  if (request.mode === "navigate" && url.pathname === "/") {
    event.respondWith(fetch(request).catch(async () => (await caches.match(SHELL)) ?? Response.error()));
  }
});
