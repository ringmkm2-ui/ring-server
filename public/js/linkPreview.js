// linkPreview.js
// メッセージ内の最初の http(s) リンクに、タイトル・説明・画像の小さなカードを付ける。
//
// プライバシー: リンク先の取得はサーバーが代わりに行う(GET /api/link-preview?url=...)ので、プレビューを出すとそのURLがサーバーに伝わる。
//   E2E暗号化のトークでは重要なので、設定 linkPreview が true の人だけ動く(未設定=オフ。オフの時はネットワークに何も出さない)。
// 安全: サーバーから返った文字列は全部 textContent で入れる(HTMLとして解釈しない)。画像は https のものだけ。
//   カード全体が <a rel="noopener noreferrer" target="_blank"> で、リンク先はメッセージ本文のURL(サーバーが返したURLではない)。
//   エラー・403(サーバー側で無効)・タイムアウトは全部「プレビューなし」として黙って無視する。
//
// 使い方(復号済みの平文を渡す):
//   BroLinkPreview.attach(bubbleEl, plainText, {
//     offlineDraft: m.pending,        // 自分の未送信/送信待ちの仮メッセージは取得しない
//     encryptedFailed: m.decryptFailed, // 復号失敗のメッセージも取得しない
//     onAdd: () => keepBottom(),      // カードが付いて高さが変わった時に呼ばれる(最下部固定のページ用)
//     api: (url) => Promise<{...}>    // 省略可。差し替えたい時だけ(既定は fetch + ring_token)
//   });
// 同じ吹き出しに2回呼んでも1枚だけ。結果は メモリ + sessionStorage に覚える(失敗も覚えて再取得しない)。同時取得は最大4件。
(function () {
  if (window.BroLinkPreview) return;

  const SS_KEY = 'bro_lp_cache_v1';
  const MAX_CONC = 4, TIMEOUT = 8000, MAX_CACHE = 80;
  const mem = new Map();         // url -> {d: obj|null, ts}
  const pend = new Map();        // url -> Promise
  let active = 0, serverOff = false;
  const queue = [];

  const tr = (k, fb) => { try { return (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } };

  function enabled() {
    try {
      const s = window.BroSettings || window.bcSettings;
      return !!(s && s.get && s.get('linkPreview') === true);
    } catch (e) { return false; }
  }

  function loadSS() {
    try {
      const o = JSON.parse(sessionStorage.getItem(SS_KEY) || '{}');
      for (const u in o) if (!mem.has(u) && o[u] && 'd' in o[u]) mem.set(u, o[u]);
    } catch (e) {}
  }
  function saveSS() {
    try {
      const o = {};
      Array.from(mem.entries()).slice(-MAX_CACHE).forEach(([u, v]) => { o[u] = v; });
      sessionStorage.setItem(SS_KEY, JSON.stringify(o));
    } catch (e) {}
  }
  loadSS();

  function firstUrl(text) {
    const m = /https?:\/\/[^\s<>"'`　]+/i.exec(String(text || ''));
    if (!m) return null;
    let u = m[0].replace(/[.,!?;:、。！？）)\]」』】>]+$/, '');
    try {
      const x = new URL(u);
      if ((x.protocol !== 'http:' && x.protocol !== 'https:') || !x.hostname) return null;
      if (x.hostname === location.hostname) return null;          // 自分のサイトのリンクは対象外
      return x.href;
    } catch (e) { return null; }
  }

  function clip(v, n) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : ''; }
  function clean(d) {
    if (!d || typeof d !== 'object') return null;
    const o = { title: clip(d.title, 140), description: clip(d.description, 220), siteName: clip(d.siteName, 60), image: '' };
    // 画像は出さない: CSPで任意の外部画像は読めず、読めても閲覧者のIPが相手サイトに漏れるため
    return (o.title || o.description) ? o : null;
  }

  async function defaultApi(url) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const tm = setTimeout(() => ctl && ctl.abort(), TIMEOUT);
    try {
      const r = await fetch('/api/link-preview?url=' + encodeURIComponent(url), {
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('ring_token') || '') },
        signal: ctl ? ctl.signal : undefined,
      });
      if (r.status === 403) { serverOff = true; return null; }      // サーバー側で無効: このセッションはもう聞かない
      if (!r.ok) return null;
      return await r.json();
    } finally { clearTimeout(tm); }
  }

  function pump() {
    while (active < MAX_CONC && queue.length) {
      const job = queue.shift();
      active++;
      Promise.resolve().then(job.run).then(job.res, () => job.res(null)).then(() => { active--; pump(); });
    }
  }

  function fetchPreview(url, api) {
    const hit = mem.get(url);
    if (hit) return Promise.resolve(hit.d);
    if (pend.has(url)) return pend.get(url);
    const p = new Promise(res => {
      queue.push({ run: () => api(url), res });
      pump();
    }).then(raw => {
      const d = clean(raw);
      if (!serverOff) { mem.set(url, { d, ts: Date.now() }); if (mem.size > MAX_CACHE * 2) mem.delete(mem.keys().next().value); saveSS(); }
      pend.delete(url);
      return d;
    });
    pend.set(url, p);
    return p;
  }

  function css() {
    if (document.getElementById('bro-lp-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-lp-css';
    s.textContent =
      '.blp{display:block;margin-top:6px;max-width:280px;border-radius:12px;overflow:hidden;background:rgba(127,127,127,.16);color:inherit;text-decoration:none;border:1px solid rgba(127,127,127,.22);-webkit-tap-highlight-color:transparent}' +
      '.blp:active{background:rgba(127,127,127,.26)}' +
      '.blp img{display:block;width:100%;height:140px;object-fit:cover;background:rgba(127,127,127,.2)}' +
      '.blp-b{padding:8px 10px;min-height:44px}' +
      '.blp-s{font-size:11px;opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.blp-t{font-size:14px;font-weight:700;line-height:1.35;margin-top:1px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}' +
      '.blp-d{font-size:12px;opacity:.8;line-height:1.35;margin-top:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}';
    document.head.appendChild(s);
  }

  function card(url, d) {
    css();
    const a = document.createElement('a');
    a.className = 'blp'; a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', d.title || url);
    if (d.image) {
      const im = document.createElement('img');
      im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; im.referrerPolicy = 'no-referrer';
      im.addEventListener('error', () => im.remove(), { once: true });
      im.src = d.image;
      a.appendChild(im);
    }
    const b = document.createElement('div'); b.className = 'blp-b';
    let host = ''; try { host = new URL(url).hostname; } catch (e) {}
    const s = document.createElement('div'); s.className = 'blp-s'; s.textContent = d.siteName || host;
    b.appendChild(s);
    if (d.title) { const t = document.createElement('div'); t.className = 'blp-t'; t.textContent = d.title; b.appendChild(t); }
    if (d.description) { const x = document.createElement('div'); x.className = 'blp-d'; x.textContent = d.description; b.appendChild(x); }
    a.appendChild(b);
    return a;
  }

  function attach(bubble, text, opts) {
    try {
      opts = opts || {};
      if (!bubble || !enabled() || serverOff) return;
      if (opts.offlineDraft || opts.encryptedFailed) return;
      if (bubble._blp) return;
      if (bubble.closest && bubble.closest('[data-no-preview]')) return;
      const url = firstUrl(text);
      if (!url) return;
      bubble._blp = url;
      const api = typeof opts.api === 'function' ? opts.api : defaultApi;
      fetchPreview(url, api).then(d => {
        if (!d || bubble._blpDone) return;
        if (!enabled()) return;                          // 取得中に設定をオフにされた
        bubble._blpDone = true;
        bubble.appendChild(card(url, d));
        if (typeof opts.onAdd === 'function') { try { opts.onAdd(); } catch (e) {} }
      }).catch(() => {});
    } catch (e) {}
  }

  window.BroLinkPreview = { attach, _firstUrl: firstUrl, _clean: clean };
})();
