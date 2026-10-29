// Кэш, чтобы приложение открывалось и без интернета
const CACHE = 'kalendar-v2';
const FILES = ['./', 'index.html', 'styles.css', 'config.js', 'tz.js', 'store.js', 'sync.js', 'events.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Сначала сеть, при ошибке кэш: так обновления видны сразу
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // Запросы к облаку не кэшируем
  if (new URL(e.request.url).hostname.endsWith('supabase.co')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});
