// 全ページ共通: Service Worker登録 + Web Push (VAPID) 購読登録。
// ログイン済みページ(talklist/admin/groupchat等)で <script defer src="/js/pushSubscribe.js"> として読み込むこと。
// splash.html側のSW登録と重複しても navigator.serviceWorker.register は冪等なので問題ない。
(function () {
  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (isIOS && isStandalone) document.documentElement.classList.add('ios-standalone');

  // 通知の本文をService Workerの中で復号できるよう、自分の鍵をIndexedDBにも写しておく(この端末の中だけ)
  function copyKeyringForSW() {
    try {
      const uid = localStorage.getItem('ring_userId') || '';
      const raw = localStorage.getItem('e2e_keyring_' + uid) || localStorage.getItem('e2e_keypair_' + uid);
      if (!raw) return;
      let ring = JSON.parse(raw);
      if (!Array.isArray(ring)) ring = [ring];
      const req = indexedDB.open('brochat-e2e', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('kv');
      req.onsuccess = () => { try { req.result.transaction('kv', 'readwrite').objectStore('kv').put(ring, 'keyring'); } catch (e) {} };
    } catch (e) {}
  }
  setTimeout(copyKeyringForSW, 1500);
  document.addEventListener('visibilitychange', () => { if (document.hidden) copyKeyringForSW(); });

  async function subscribeForPush(fromUserGesture) {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      console.log('[push] このブラウザはPush通知に対応していません');
      return;
    }

    const token = localStorage.getItem('ring_token');
    if (!token) return; // 未ログイン時は何もしない

    try {
      const reg = await navigator.serviceWorker.ready;

      // 通知許可をリクエスト（未確認の場合のみ）
      if (Notification.permission === 'default') {
        // iPhoneはボタンを押した時にしか許可を聞けない(勝手に聞くと無視される)
        if (isIOS && !fromUserGesture) { showIosNotifPrompt(); return; }
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          console.log('[push] 通知許可が得られませんでした');
          return;
        }
      }
      if (Notification.permission !== 'granted') return;

      // 既存の購読があればそれを使う。なければ新規作成。
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        const res = await fetch('/api/push/vapid-public-key');
        const { publicKey } = await res.json();
        subscription = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
      }

      // サーバーに購読情報を登録（毎回送っても冪等: endpointでUPSERT）
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
        },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });

      console.log('[push] Push購読登録完了');
    } catch (err) {
      console.error('[push] 購読処理エラー:', err);
    }
  }

  window.enablePush = () => subscribeForPush(true);

  // iPhone(ホーム画面アプリ)用: 通知をオンにするボタン
  function showIosNotifPrompt() {
    if (!isStandalone || document.getElementById('iosNotifPrompt')) return;
    if (sessionStorage.getItem('iosNotifDismissed')) return;
    const bar = document.createElement('div');
    bar.id = 'iosNotifPrompt';
    bar.className = 'ios-pwa-banner';
    bar.innerHTML = '<div class="ipb-text"><b>通知をオンにする</b><span>メッセージと着信を受け取れます</span></div>'
      + '<button type="button" class="ipb-on">オン</button><button type="button" class="ipb-x" aria-label="閉じる">'
      + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    document.body.appendChild(bar);
    bar.querySelector('.ipb-on').onclick = async () => { bar.remove(); await subscribeForPush(true); };
    bar.querySelector('.ipb-x').onclick = () => { bar.remove(); sessionStorage.setItem('iosNotifDismissed', '1'); };
  }

  // iPhoneのSafariで開いている時は「ホーム画面に追加」を案内(追加しないと通知が届かない)
  function showIosInstallGuide() {
    if (!isIOS || isStandalone || !localStorage.getItem('ring_token')) return;
    if (localStorage.getItem('iosInstallDismissed')) return;
    const bar = document.createElement('div');
    bar.className = 'ios-pwa-banner ios-install';
    bar.innerHTML = '<div class="ipb-text"><b>ホーム画面に追加してね</b><span>下の <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 3v12"/><path d="M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg> 共有 →「ホーム画面に追加」。アプリとして開くと通知と着信が届きます</span></div>'
      + '<button type="button" class="ipb-x" aria-label="閉じる"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg></button>';
    document.body.appendChild(bar);
    bar.querySelector('.ipb-x').onclick = () => { bar.remove(); localStorage.setItem('iosInstallDismissed', '1'); };
  }
  if (location.pathname.endsWith('/talklist.html')) setTimeout(showIosInstallGuide, 1200);

  // ページロード後、少し待ってから実行（SW登録完了を待つ・体感速度優先）
  if (document.readyState === 'complete') {
    subscribeForPush();
  } else {
    window.addEventListener('load', subscribeForPush);
  }

  // アプリを開くたびに明示的にService Worker更新チェックを行う。
  // splash.html経由でなく直接admin.html等を開いた場合(通知タップ等)にも、
  // 「開くだけで最新版になる」を確実にするため。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistration().then(reg => {
      if (reg) reg.update().catch(() => {});
    });
  }

  // 自動アップデート: 新しいService Workerがactivateされたら、
  // ユーザーが何もしなくても最新版に切り替わるよう自動でリロードする。
  // ただし通話中に急にリロードすると通話が切れてしまうため、
  // 通話オーバーレイが表示されている間はリロードを保留し、
  // 通話が終わったタイミングで改めて実行する。
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', event => {
      if (event.data && event.data.type === 'SW_UPDATED') {
        const callOv = document.getElementById('callOv');
        const inCall = callOv && callOv.classList.contains('show');
        if (inCall) {
          window.__pendingSwReload = true;
        } else {
          location.reload();
        }
      }
    });

    // 裏に回していたアプリを開き直した時(タブ/アプリが生きたまま戻る場合)は、ページの
    // 読み込み自体が走らないので、上の更新チェックが効かず古いまま使い続けてしまう。
    // 復帰した時と、表示中の一定間隔で、サーバーの版と自分の版を比べて違えば更新する。
    const badge = document.querySelector('.version-badge');
    const m = badge && /v(\d+\.\d+\.\d+)/.exec(badge.textContent || '');
    const myVersion = m ? m[1] : null;
    let lastCheck = 0;
    async function checkVersion() {
      if (!myVersion || document.hidden) return;
      const now = Date.now();
      if (now - lastCheck < 20000) return;
      lastCheck = now;
      try {
        const r = await fetch('/api/version', { cache: 'no-store' });
        const j = await r.json();
        if (!j || !j.version || j.version === myVersion) return;
        // リロードが繰り返されないよう、同じ版への更新は1分に1回まで
        const key = 'sw_reload_' + j.version;
        const prev = Number(sessionStorage.getItem(key) || 0);
        if (now - prev < 60000) return;
        sessionStorage.setItem(key, String(now));
        navigator.serviceWorker.getRegistration().then(reg => reg && reg.update().catch(() => {}));
        const callOv = document.getElementById('callOv');
        if (callOv && callOv.classList.contains('show')) { window.__pendingSwReload = true; return; }
        location.reload();
      } catch (e) {}
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
    window.addEventListener('focus', checkVersion);
    window.addEventListener('pageshow', checkVersion);
    setInterval(checkVersion, 5 * 60 * 1000);

    // 通話終了時など、保留していた自動更新を反映したいタイミングで
    // 他のスクリプトから呼び出せるようグローバルに公開しておく
    window.__applyPendingSwReloadIfAny = function () {
      if (window.__pendingSwReload) {
        window.__pendingSwReload = false;
        location.reload();
      }
    };
  }
})();
