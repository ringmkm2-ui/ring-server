// utils/keepAlive.js - Renderフリープランのスリープ防止
//
// Renderの無料Webサービスは「外から15分リクエストが来ない」とスリープする。
// GitHub Actionsのcron(keepalive.yml)だけだと、GitHub側の都合で実行が
// 15分以上遅れたり丸ごとスキップされることがあり、その隙にスリープしていた。
//
// 対策: サーバー自身が10分おきに自分の公開URL(/health)を叩く。
// 公開URL経由なのでRenderのプロキシを通り「外部からの通信」として数えられる。
// 起きている限り自分で起き続けるので、GitHub cronは「万一寝た時の起こし役」だけになる。
//
// RENDER_EXTERNAL_URL はRenderが自動で入れる環境変数。ローカルでは未設定なので何もしない。

const INTERVAL_MS = 10 * 60 * 1000;

function startKeepAlive() {
  const base = process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL;
  if (!base) {
    console.log('[keepAlive] RENDER_EXTERNAL_URL 未設定のため無効(ローカル実行)');
    return;
  }
  const url = base.replace(/\/+$/, '') + '/health';

  const ping = async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'ring-keepalive' } });
      if (!r.ok) console.warn(`[keepAlive] ${url} -> ${r.status}`);
    } catch (e) {
      console.warn('[keepAlive] ping失敗:', e.message);
    } finally {
      clearTimeout(t);
    }
  };

  // 起動直後は他の初期化と被らないよう少しずらす
  setTimeout(ping, 30 * 1000);
  const timer = setInterval(ping, INTERVAL_MS);
  timer.unref?.();
  console.log(`[keepAlive] ${INTERVAL_MS / 60000}分おきに ${url} をping`);
}

module.exports = { startKeepAlive };
