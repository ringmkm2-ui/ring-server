// Service Worker - キャッシュ戦略 + 着信通知 + バックグラウンド処理
//
// キャッシュ更新方針:
// このファイル(sw.js)自体が変わるたびにCACHE_NAMEも変える必要がある。
// でなければブラウザは「sw.jsのバイト列が同じ」と判定してactivateが走らず、
// 新しいコードをデプロイしても誰にも届かない(いわゆる「アプリを開いても
// 更新されない」問題の典型的な原因)。
// CACHE_VERSIONはbump-version.js実行時に自動で書き換えられる。
const CACHE_VERSION = 'v1.28.127';
const CACHE_NAME = `bro-chat-${CACHE_VERSION}`;

// 通知の本文をこの端末の中でだけ復号するため(サーバーは本文を読めないまま)
try { importScripts('/js/nacl.min.js', '/js/nacl-util.min.js'); } catch (e) {}
function idbGetKeyring() {
  return new Promise(resolve => {
    try {
      const req = indexedDB.open('brochat-e2e', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readonly');
        const g = tx.objectStore('kv').get('keyring');
        g.onsuccess = () => resolve(g.result || null);
        g.onerror = () => resolve(null);
      };
      req.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
async function swDecrypt(cipher, senderPubB64) {
  try {
    if (!cipher || !self.nacl || !nacl.util) return null;
    const ring = await idbGetKeyring();
    if (!Array.isArray(ring) || !ring.length) return null;
    let body = cipher, embS = null, embR = null;
    if (cipher.startsWith('e2:')) { const p = cipher.slice(3).split(':'); if (p.length !== 3) return null; [embS, embR, body] = p; }
    const full = nacl.util.decodeBase64(body);
    const nonce = full.slice(0, 24), box = full.slice(24);
    const peers = [embS, senderPubB64].filter((v, i, a) => v && a.indexOf(v) === i);
    for (const pb of peers) {
      const peer = nacl.util.decodeBase64(pb);
      if (peer.length !== 32) continue;
      for (const k of ring) {
        const out = nacl.box.open(box, nonce, peer, new Uint8Array(k.secretKey));
        if (out) {
          let t = nacl.util.encodeUTF8(out);
          if (t.trim().startsWith('{')) { try { const o = JSON.parse(t); if (o && typeof o.text === 'string') t = o.text; } catch (e) {} }
          return t.length > 200 ? t.slice(0, 200) + '…' : t;
        }
      }
    }
  } catch (e) {}
  return null;
}
const urlsToCache = [
  '/',
  '/splash.html',
  '/welcome.html',
  '/auth.html',
  '/talklist.html',
  '/admin.html',
  '/groupchat.html',
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
  // 新しいService Workerを即座に有効化する。ユーザーがタブを閉じるまで
  // 待たず、次にアプリを開いた瞬間から新バージョンが使われるようにするため。
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      // CACHE_NAMEと一致しない(=古いバージョンの)キャッシュを全て削除
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      // 既に開いている全タブを新しいService Workerの制御下に置く
      return self.clients.claim();
    }).then(() => {
      // 開いている全タブに「更新されたのでリロードしてほしい」と通知する。
      // これにより「アプリを開くだけで自動的に最新版に切り替わる」を実現する
      // (何もしなくても、次にフォアグラウンドに戻った瞬間に反映される)。
      return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
        clientList.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION }));
      });
    })
  );
});

