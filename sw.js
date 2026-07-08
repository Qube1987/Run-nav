/* Service worker Run-Nav — mode hors-ligne.
   - App shell (HTML/CSS/JS/Leaflet/icônes) : pré-caché, servi cache-first.
   - Tuiles de carte : cache runtime plafonné (les zones déjà vues restent dispo).
   - Supabase & autres POST : réseau uniquement (jamais mis en cache). */

const VERSION = 'v59';
const SHELL_CACHE = `runnav-shell-${VERSION}`;
const TILE_CACHE = `runnav-tiles-${VERSION}`;
const TILE_MAX = 800;

const SHELL = [
  './', './index.html', './styles.css', './manifest.webmanifest',
  './js/app.js', './js/geo.js', './js/gpx.js', './js/climbs.js',
  './js/pacing.js', './js/profile.js', './js/map.js', './js/demo.js', './js/storage.js',
  './js/auth.js', './js/live.js',
  './vendor/leaflet/leaflet.js', './vendor/leaflet/leaflet.css',
  './vendor/leaflet/images/marker-icon.png', './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './vendor/leaflet/images/layers.png', './vendor/leaflet/images/layers-2x.png',
  './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

function isTile(url) {
  return url.hostname.includes('tile') || url.hostname.includes('cyclosm');
}

async function trimCache(name, max) {
  const cache = await caches.open(name);
  const keys = await cache.keys();
  if (keys.length <= max) return;
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // POST/PATCH (Supabase) → réseau natif

  const url = new URL(req.url);

  // Supabase : toujours réseau (données à jour, jamais en cache)
  if (url.hostname.includes('supabase.co')) return;

  // Tuiles de carte : cache-first plafonné
  if (isTile(url)) {
    e.respondWith((async () => {
      const cache = await caches.open(TILE_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) { cache.put(req, res.clone()); trimCache(TILE_CACHE, TILE_MAX); }
        return res;
      } catch (_) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // App shell (même origine) : RÉSEAU D'ABORD quand en ligne (toujours la dernière
  // version), repli sur le cache hors-ligne. Évite de rester bloqué sur une
  // version périmée tout en gardant l'app utilisable sans réseau.
  if (url.origin === self.location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(SHELL_CACHE);
          cache.put(req, res.clone());
        }
        return res;
      } catch (_) {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === 'navigate') return caches.match('./index.html');
        return Response.error();
      }
    })());
  }
});
