// Offline support.
//
// The app shell and the POI dataset are pre-cached so the map opens with no
// connection. Basemap tiles are cached opportunistically as you browse, which
// means the areas you have already looked at stay available offline — genuinely
// useful in Samoa, where mobile data outside Apia is patchy.
//
// Bump CACHE_VERSION on every deploy that changes the shell.

const CACHE_VERSION = 'apia-v9';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const TILE_CACHE = `${CACHE_VERSION}-tiles`;
const MAX_TILES = 1200;

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './data/apia.geojson',
  './data/meta.json',
  './data/curated.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll is all-or-nothing; add individually so a missing optional file
      // (no snapshot committed yet) does not abort the install.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(CACHE_VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

const isTile = (url) =>
  /\/\d+\/\d+\/\d+\.(png|jpg|webp|pbf)/.test(url.pathname) ||
  url.hostname.includes('fonts.openmaptiles.org');

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // The pmtiles archive is read with byte-range requests, and the Cache API
  // ignores the Range header on match: caching one 206 slice would serve that
  // same slice for EVERY later range and silently corrupt the vector map.
  // Range requests go straight to the network, always.
  if (req.headers.has('range') || url.pathname.endsWith('.pmtiles')) return;

  // Never cache Overpass responses - a manual refresh must always hit the network.
  if (url.pathname.includes('/api/interpreter')) return;

  if (isTile(url)) {
    event.respondWith(cacheFirstBounded(req, TILE_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
  }
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req, { ignoreSearch: false });
  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return cached || (await network) || new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function cacheFirstBounded(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    // Opaque cross-origin tile responses are still worth keeping.
    if (res && (res.ok || res.type === 'opaque')) {
      cache.put(req, res.clone());
      trim(cache);
    }
    return res;
  } catch {
    return cached || new Response('', { status: 504 });
  }
}

async function trim(cache) {
  const keys = await cache.keys();
  if (keys.length <= MAX_TILES) return;
  for (const key of keys.slice(0, keys.length - MAX_TILES)) await cache.delete(key);
}
