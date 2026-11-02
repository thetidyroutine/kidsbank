// Caches only the app files so it opens quickly. Account data is never stored here.
const CACHE = 'kidsbank-v2';
const FILES = ['./', 'index.html', 'styles.css', 'app.js', 'charts.js', 'config.js', 'vendor/supabase.js', 'fonts/inter.woff2', 'icons/icon-192.png', 'img/login-bg.webp'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
      return res;
    })
    .catch(() => caches.match(e.request)));
});
