// AT Section Tracker — service worker for offline use.
// Caches the static app + the AT data bundle. Map tiles are NOT cached here —
// for true offline trail use the user can pan the map online to warm tile
// caches, but no proactive tile prefetching is done.

const CACHE = "at-tracker-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./at_data.json",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      // Use individual addAll-ish so a single 404 doesn't tank the install
      Promise.allSettled(ASSETS.map((url) => cache.add(url)))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Tile requests: network-only, but fall back to cache if offline.
  if (url.hostname.endsWith("tile.openstreetmap.org") || url.hostname.endsWith("tile.opentopomap.org")) {
    event.respondWith(
      fetch(req).then((resp) => {
        // Opportunistically cache successful tile responses.
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(CACHE + "-tiles").then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // App shell + data: cache-first with network fallback.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Revalidate in background
        fetch(req).then((fresh) => {
          if (fresh && fresh.ok) {
            caches.open(CACHE).then((c) => c.put(req, fresh.clone())).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }
      return fetch(req).then((resp) => {
        if (resp && resp.ok && (url.origin === self.location.origin || url.hostname.endsWith("unpkg.com"))) {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return resp;
      });
    })
  );
});
