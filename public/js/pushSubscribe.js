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

  async function subscribeForPush() {
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