// 通話着信通知（バックグラウンドで受け取り）
self.addEventListener('push', event => {
  if (!event.data) return;

  try {
    const data = event.data.json();
    
    // 着信イベント（音声・ビデオ共通）
    if (data.type === 'call_incoming') {
      const { callerId, callerName, callerPic, callId, isVideo } = data;
      
      // 通話データをメモリに保持
      pendingCalls.set(callId, { callerId, callerName, callerPic, isVideo, timestamp: Date.now() });
      
      const title = `${isVideo ? 'ビデオ通話' : '音声通話'}着信: ${callerName || 'ユーザー'}`;
      const options = {
        body: 'タップして応答',
        icon: '/images/icons/icon-192.png',
        badge: '/images/icons/icon-192.png',
        tag: `call-${callId}`,
        renotify: true, // 同じtagでも再通知（バイブ/音を再度鳴らす）
        requireInteraction: true, // ユーザー操作まで消えない
        vibrate: [500, 200, 500, 200, 500, 200, 500], // 電話の着信バイブパターン
        actions: [
          { action: 'accept', title: isVideo ? 'ビデオで応答' : '応答' },
          { action: 'decline', title: '拒否' }
        ],
        data: { callId, callerId, callerName, callerPic, isVideo }
      };
      
      event.waitUntil(self.registration.showNotification(title, options));
    }
    
    // 相手が通話を切った/拒否した場合 → バックグラウンドで出していた着信通知を消す
    if (data.type === 'call_cancelled') {
      const { callId } = data;
      pendingCalls.delete(callId);
      event.waitUntil(
        self.registration.getNotifications({ tag: `call-${callId}` })
          .then(notifications => notifications.forEach(n => n.close()))
      );
    }

    // 応答されないまま切れた/時間切れ → 着信通知を「不在着信」に差し替える(同じtagで置き換わる)
    // タップすると発信者とのトークが開く
    if (data.type === 'call_missed') {
      const { callId, callerId, callerName } = data;
      pendingCalls.delete(callId);
      event.waitUntil(self.registration.showNotification('不在着信', {
        body: callerName || 'ユーザー',
        icon: '/images/icons/icon-192.png',
        badge: '/images/icons/icon-192.png',
        tag: `call-${callId}`,
        data: { type: 'dm', senderId: callerId },
      }));
    }

    // 1対1チャットの新着メッセージ
    if (data.type === 'new_message') {
      const { senderId, senderName, preview, cipher, senderPub } = data;
      const title = senderName || 'メッセージ';
      event.waitUntil((async () => {
      const text = (await swDecrypt(cipher, senderPub)) || preview || 'メッセージ';
      const options = {
        body: text,
        icon: '/images/icons/icon-192.png',
        badge: '/images/icons/icon-192.png',
        tag: `dm-${senderId}`, // 同じ相手からの連続通知はまとめる(通知欄が埋まらないように)
        renotify: true,
        data: { type: 'dm', senderId },
      };
      await self.registration.showNotification(title, options);
      })());
    }

    // グループチャットの新着メッセージ
    if (data.type === 'new_group_message') {
      const { groupId, groupName, senderName, preview } = data;
      const title = groupName || 'グループ';
      const options = {
        body: `${senderName || 'ユーザー'}: ${preview || 'メッセージ'}`,
        icon: '/images/icons/icon-192.png',
        badge: '/images/icons/icon-192.png',
        tag: `group-${groupId}`,
        renotify: true,
        data: { type: 'group', groupId },
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

  const notifData = event.notification.data || {};
  const action = event.action;

  // DM/グループの新着メッセージ通知 → 該当のトーク画面を開く/フォーカスする
  if (notifData.type === 'dm' || notifData.type === 'group') {
    const targetUrl = notifData.type === 'dm'
      ? `/admin.html?userId=${encodeURIComponent(notifData.senderId)}`
      : `/groupchat.html?groupId=${encodeURIComponent(notifData.groupId)}`;

    event.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true })
        .then(clientList => {
          for (let client of clientList) {
            // 既に同じトークを開いていればフォーカスするだけ
            if (client.url.includes(targetUrl.split('?')[0]) && client.url.includes(
              notifData.type === 'dm' ? notifData.senderId : notifData.groupId
            )) {
              return client.focus();
            }
          }
          return clients.openWindow(targetUrl);
        })
    );
    return;
  }

  // 以下は通話系(call_incoming)の既存ロジック
  const { callId, callerId, isVideo } = notifData;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // 既にアプリが開いていたら focus
        const callUrl = `/admin.html?callId=${callId}&callerId=${callerId}&isVideo=${isVideo ? '1' : '0'}${action === 'accept' ? '&action=accept' : action === 'decline' ? '&action=decline' : ''}`;
        // 開いている画面があれば、その画面をそのまま着信画面へ移す(iPhoneのホーム画面アプリでも確実に)
        for (let client of clientList) {
          if ('navigate' in client && !client.url.includes('callId=' + callId)) {
            return client.focus().then(c => (c || client).navigate(callUrl)).catch(() => clients.openWindow(callUrl));
          }
        }
        for (let client of clientList) {
          if (client.url.includes('/admin.html') || client.url.includes('/talklist.html')) {
            client.focus();
            // フォアグラウンドに戻ったら、pendingCallを渡す
            client.postMessage({
              type: 'INCOMING_CALL_RESUMED',
              callId,
              callerId,
              isVideo,
              action // 'accept', 'decline', or null
            });
            return;
          }
        }
        
        // アプリが開いていない → admin.htmlを開く
        return clients.openWindow(`/admin.html?callId=${callId}&callerId=${callerId}&isVideo=${isVideo ? '1' : '0'}`)
          .then(client => {
            if (client) {
              client.postMessage({
                type: 'INCOMING_CALL_DIRECT',
                callId,
                callerId,
                isVideo,
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

  // GET以外(POST/PUT/DELETE等)はキャッシュ対象外、素通しする
  if (request.method !== 'GET') return;

  // APIリクエストは常にネットワーク優先、オフライン時のみキャッシュにフォールバック
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => response)
        .catch(() => caches.match(request))
    );
    return;
  }

  // HTML/CSS/JS等: ネットワーク優先(Network First)。
  // 「アプリを開くだけで自動的に最新版になってほしい」という要件のため、
  // オンラインである限り常に最新のファイルを取得しキャッシュを更新する。
  // オフライン時のみ、最後に取得できたキャッシュ版にフォールバックする。
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.status === 200 && response.type === 'basic') {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // オフライン、またはネットワークエラー時のみキャッシュから返す
        return caches.match(request).then(cached => {
          if (cached) return cached;
          // ナビゲーション(ページ遷移)でキャッシュも無い場合はsplash.htmlにフォールバック
          if (request.mode === 'navigate') {
            return caches.match('/splash.html');
          }
          return Response.error();
        });
      })
  );
});
