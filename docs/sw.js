// Кэш, чтобы приложение открывалось и без интернета
const CACHE = 'kalendar-v8';
const FILES = ['./', 'index.html', 'styles.css', 'config.js', 'tz.js', 'store.js', 'sync.js', 'events.js', 'app.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Напоминания с сервера
self.addEventListener('push', e => {
  let msg = {};
  try { msg = e.data ? e.data.json() : {}; } catch (err) { msg = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(msg.title || 'Календарь', {
    body: msg.body || '',
    tag: msg.tag,
    icon: 'icon.svg',
    badge: 'icon.svg',
    data: { url: msg.url || './' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data && e.notification.data.url || './', self.registration.scope).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if (c.url.startsWith(self.registration.scope)) return c.focus();
    return clients.openWindow(url);
  }));
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
