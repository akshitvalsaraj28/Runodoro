// Runodoro Service Worker
// Strategy:
//   - App shell (index.html, icons, manifest) → Cache-first, update in background
//   - Google Fonts → Cache-first (long-lived, versioned by Google)
//   - Supabase API calls → Network-only (always fresh, no caching)
//   - Everything else → Network-first with cache fallback

const CACHE_NAME = 'runodoro-v1';
const OFFLINE_URL = '/index.html';

// Files to pre-cache on install (the app shell)
const PRECACHE_URLS = [
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  '/404.html',
];

// ── Install: pre-cache app shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(err => {
        // Don't block install if some files are missing (e.g. 404.html)
        console.warn('[SW] Pre-cache partial failure:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: routing strategy ───────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // 1. Supabase API → always network-only, never cache
  if (url.hostname.includes('supabase.co') || url.hostname.includes('resend.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. Google Fonts → cache-first (fonts are content-hashed, safe to cache forever)
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // 3. App shell (HTML, icons, manifest) → stale-while-revalidate
  //    Serve from cache instantly, fetch update in background
  if (
    PRECACHE_URLS.some(p => url.pathname === p || url.pathname.endsWith(p)) ||
    url.pathname === '/' ||
    url.pathname.endsWith('.html')
  ) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          const networkFetch = fetch(event.request).then(res => {
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          }).catch(() => cached); // offline fallback

          // Return cached immediately, update happens in background
          return cached || networkFetch;
        })
      )
    );
    return;
  }

  // 4. Everything else → network-first, cache fallback
  event.respondWith(
    fetch(event.request)
      .then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(event.request).then(cached => cached || caches.match(OFFLINE_URL))
      )
  );
});
