// Bahut simple service worker — sirf app shell cache karta hai taaki
// dobara visit pe website jaldi khule. API calls (/api/...) kabhi cache
// nahi hoti, wo hamesha live network se jaati hain.
//
// "network-first" strategy: pehle live version try karta hai (naye updates
// turant milein), tabhi cache use hota hai jab internet na ho.

const CACHE_NAME = 'learnx-v4';
const SHELL_FILES = ['/'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // API requests kabhi cache se serve mat karo
  if (url.pathname.startsWith('/api/')) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ===== Push notifications (chat) =====
// Server "conversation-activity" ke baad push bhejta hai: title = kisne message kiya, body = message.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = { title: 'LearnX', body: event.data && event.data.text() }; }
  const title = data.title || 'LearnX';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find((w) => w.visibilityState === 'visible');
    if (visible) {
      // App khuli hai: system notification ki jagah app ke andar toast/refresh karwao.
      wins.forEach((w) => w.postMessage({ type: 'chat-push', data }));
      return;
    }
    await self.registration.showNotification(title, {
      body: data.body || 'Naya message aaya hai',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.senderId ? 'chat-' + data.senderId : 'chat',
      renotify: true,
      data: { url: data.url || '/', senderId: data.senderId, senderName: data.senderName },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const target = d.url || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (wins.length) {
      const w = wins[0];
      try { await w.focus(); } catch (e) {}
      w.postMessage({ type: 'open-chat', senderId: d.senderId, senderName: d.senderName });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
