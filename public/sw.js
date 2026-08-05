// Service Worker - キャッシュ戦略 + 着信通知 + バックグラウンド処理
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

// インカミング通話の保持（バックグラウンド→フォアグラウンド引継ぎ用）
const pendingCalls = new Map();

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

// 通話着信通知（バックグラウンドで受け取り）
self.addEventListener('push', event => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    
    // 着信イベント
    if (data.type === 'call_incoming') {
      const { callerId, callerName, callerPic, callId } = data;
      
      // 通話データをメモリに保持
      pendingCalls.set(callId, { callerId, callerName, callerPic, timestamp: Date.now() });
      
      const title = `📞 着信: ${callerName || 'ユーザー'}`;
      const options = {
        body: 'タップして応答',
        icon: '/images/icon-192.png',
        badge: '/images/icon-96.png',
        tag: `call-${callId}`,
        requireInteraction: true, // 消えない・音声/バイブ
        actions: [
          { action: 'accept', title: '応答' },
          { action: 'decline', title: '拒否' }
        ],
        data: { callId, callerId, callerName, callerPic }
      };
      
      event.waitUntil(self.registration.showNotification(title, options));
    }
  } catch (e) {
    console.error('Push event parse error:', e);
  }
});

// 通知クリック → アプリをフォアグラウンドに
self.addEventListener('notificationclick', event => {
  event.notification.close();
  
  const { callId, callerId } = event.notification.data;
  const action = event.action;
  
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // 既にアプリが開いていたら focus
        for (let client of clientList) {
          if (client.url.includes('/admin.html') || client.url.includes('/talklist.html')) {
            client.focus();
            // フォアグラウンドに戻ったら、pendingCallを渡す
            client.postMessage({
              type: 'INCOMING_CALL_RESUMED',
              callId,
              callerId,
              action // 'accept', 'decline', or null
            });
            return;
          }
        }
        
        // アプリが開いていない → admin.htmlを開く
        return clients.openWindow(`/admin.html?callId=${callId}&callerId=${callerId}`)
          .then(client => {
            if (client) {
              client.postMessage({
                type: 'INCOMING_CALL_DIRECT',
                callId,
                callerId,
                action
              });
            }
          });
      })
  );
});

// クライアントからのメッセージ受信（キープアライブ + 通話制御）
self.addEventListener('message', event => {
  const { type, callId } = event.data;
  
  if (type === 'CALL_ENDED') {
    // 通話終了時、pendingCallsから削除
    pendingCalls.delete(callId);
  }
  
  if (type === 'KEEPALIVE') {
    // 定期的なキープアライブシグナル（WebSocket リトライ用）
    // Service Workerをアクティブに保つ（デバイス制限下でも通話受信を継続）
    event.ports[0].postMessage({ ack: true });
  }
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
