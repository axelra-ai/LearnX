// Bahut simple service worker — sirf app shell cache karta hai taaki
// dobara visit pe website jaldi khule. API calls (/api/...) kabhi cache
// nahi hoti, wo hamesha live network se jaati hain.
//
// "network-first" strategy: pehle live version try karta hai (naye updates
// turant milein), tabhi cache use hota hai jab internet na ho.

const CACHE_NAME = 'learnx-v2';
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
