// public/js/ratchetClient.js
// ページから E2ERatchet(ratchet.js)を使うための薄い層。
// 読むのはいつでもできる。送る側で使うか(プリキーを公開するか)は、サーバーの設定(/api/ratchet/config)で決まる。
(function () {
  if (window.bcE5) return;
  const uid = () => window.myUserId || localStorage.getItem('ring_userId') || '';
  let client = null, clientFor = '', cfg = null, cfgAt = 0, prekeyAt = 0;

  function identity() {
    const k = JSON.parse(localStorage.getItem('e2e_keypair_' + uid()) || 'null');
    if (!k || !k.publicKey || !k.secretKey) throw new Error('no device key');
    return { pub: Uint8Array.from(k.publicKey), sec: Uint8Array.from(k.secretKey) };
  }
  function get() {
    if (!window.E2ERatchet || !uid()) return null;
    if (client && clientFor === uid()) return client;
    clientFor = uid();
    client = E2ERatchet.makeClient({
      uid: clientFor,
      identity,
      http: async (method, path, body) => {
        const r = await fetch(path, {
          method,
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('ring_token') },
          body: body ? JSON.stringify(body) : undefined,
        });
        if (r.status === 404) return null;
        if (!r.ok) { const e = new Error('ratchet http ' + r.status); e.status = r.status; throw e; }
        return r.json();
      },
    });
    return client;
  }
  async function enabled() {
    if (cfg && Date.now() - cfgAt < 10 * 60 * 1000) return cfg.enabled;
    try {
      const r = await fetch('/api/ratchet/config', { headers: { Authorization: 'Bearer ' + localStorage.getItem('ring_token') } });
      if (r.ok) { cfg = await r.json(); cfgAt = Date.now(); return !!cfg.enabled; }
    } catch (e) {}
    return cfg ? !!cfg.enabled : false;
  }
  // 起動のたびにDBを起こさないよう、確かめるのは半日に1回まで
  async function ensure() {
    if (Date.now() - prekeyAt < 60000) return;
    prekeyAt = Date.now();
    const lsk = 'e5_prekey_at_' + uid();
    try { if (Date.now() - Number(localStorage.getItem(lsk) || 0) < 12 * 60 * 60 * 1000) return; } catch (e) {}
    if (!(await enabled())) return;
    const c = get();
    if (!c) return;
    try {
      await c.ensurePrekeys();
      try { localStorage.setItem(lsk, String(Date.now())); } catch (e) {}
    } catch (e) { console.warn('[e5] prekeys', e && e.message); }
  }
  window.bcE5 = { get, enabled, ensure, isRatchet: s => !!(window.E2ERatchet && E2ERatchet.isRatchet(s)) };
  // 端末の鍵の登録が終わった後で
  setTimeout(ensure, 5000);
})();
