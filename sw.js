/**
 * Service worker for the PMT Calendar.
 *
 * Everything is scoped relatively, so the same file works whether the site is
 * served from a domain root or from a GitHub Pages project subpath.
 *
 * Strategies:
 *   navigation      network first, cached shell as the fallback — an update
 *                   lands as soon as the device is online again
 *   data/events.json  network first, cached copy as the fallback, so an
 *                   installed app still opens the last known schedule offline
 *   static assets   stale-while-revalidate — instant, then quietly refreshed
 */

const VERSION = "pmt-calendar-v2";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/css/styles.css",
  "./assets/js/main.js",
  "./assets/js/store.js",
  "./assets/js/dates.js",
  "./assets/js/detail.js",
  "./assets/js/pwa.js",
  "./assets/js/views/month.js",
  "./assets/js/views/gantt.js",
  "./assets/js/views/list.js",
  "./assets/img/bwd-logo.png",
  "./assets/img/bwd-logo-32.png",
  "./assets/img/favicon.ico",
  "./assets/img/apple-touch-icon.png",
  "./assets/img/icon-192.png",
  "./assets/img/icon-512.png",
  "./data/events.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      // addAll is all-or-nothing; one 404 would abandon the whole install, so
      // each file is added on its own and a miss is simply skipped.
      Promise.all(
        SHELL.map((path) =>
          cache.add(new Request(path, { cache: "reload" })).catch(() => undefined),
        ),
      ),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

/** The page asks for this when the viewer accepts an update. */
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, SHELL_CACHE, "./index.html"));
    return;
  }

  if (url.pathname.endsWith("/data/events.json")) {
    // The manual refresh appends a cache-busting query; key the cache on the
    // bare path so one stored copy serves every variant.
    event.respondWith(networkFirst(request, DATA_CACHE, url.pathname));
    return;
  }

  event.respondWith(staleWhileRevalidate(request, SHELL_CACHE));
});

async function networkFirst(request, cacheName, cacheKey) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(cacheKey ?? request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(cacheKey ?? request);
    if (!cached) throw error;
    // Flag the fallback, so the manual refresh can say "this is the saved
    // copy" instead of reporting a cached answer as an up-to-date one.
    const headers = new Headers(cached.headers);
    headers.set("X-From-Cache", "1");
    return new Response(await cached.blob(), {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => cached);
  return cached ?? network;
}
