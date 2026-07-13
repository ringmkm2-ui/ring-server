// Service Worker - キャッシュ戦略とオフライン対応
const CACHE_NAME = 'bro-chat-v1';
const urlsToCache = [
  '/',
  '/splash.html',
  '/welcome.html',
  '/auth.html',
  '/authform.html',
  '/talklist.html',
  '/admin.html',
  '/chat.html',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache).catch(err => {
        console.log('Cache addAll failed (some URLs may not exist):', err);
        return Promise.resolve();
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // APIリクエスト: ネットワーク優先
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(() => {
          // オフライン時はキャッシュから返す（キャッシュなければエラー）
          return caches.match(request);
        })
    );
    return;
  }

  // HTML/CSS/JS: キャッシュ優先、なければネットワーク
  event.respondWith(
    caches.match(request)
      .then(response => {
        if (response) return response;
        return fetch(request).then(response => {
          if (!response || response.status !== 200 || response.type !== 'basic') {
            return response;
          }
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseToCache);
          });
          return response;
        });
      })
      .catch(() => {
        return caches.match(request);
      })
  );
});
