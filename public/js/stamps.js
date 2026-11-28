// stamps.js
// スタンプ(LINEと同じ使い勝手)。絵は stampArt.js(公式)と、利用者が作ったスタンプ(サーバー保存の画像)。
//
// 送り方: スタンプは「本文が [[stamp:キー]] だけのテキストメッセージ」。新しいメッセージ種別は作らないので
//   1:1もグループも今のE2E暗号のまま通る。古い版の端末では [[stamp:...]] の文字が見えるだけで壊れない。
//   キー:  ok                     公式スタンプ(昔の18種のIDもそのまま使える)
//          u:<uuid>               自作・ショップのスタンプ(画像URLはサーバーに聞く)
//          m:<id>:<文字(URLエンコード)>  メッセージスタンプ(好きな文字入り)
//
//   BroStamps.parse(text)        -> キー | null   (本文がスタンプ1個だけの時)
//   BroStamps.encode(key)        -> '[[stamp:key]]'
//   BroStamps.label(key) / previewText(text)
//   BroStamps.el(key, px, { live }) -> 表示用の要素(タップで動きの再生・スタンプ情報)
//   BroStamps.attach({ input, form, dock, scroller, send(text), canSend() })  入力欄にスタンプボタンとサジェストを付ける
//   BroStamps.openPicker({ onPick(key) })  (attachを使わない画面用)
//   BroStamps.openShop() / openManager() / openMaker()
(function () {
  if (window.BroStamps) return;
  const ART = window.BroStampArt;
  if (!ART) { console.error('[stamps] stampArt.js が先に必要です'); return; }

  const tr = (k, fb) => { try { return (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } };
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const BUILTIN_IDS = ART.packs.map(p => p.id);
  const lsGet = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch (e) { return fb; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const reduceMotion = () => document.documentElement.classList.contains('reduce-motion') || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const haptic = k => { try { if (window.LiquidGlass && LiquidGlass.haptic) LiquidGlass.haptic(k || 'light'); } catch (e) {} };

  // ---------------------------------------------------------------- キー
  const RE = /^\[\[stamp:([^\[\]\s]{1,200})\]\]$/;
  function msgText(key) {
    const m = /^m:([a-z0-9_]{1,24}):(.+)$/.exec(key);
    if (!m) return null;
    try { return decodeURIComponent(m[2]); } catch (e) { return null; }
  }
  function validKey(key) {
    if (typeof key !== 'string') return false;
    if (key.startsWith('u:')) return UUID_RE.test(key.slice(2));
    if (key.startsWith('m:')) {
      const id = key.split(':')[1];
      const d = ART.def(id);
      const t = msgText(key);
      return !!(d && d.msg && t && Array.from(t).length <= ART.MSG_MAX && !/[\u0000-\u001f]/.test(t));
    }
    const d = ART.def(key);
    return !!(d && !d.msg);
  }
  function parse(text) {
    if (typeof text !== 'string') return null;
    const m = RE.exec(text.trim());
    return m && validKey(m[1]) ? m[1] : null;
  }
  function encode(key) { return validKey(key) ? '[[stamp:' + key + ']]' : ''; }
  function msgKey(id, text) { return 'm:' + id + ':' + encodeURIComponent(String(text).slice(0, 200)); }
  function baseId(key) { return key.startsWith('m:') ? key.split(':')[1] : key; }
  function label(key) {
    if (!key) return '';
    if (key.startsWith('m:')) return msgText(key) || '';
    if (key.startsWith('u:')) { const m = META.get(key.slice(2)); return (m && m.label) || tr('stamp_title', 'スタンプ'); }
    const d = ART.def(key);
    return d ? tr('stamp_' + key, d.label) : '';
  }
  function previewText(text) {
    const k = parse(text);
    if (!k) return null;
    const l = label(k);
    const head = tr('stamp_preview', 'スタンプ');
    return l && l !== head ? head + ': ' + l : head;
  }

  // ---------------------------------------------------------------- API
  async function api(path, method, body) {
    const t = localStorage.getItem('ring_token');
    const r = await fetch(path, {
      method: method || 'GET',
      headers: Object.assign({ 'Content-Type': 'application/json' }, t ? { Authorization: 'Bearer ' + t } : {}),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let j = {};
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) { const e = new Error((j && j.error) || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return j;
  }

  // ---------------------------------------------------------------- 自作スタンプの画像URL(まとめて引いて覚えておく)
  const META = new Map(Object.entries(lsGet('bro_stk_meta_v1', {})));
  let metaSaveT = 0;
  function saveMeta() {
    clearTimeout(metaSaveT);
    metaSaveT = setTimeout(() => {
      const o = {};
      Array.from(META.entries()).slice(-600).forEach(([k, v]) => { o[k] = v; });
      lsSet('bro_stk_meta_v1', o);
    }, 400);
  }
  function putMeta(s) {
    if (!s || !s.id || typeof s.url !== 'string' || !/^https?:\/\//.test(s.url)) return;
    META.set(s.id, { url: s.url, label: s.label || '', packId: s.packId, animated: !!s.animated });
    saveMeta();
  }
  const pend = new Map(); // id -> [resolve]
  let pendT = 0;
  function resolveMeta(id) {
    if (META.has(id)) return Promise.resolve(META.get(id));
    return new Promise(res => {
      if (!pend.has(id)) pend.set(id, []);
      pend.get(id).push(res);
      clearTimeout(pendT);
      pendT = setTimeout(flushMeta, 40);
    });
  }
  async function flushMeta() {
    const ids = Array.from(pend.keys()).slice(0, 60);
    const waiting = ids.map(id => [id, pend.get(id)]);
    ids.forEach(id => pend.delete(id));
    if (pend.size) pendT = setTimeout(flushMeta, 40);
    let got = [];
    try { got = (await api('/api/stickers/s?ids=' + ids.join(','))).stickers || []; } catch (e) {}
    got.forEach(putMeta);
    waiting.forEach(([id, rs]) => rs.forEach(r => r(META.get(id) || null)));
  }

  // ---------------------------------------------------------------- マイスタンプ(端末にも控えを置いて、すぐ開けるようにする)
  const ST = Object.assign({ order: BUILTIN_IDS.slice(), hidden: [], packs: {}, favs: [] }, lsGet('bro_stk_state_v1', {}));
  let recent = lsGet('bro_stk_recent_v1', []);
  const prefs = Object.assign({ preview: true, suggest: true, sound: true }, lsGet('bro_stk_prefs_v1', {}));
  const listeners = new Set();
  const changed = () => { lsSet('bro_stk_state_v1', ST); listeners.forEach(f => { try { f(); } catch (e) {} }); };
  let loading = null;
  function refresh() {
    if (!localStorage.getItem('ring_token')) return Promise.resolve();
    if (loading) return loading;
    loading = api('/api/stickers/mine').then(j => {
      ST.order = Array.isArray(j.order) ? j.order : BUILTIN_IDS.slice();
      ST.hidden = Array.isArray(j.hidden) ? j.hidden : [];
      ST.favs = Array.isArray(j.favs) ? j.favs : [];
      ST.packs = {};
      (j.packs || []).forEach(p => { ST.packs[p.id] = p; (p.stickers || []).forEach(putMeta); });
      changed();
    }).catch(() => {}).finally(() => { setTimeout(() => { loading = null; }, 0); });
    return loading;
  }
  let lastRefresh = 0;
  function maybeRefresh() { if (Date.now() - lastRefresh > 60000) { lastRefresh = Date.now(); refresh(); } }

  function packOf(id) {
    const b = ART.packs.find(p => p.id === id);
    if (b) return { id: b.id, title: b.title, author: b.author, desc: b.desc, builtin: true, kind: b.kind, items: b.stickers.map(s => ({ key: s.id, label: s.label, kw: s.kw, msg: s.msg, anim: s.anim, snd: s.snd })) };
    const c = ST.packs[id];
    if (!c) return null;
    return { id: c.id, title: c.title, author: c.author, desc: c.description, builtin: false, mine: c.mine, cover: c.cover, items: (c.stickers || []).map(s => ({ key: 'u:' + s.id, label: s.label, kw: s.keywords || [], url: s.url, animated: s.animated })) };
  }
  function visiblePacks() {
    return ST.order.filter(id => !ST.hidden.includes(id)).map(packOf).filter(p => p && p.items.length);
  }
  function isFav(key) { return ST.favs.includes(key); }
  let favT = 0;
  function toggleFav(key) {
    const on = !isFav(key);
    ST.favs = on ? [key].concat(ST.favs.filter(k => k !== key)).slice(0, 100) : ST.favs.filter(k => k !== key);
    changed();
    clearTimeout(favT);
    favT = setTimeout(() => api('/api/stickers/favs', 'PUT', { keys: ST.favs }).catch(() => toast(tr('stamp_save_failed', '保存できませんでした'))), 500);
    toast(on ? tr('stamp_fav_added', 'お気に入りに追加しました') : tr('stamp_fav_removed', 'お気に入りから外しました'));
    return on;
  }
  function pushRecent(key) {
    recent = [key].concat(recent.filter(k => k !== key)).slice(0, 40);
    lsSet('bro_stk_recent_v1', recent);
  }

  // ---------------------------------------------------------------- 文字の正規化(検索・サジェスト)
  function norm(s) {
    return String(s || '').normalize('NFKC').toLowerCase()
      .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
      .replace(/[\s!?！？。、.,~〜…・ー\-]/g, '');
  }
  function allItems() {
    const out = [];
    const seen = new Set();
    visiblePacks().forEach(p => p.items.forEach(it => { if (!seen.has(it.key)) { seen.add(it.key); out.push(it); } }));
    return out;
  }
  function itemOf(key) {
    const id = baseId(key);
    if (id.startsWith('u:')) {
      const m = META.get(id.slice(2));
      return { key, label: (m && m.label) || '', kw: [], url: m && m.url };
    }
    const d = ART.def(id);
    return d ? { key, label: d.label, kw: d.kw, msg: d.msg, anim: d.anim, snd: d.snd } : null;
  }
  function search(q) {
    const n = norm(q);
    if (!n) return [];
    const hit = [];
    allItems().forEach(it => {
      const words = [it.label].concat(it.kw || []).map(norm).filter(Boolean);
      let score = 0;
      words.forEach(w => { if (w === n) score = Math.max(score, 3); else if (w.startsWith(n)) score = Math.max(score, 2); else if (n.length >= 2 && w.includes(n)) score = Math.max(score, 1); });
      if (score) hit.push([score, it]);
    });
    return hit.sort((a, b) => b[0] - a[0]).map(x => x[1]);
  }
  // サジェスト: 入力した言葉そのもの/前方一致だけ(関係ない物が出ないように)
  function suggest(text) {
    const n = norm(text);
    if (!n || n.length > 12) return [];
    const hit = [];
    allItems().forEach(it => {
      if (it.msg) return;
      const words = [it.label].concat(it.kw || []).map(norm).filter(Boolean);
      if (words.some(w => w === n || (n.length >= 2 && w.startsWith(n)))) hit.push(it);
    });
    return hit.slice(0, 16);
  }

  // ---------------------------------------------------------------- CSS
  function css() {
    if (document.getElementById('bro-stamp-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-stamp-css';
    s.textContent = ART.css +
      '.bro-stamp{display:inline-block;line-height:0;position:relative;cursor:pointer;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
      '.bro-stamp svg,.bro-stamp img{width:100%;height:100%;display:block;object-fit:contain;pointer-events:none}' +
      '.bro-stamp.ld::after{content:"";position:absolute;inset:12%;border-radius:22px;background:rgba(148,163,184,.25)}' +
      '.bro-stamp .bstk-gone{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:18px;background:rgba(148,163,184,.18);color:#94a3b8;font-size:12px;line-height:1.3}' +
      '.bstk{--bg:#fff;--fg:#0f172a;--sub:#64748b;--line:rgba(15,23,42,.1);--fld:#eef1f5;--acc:#06c755;font-family:inherit;-webkit-tap-highlight-color:transparent}' +
      'html.dark-mode .bstk{--bg:#1e293b;--fg:#e2e8f0;--sub:#94a3b8;--line:rgba(255,255,255,.1);--fld:#334155}' +
      '.bstk button{font:inherit;color:inherit}' +
      // ピッカー(下に固定。入力欄はその上に押し上げる)
      '.bstk-pk{position:fixed;left:0;right:0;bottom:0;z-index:20600;display:flex;justify-content:center;pointer-events:none}' +
      '.bstk-sh{pointer-events:auto;position:relative;width:100%;max-width:640px;height:var(--h,320px);display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border-radius:16px 16px 0 0;box-shadow:0 -6px 30px rgba(0,0,0,.12);padding-bottom:env(safe-area-inset-bottom,0px);transform:translate3d(0,100%,0);transition:transform .32s cubic-bezier(.2,1,.3,1)}' +
      '.bstk-pk.on .bstk-sh{transform:none}' +
      '.bstk-bd{position:fixed;inset:0;pointer-events:auto;background:transparent}' +
      '.bstk-tabs{display:flex;align-items:center;gap:2px;padding:6px 6px 4px;border-bottom:1px solid var(--line);flex:none}' +
      '.bstk-ts{display:flex;gap:2px;overflow-x:auto;flex:1;scrollbar-width:none;-webkit-overflow-scrolling:touch}.bstk-ts::-webkit-scrollbar{display:none}' +
      '.bstk-t{flex:none;width:42px;height:38px;border:0;border-radius:10px;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:3px;opacity:.6;position:relative}' +
      '.bstk-t.on{opacity:1;background:var(--fld)}' +
      '.bstk-t svg,.bstk-t img{width:32px;height:32px;display:block;object-fit:contain;pointer-events:none}' +
      '.bstk-t .ic{width:22px;height:22px}' +
      '.bstk-x{flex:none;width:38px;height:38px;border:0;border-radius:10px;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--sub)}' +
      '.bstk-name{padding:6px 14px 0;font-size:12px;font-weight:700;color:var(--sub);flex:none;display:flex;align-items:center;gap:8px;min-height:22px}' +
      '.bstk-name span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.bstk-name button{border:0;background:none;color:var(--acc);font-size:12px;font-weight:700;cursor:pointer;padding:2px 4px}' +
      '.bstk-body{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:4px 8px 10px}' +
      '.bstk-g{display:grid;grid-template-columns:repeat(4,1fr);gap:4px}' +
      '@media (min-width:520px){.bstk-g{grid-template-columns:repeat(5,1fr)}}' +
      '.bstk-b{position:relative;aspect-ratio:1;border:0;border-radius:12px;background:transparent;padding:4px;cursor:pointer;display:flex;align-items:center;justify-content:center;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}' +
      '.bstk-b:active,.bstk-b.sel{background:var(--fld)}' +
      '.bstk-b svg,.bstk-b img{width:100%;height:100%;display:block;object-fit:contain;pointer-events:none}' +
      '.bstk-b .fav{position:absolute;right:4px;top:4px;width:14px;height:14px;pointer-events:none}' +
      '.bstk-b .tag{position:absolute;left:4px;bottom:4px;font-size:9px;font-weight:800;padding:1px 4px;border-radius:5px;background:rgba(15,23,42,.6);color:#fff;pointer-events:none}' +
      '.bstk-empty{padding:28px 16px;text-align:center;color:var(--sub);font-size:14px;line-height:1.6}' +
      '.bstk-empty button,.bstk-btn2{margin-top:12px;border:0;border-radius:999px;background:var(--acc);color:#fff!important;font-weight:700;font-size:14px;padding:10px 18px;cursor:pointer}' +
      '.bstk-sr{display:flex;gap:8px;align-items:center;padding:4px 4px 8px}' +
      '.bstk-in{flex:1;min-width:0;border:0;border-radius:10px;background:var(--fld);color:var(--fg);font:inherit;font-size:15px;padding:9px 12px;outline:none}' +
      // プレビュー(タップでもう一度送る)
      '.bstk-pv{position:fixed;left:50%;z-index:20610;transform:translate(-50%,10px) scale(.92);opacity:0;transition:opacity .18s,transform .3s cubic-bezier(.2,1.4,.4,1);pointer-events:none;display:flex;flex-direction:column;align-items:center}' +
      '.bstk-pv.on{opacity:1;transform:translate(-50%,0);pointer-events:auto}' +
      '.bstk-pvc{position:relative;background:rgba(15,23,42,.08);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border-radius:22px;padding:10px 46px 10px 46px}' +
      'html.dark-mode .bstk-pvc{background:rgba(255,255,255,.08)}' +
      '.bstk-pvs{width:min(44vw,170px);height:min(44vw,170px);border:0;background:none;padding:0;cursor:pointer;display:block}' +
      '.bstk-pvs svg,.bstk-pvs img{width:100%;height:100%;display:block;object-fit:contain;pointer-events:none}' +
      '.bstk-pvb{position:absolute;width:34px;height:34px;border-radius:50%;border:0;background:var(--bg);color:var(--fg);box-shadow:0 2px 8px rgba(0,0,0,.18);display:flex;align-items:center;justify-content:center;cursor:pointer}' +
      '.bstk-pvb.x{right:6px;top:6px}.bstk-pvb.f{left:6px;top:6px}.bstk-pvb.e{left:6px;bottom:6px}' +
      '.bstk-pvh{margin-top:6px;font-size:12px;font-weight:700;color:#fff;background:rgba(15,23,42,.55);padding:3px 10px;border-radius:999px}' +
      // サジェスト
      '.bstk-sg{position:fixed;z-index:20590;display:flex;gap:4px;padding:6px;overflow-x:auto;background:var(--bg);border-radius:16px;box-shadow:0 6px 24px rgba(0,0,0,.16);scrollbar-width:none;opacity:0;transform:translateY(6px);transition:opacity .15s,transform .2s;pointer-events:none}' +
      '.bstk-sg::-webkit-scrollbar{display:none}.bstk-sg.on{opacity:1;transform:none;pointer-events:auto}' +
      '.bstk-sg button{flex:none;width:62px;height:62px;border:0;border-radius:10px;background:transparent;padding:2px;cursor:pointer}' +
      '.bstk-sg button:active{background:var(--fld)}' +
      '.bstk-sg svg,.bstk-sg img{width:100%;height:100%;display:block;object-fit:contain;pointer-events:none}' +
      // 入力欄のスタンプボタン
      '.bstk-ib{flex:none;width:34px;height:34px;border:0;border-radius:50%;background:transparent;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;color:#64748b}' +
      '.bstk-ib.on{color:#06c755}' +
      'html.dark-mode .bstk-ib{color:#94a3b8}' +
      // 下からのシート・全画面
      '.bstk-ov{position:fixed;inset:0;z-index:20650;display:flex;align-items:flex-end;justify-content:center}' +
      '.bstk-ovbd{position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0;transition:opacity .22s}' +
      '.bstk-ov.on .bstk-ovbd{opacity:1}' +
      '.bstk-card{position:relative;width:100%;max-width:560px;max-height:86vh;display:flex;flex-direction:column;background:var(--bg);color:var(--fg);border-radius:18px 18px 0 0;padding-bottom:env(safe-area-inset-bottom,0px);transform:translate3d(0,100%,0);transition:transform .38s cubic-bezier(.2,1,.3,1)}' +
      '.bstk-ov.on .bstk-card{transform:none}' +
      '.bstk-ov.full .bstk-card{max-width:640px;height:100%;max-height:none;border-radius:0}' +
      '@media (min-width:700px){.bstk-ov.full{align-items:center;padding:24px}.bstk-ov.full .bstk-card{height:min(860px,100%);border-radius:18px}}' +
      '.bstk-hd{display:flex;align-items:center;gap:6px;padding:calc(10px + env(safe-area-inset-top,0px)) 8px 8px;border-bottom:1px solid var(--line);flex:none}' +
      '.bstk-ov:not(.full) .bstk-hd{padding-top:10px}' +
      '.bstk-hd h2{flex:1;margin:0;font-size:17px;font-weight:800;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.bstk-hb{width:40px;height:40px;border:0;background:none;border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}' +
      '.bstk-sc{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;padding:12px 14px 20px}' +
      '.bstk-seg{display:flex;gap:6px;margin:4px 0 12px}' +
      '.bstk-seg button{flex:1;border:0;border-radius:999px;background:var(--fld);padding:8px;font-size:13px;font-weight:700;cursor:pointer}' +
      '.bstk-seg button.on{background:var(--fg);color:var(--bg)}' +
      '.bstk-row{display:flex;align-items:center;gap:12px;padding:10px 4px;border-bottom:1px solid var(--line);cursor:pointer}' +
      '.bstk-row .cv{width:58px;height:58px;flex:none;display:flex;align-items:center;justify-content:center}' +
      '.bstk-row .cv svg,.bstk-row .cv img{width:100%;height:100%;object-fit:contain;display:block}' +
      '.bstk-row .tx{flex:1;min-width:0}' +
      '.bstk-row .t1{font-size:15px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.bstk-row .t2{font-size:12px;color:var(--sub);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.bstk-add{flex:none;border:0;border-radius:999px;padding:7px 14px;font-size:13px;font-weight:800;background:var(--acc);color:#fff!important;cursor:pointer}' +
      '.bstk-add.done{background:var(--fld);color:var(--sub)!important}' +
      '.bstk-mini{flex:none;width:34px;height:34px;border:0;border-radius:9px;background:var(--fld);display:flex;align-items:center;justify-content:center;cursor:pointer}' +
      '.bstk-mini:disabled{opacity:.3}' +
      '.bstk-hero{display:flex;gap:14px;align-items:center;margin-bottom:12px}' +
      '.bstk-hero .cv{width:110px;height:110px;flex:none}' +
      '.bstk-hero .cv svg,.bstk-hero .cv img{width:100%;height:100%;object-fit:contain;display:block}' +
      '.bstk-hero h3{margin:0;font-size:18px;font-weight:800;word-break:break-word}' +
      '.bstk-hero p{margin:4px 0 0;font-size:13px;color:var(--sub);word-break:break-word}' +
      '.bstk-big{display:block;width:100%;min-height:46px;border:0;border-radius:12px;background:var(--acc);color:#fff!important;font-size:16px;font-weight:800;cursor:pointer;margin:6px 0 14px}' +
      '.bstk-big.done{background:var(--fld);color:var(--sub)!important}' +
      '.bstk-link{border:0;background:none;color:var(--sub);font-size:12px;text-decoration:underline;cursor:pointer;padding:8px 0}' +
      '.bstk-sw{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 4px;border-bottom:1px solid var(--line);font-size:15px}' +
      '.bstk-sw small{display:block;color:var(--sub);font-size:12px;margin-top:2px}' +
      '.bstk-tg{position:relative;width:48px;height:28px;flex:none;border:0;border-radius:999px;background:#cbd5e1;cursor:pointer;transition:background .2s}' +
      '.bstk-tg::after{content:"";position:absolute;left:3px;top:3px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s}' +
      '.bstk-tg.on{background:var(--acc)}.bstk-tg.on::after{transform:translateX(20px)}' +
      '.bstk-h3{font-size:13px;font-weight:800;color:var(--sub);margin:18px 4px 4px}' +
      '.bstk-banner{display:flex;align-items:center;gap:12px;width:100%;border:0;border-radius:14px;padding:12px 14px;margin-bottom:12px;background:linear-gradient(135deg,#06c755,#00a6ff);color:#fff!important;text-align:left;cursor:pointer}' +
      '.bstk-banner b{display:block;font-size:15px}.bstk-banner small{font-size:12px;opacity:.9}' +
      // メッセージスタンプの入力
      '.bstk-me{position:fixed;inset:0;z-index:20680;display:flex;align-items:center;justify-content:center;padding:20px}' +
      '.bstk-me .bstk-ovbd{opacity:1}' +
      '.bstk-mc{position:relative;width:100%;max-width:340px;background:var(--bg);color:var(--fg);border-radius:20px;padding:16px;box-shadow:0 20px 60px rgba(0,0,0,.3)}' +
      '.bstk-mc .pv{width:180px;height:180px;margin:0 auto 10px}.bstk-mc .pv svg{width:100%;height:100%;display:block}' +
      '.bstk-mc .cnt{text-align:right;font-size:11px;color:var(--sub);margin:4px 2px 10px}' +
      '.bstk-mc .bt{display:flex;gap:8px}.bstk-mc .bt button{flex:1;min-height:44px;border:0;border-radius:12px;font-weight:800;font-size:15px;cursor:pointer;background:var(--fld)}' +
      '.bstk-mc .bt button.go{background:var(--acc);color:#fff!important}' +
      '.bstk-toast{position:fixed;left:50%;bottom:calc(90px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);z-index:20900;background:rgba(15,23,42,.88);color:#fff;font-size:13px;font-weight:700;padding:9px 16px;border-radius:999px;pointer-events:none;opacity:0;transition:opacity .2s;max-width:80vw;text-align:center}' +
      '.bstk-toast.on{opacity:1}' +
      '.bstk-fx{position:fixed;inset:0;z-index:20800;pointer-events:none}' +
      'html.reduce-motion .bstk-sh,html.reduce-motion .bstk-card,html.reduce-motion .bstk-pv{transition:none!important}' +
      '@media (prefers-reduced-motion:reduce){.bstk-sh,.bstk-card,.bstk-pv{transition:none!important}}';
    document.head.appendChild(s);
  }

  // ---------------------------------------------------------------- 小物
  const ICON = {
    search: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>',
    clock: '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    star: '<svg class="ic" viewBox="0 0 24 24" fill="#ffc531" stroke="#e0a400" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>',
    starO: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>',
    starF: '<svg viewBox="0 0 24 24" width="18" height="18" fill="#ffc531" stroke="#e0a400" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1L3.2 9.4l6.1-.8z"/></svg>',
    x: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    gear: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
    shop: '<svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18M16 10a4 4 0 0 1-8 0"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    edit: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    up: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.1 10.1 0 0 1 12 19c-7 0-11-7-11-7a18.4 18.4 0 0 1 5.1-5.9M9.9 4.2A9.1 9.1 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.2 3.2M1 1l22 22"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    smile: '<svg viewBox="0 0 24 24" width="23" height="23" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="M8.2 14.2q3.8 3.6 7.6 0"/><circle cx="9" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.1" fill="currentColor" stroke="none"/></svg>',
  };
  function h(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function btn(cls, html, aria, on) { const b = h('button', cls, html); b.type = 'button'; if (aria) b.setAttribute('aria-label', aria); if (on) b.addEventListener('click', on); return b; }
  let toastT = 0;
  function toast(msg) {
    css();
    let t = document.getElementById('bstk-toast');
    if (!t) { t = h('div', 'bstk-toast'); t.id = 'bstk-toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('on'), 1800);
  }
  // スタンプの絵(グリッド・タブ・プレビュー用)。公式はSVG文字列(固定値+エスケープ済み)、自作は<img>
  function art(key, px, opt) {
    const id = baseId(key);
    if (id.startsWith('u:')) {
      const img = document.createElement('img');
      img.alt = ''; img.draggable = false; img.decoding = 'async';
      if (!(opt && opt.eager)) img.loading = 'lazy';
      const m = META.get(id.slice(2));
      if (m) img.src = m.url;
      else resolveMeta(id.slice(2)).then(mm => { if (mm) img.src = mm.url; });
      return img;
    }
    const tmp = document.createElement('div');
    tmp.innerHTML = ART.svg(id, { px: px || 96, text: msgText(key) || '' });
    return tmp.firstChild || document.createElement('span');
  }
  function play(el) {
    if (!el || reduceMotion()) return;
    el.classList.remove('sa-play');
    void el.offsetWidth;
    el.classList.add('sa-play');
    clearTimeout(el._playT);
    el._playT = setTimeout(() => el.classList.remove('sa-play'), 6000);
  }
  function sound(key) { if (!prefs.sound) return; const d = ART.def(baseId(key)); if (d && d.snd) ART.playSound(d.snd); }

  // ---------------------------------------------------------------- 画面いっぱいのエフェクト(おめでとう・すき等)
  let lastFx = 0;
  function runFx(kind) {
    if (!kind || reduceMotion() || Date.now() - lastFx < 1500) return;
    lastFx = Date.now();
    css();
    const c = document.createElement('canvas');
    c.className = 'bstk-fx';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = innerWidth, H = innerHeight;
    c.width = W * dpr; c.height = H * dpr;
    document.body.appendChild(c);
    const g = c.getContext('2d'); g.scale(dpr, dpr);
    const P = [];
    const cols = kind === 'hearts' ? ['#ff4d6d', '#ff7aa2', '#ff9ab5', '#ffc2d4'] : ['#ff5a7a', '#ffd23f', '#5ad1ff', '#7be08a', '#b388ff', '#ffa94d'];
    const N = kind === 'hearts' ? 26 : 90;
    for (let i = 0; i < N; i++) {
      if (kind === 'hearts') P.push({ x: Math.random() * W, y: H + 20 + Math.random() * H * .4, vx: (Math.random() - .5) * .6, vy: -(1.6 + Math.random() * 2.2), s: 14 + Math.random() * 18, r: 0, vr: 0, c: cols[i % cols.length], w: Math.random() * 6 });
      else P.push({ x: W / 2 + (Math.random() - .5) * 80, y: H * .62, vx: (Math.random() - .5) * 14, vy: -(8 + Math.random() * 10), s: 6 + Math.random() * 6, r: Math.random() * 6, vr: (Math.random() - .5) * .4, c: cols[i % cols.length] });
    }
    const t0 = performance.now();
    function heart(x, y, s, col) {
      g.save(); g.translate(x, y); g.scale(s / 20, s / 20); g.beginPath();
      g.moveTo(0, 6); g.bezierCurveTo(-12, -2, -9, -14, 0, -6); g.bezierCurveTo(9, -14, 12, -2, 0, 6); g.closePath();
      g.fillStyle = col; g.fill(); g.restore();
    }
    function frame(t) {
      const e = t - t0;
      g.clearRect(0, 0, W, H);
      const fade = e > 1800 ? Math.max(0, 1 - (e - 1800) / 600) : 1;
      g.globalAlpha = fade;
      P.forEach(p => {
        if (kind === 'hearts') { p.x += p.vx + Math.sin((e / 300) + p.w) * .6; p.y += p.vy; heart(p.x, p.y, p.s, p.c); }
        else { p.vy += .35; p.vx *= .99; p.x += p.vx; p.y += p.vy; p.r += p.vr; g.save(); g.translate(p.x, p.y); g.rotate(p.r); g.fillStyle = p.c; g.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2); g.restore(); }
      });
      if (e < 2400) requestAnimationFrame(frame); else c.remove();
    }
    requestAnimationFrame(frame);
  }

  // ---------------------------------------------------------------- トークに出す要素
  let io = null;
  function observe(el) {
    if (!('IntersectionObserver' in window)) { play(el); return; }
    io = io || new IntersectionObserver(es => es.forEach(en => {
      if (en.isIntersecting) { io.unobserve(en.target); play(en.target); }
    }), { threshold: .5 });
    io.observe(el);
  }
  function el(key, px, opts) {
    css();
    opts = opts || {};
    px = px || 128;
    const s = document.createElement('span');
    s.className = 'bro-stamp';
    s.dataset.stamp = key;
    s.style.width = px + 'px'; s.style.height = px + 'px';
    s.setAttribute('role', 'img');
    s.setAttribute('aria-label', label(key));
    const id = baseId(key);
    if (id.startsWith('u:')) {
      s.classList.add('ld');
      const img = document.createElement('img');
      img.alt = ''; img.draggable = false; img.decoding = 'async';
      const show = m => {
        s.classList.remove('ld');
        if (!m) { s.innerHTML = ''; const g = h('span', 'bstk-gone'); g.textContent = tr('stamp_title', 'スタンプ'); s.appendChild(g); return; }
        img.src = m.url; s.setAttribute('aria-label', m.label || tr('stamp_title', 'スタンプ'));
      };
      img.onerror = () => show(null);
      s.appendChild(img);
      const m = META.get(id.slice(2));
      if (m) show(m); else resolveMeta(id.slice(2)).then(show);
    } else {
      s.innerHTML = ART.svg(id, { px, text: msgText(key) || '' });
      const d = ART.def(id);
      if (d && d.anim) observe(s);
      if (opts.live && d) {
        if (d.fx) runFx(d.fx);
        if (d.snd) sound(key);
      }
    }
    if (!opts.noTap) {
      let downAt = 0;
      s.addEventListener('pointerdown', () => { downAt = Date.now(); });
      s.addEventListener('click', e => {
        e.stopPropagation();
        if (downAt && Date.now() - downAt > 450) return; // 長押し(メッセージのメニュー)の後は何もしない
        play(s); sound(key);
        const d = ART.def(id);
        if (d && d.fx) runFx(d.fx);
        openInfo(key);
      });
    }
    return s;
  }

  // ---------------------------------------------------------------- ピッカー
  let PK = null; // 開いているピッカー
  function sheetHeight() { return Math.round(Math.max(250, Math.min(innerHeight * .42, 340))); }

  function openPicker(o) {
    o = o || {};
    if (PK) PK.close(true);
    css();
    maybeRefresh();
    const root = h('div', 'bstk bstk-pk');
    const H = sheetHeight();
    const sh = h('div', 'bstk-sh'); sh.style.setProperty('--h', H + 'px');
    sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-label', tr('stamp_title', 'スタンプ'));
    if (!o.dock) { const bd = h('div', 'bstk-bd'); bd.addEventListener('click', () => close()); root.appendChild(bd); }
    const tabs = h('div', 'bstk-tabs');
    const ts = h('div', 'bstk-ts');
    const name = h('div', 'bstk-name');
    const body = h('div', 'bstk-body');
    tabs.appendChild(ts);
    tabs.appendChild(btn('bstk-x', ICON.shop, tr('stamp_shop', 'スタンプショップ'), () => openShop()));
    tabs.appendChild(btn('bstk-x', ICON.gear, tr('stamp_settings', 'スタンプ設定'), () => openManager()));
    sh.appendChild(tabs); sh.appendChild(name); sh.appendChild(body);
    root.appendChild(sh);
    const pv = h('div', 'bstk bstk-pv');
    document.body.appendChild(root);
    document.body.appendChild(pv);

    // 入力欄を押し上げる(LINEのスタンプキーボードと同じ)
    let spacer = null;
    if (o.dock) {
      spacer = h('div');
      spacer.style.cssText = 'flex:none;height:0;transition:height .32s cubic-bezier(.2,1,.3,1)';
      o.dock.parentNode.insertBefore(spacer, o.dock.nextSibling);
      const atBottom = o.scroller ? (o.scroller.scrollHeight - o.scroller.scrollTop - o.scroller.clientHeight < 80) : false;
      requestAnimationFrame(() => {
        spacer.style.height = H + 'px';
        if (atBottom) { const t0 = performance.now(); const keep = () => { o.scroller.scrollTop = o.scroller.scrollHeight; if (performance.now() - t0 < 400) requestAnimationFrame(keep); }; keep(); }
      });
    }

    let tab = lsGet('bro_stk_tab_v1', null);
    let sel = null;
    function tabList() {
      const list = [{ id: 'search', icon: ICON.search, title: tr('stamp_search', '検索') }, { id: 'recent', icon: ICON.clock, title: tr('stamp_recent', '最近使ったスタンプ') }, { id: 'fav', icon: ICON.star, title: tr('stamp_favorites', 'お気に入り') }];
      visiblePacks().forEach(p => list.push({ id: p.id, pack: p, title: p.title }));
      return list;
    }
    function drawTabs() {
      ts.innerHTML = '';
      const list = tabList();
      if (!tab || !list.some(t => t.id === tab)) tab = recent.length ? 'recent' : (list[3] ? list[3].id : 'recent');
      list.forEach(t => {
        const b = btn('bstk-t' + (t.id === tab ? ' on' : ''), t.icon || '', t.title, () => { tab = t.id; lsSet('bro_stk_tab_v1', tab); hidePv(); drawTabs(); drawBody(); });
        if (t.pack) { const first = t.pack.items[0]; b.appendChild(art(first.key, 32, { eager: true })); }
        ts.appendChild(b);
        if (t.id === tab) requestAnimationFrame(() => { try { b.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch (e) {} });
      });
    }
    function grid(items, opt) {
      const g = h('div', 'bstk-g');
      items.forEach(it => {
        const b = btn('bstk-b', '', it.label || label(it.key));
        b.appendChild(art(it.key, 96));
        if (it.msg && !String(it.key).startsWith('m:')) { const tg = h('span', 'tag'); tg.textContent = 'Aa'; b.appendChild(tg); }
        const d = ART.def(baseId(it.key));
        if (d && d.snd) { const tg = h('span', 'tag'); tg.textContent = '♪'; b.appendChild(tg); }
        if (opt && opt.favMark && isFav(it.key)) { const f = h('span', 'fav', ICON.starF); b.appendChild(f); }
        // 長押しでお気に入り
        let lt = 0, longed = false;
        b.addEventListener('pointerdown', () => { longed = false; clearTimeout(lt); lt = setTimeout(() => { longed = true; haptic('medium'); toggleFav(it.key); if (tab === 'fav') drawBody(); }, 520); });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(lt)));
        b.addEventListener('contextmenu', e => e.preventDefault());
        b.addEventListener('click', () => { if (longed) return; pick(it, b); });
        g.appendChild(b);
      });
      return g;
    }
    function empty(msg, action, onAct) {
      const e = h('div', 'bstk-empty'); e.textContent = msg;
      if (action) { e.appendChild(document.createElement('br')); e.appendChild(btn('', '', null, onAct)).textContent = action; }
      return e;
    }
    let searchQ = '';
    function drawBody() {
      body.innerHTML = ''; name.innerHTML = '';
      const nm = h('span');
      name.appendChild(nm);
      if (tab === 'search') {
        nm.textContent = tr('stamp_search', '検索');
        const row = h('div', 'bstk-sr');
        const inp = h('input', 'bstk-in'); inp.type = 'search'; inp.placeholder = tr('stamp_search_ph', 'スタンプを検索'); inp.value = searchQ;
        inp.setAttribute('enterkeyhint', 'search');
        row.appendChild(inp); body.appendChild(row);
        const res = h('div'); body.appendChild(res);
        const run = () => {
          searchQ = inp.value; res.innerHTML = '';
          if (!searchQ.trim()) { res.appendChild(empty(tr('stamp_search_hint', '言葉を入れると、持っているスタンプから探します'))); return; }
          const items = search(searchQ);
          if (items.length) res.appendChild(grid(items, { favMark: true }));
          res.appendChild(empty(items.length ? '' : tr('stamp_search_none', '見つかりませんでした'), tr('stamp_search_shop', 'ショップで探す'), () => openShop({ q: searchQ })));
        };
        inp.addEventListener('input', run);
        run();
        setTimeout(() => { try { inp.focus({ preventScroll: true }); } catch (e) {} }, 60);
        return;
      }
      if (tab === 'recent') {
        nm.textContent = tr('stamp_recent', '最近使ったスタンプ');
        const items = recent.map(itemOf).filter(Boolean);
        if (!items.length) { body.appendChild(empty(tr('stamp_recent_empty', '最近使ったスタンプはまだありません'))); return; }
        const clr = btn('', '', null, () => { recent = []; lsSet('bro_stk_recent_v1', recent); drawBody(); });
        clr.textContent = tr('stamp_clear', '消去'); name.appendChild(clr);
        body.appendChild(grid(items, { favMark: true }));
        return;
      }
      if (tab === 'fav') {
        nm.textContent = tr('stamp_favorites', 'お気に入り');
        const items = ST.favs.map(itemOf).filter(Boolean);
        if (!items.length) { body.appendChild(empty(tr('stamp_fav_empty', 'スタンプを長押しすると、お気に入りに追加できます'))); return; }
        body.appendChild(grid(items));
        return;
      }
      const p = packOf(tab);
      if (!p) return;
      nm.textContent = p.title;
      const info = btn('', '', null, () => openPack(p.id)); info.textContent = tr('stamp_details', '詳細'); name.appendChild(info);
      body.appendChild(grid(p.items, { favMark: true }));
    }

    // ---- プレビュー ----
    let pvKey = null;
    function placePv() {
      const r = sh.getBoundingClientRect();
      pv.style.bottom = (innerHeight - r.top + (o.dock ? (o.dock.getBoundingClientRect().height + 6) : 8)) + 'px';
    }
    function hidePv() {
      pv.classList.remove('on'); pvKey = null;
      if (sel) { sel.classList.remove('sel'); sel = null; }
    }
    function showPv(key, b) {
      pvKey = key;
      if (sel) sel.classList.remove('sel');
      sel = b || null; if (sel) sel.classList.add('sel');
      pv.innerHTML = '';
      const card = h('div', 'bstk-pvc');
      const big = btn('bstk-pvs', '', tr('stamp_send', '送信'), () => send(key));
      const a = art(key, 170, { eager: true });
      big.appendChild(a);
      card.appendChild(big);
      const fb = btn('bstk-pvb f', isFav(key) ? ICON.starF : ICON.starO, tr('stamp_favorites', 'お気に入り'), () => {
        const on = toggleFav(key); fb.innerHTML = on ? ICON.starF : ICON.starO;
      });
      card.appendChild(fb);
      card.appendChild(btn('bstk-pvb x', ICON.x, tr('close', '閉じる'), hidePv));
      if (key.startsWith('m:')) card.appendChild(btn('bstk-pvb e', ICON.edit, tr('edit', '編集'), () => editMsg(baseId(key), msgText(key))));
      pv.appendChild(card);
      const hint = h('div', 'bstk-pvh'); hint.textContent = tr('stamp_tap_to_send', 'タップして送信'); pv.appendChild(hint);
      placePv();
      requestAnimationFrame(() => { pv.classList.add('on'); play(big); sound(key); });
    }
    function pick(it, b) {
      haptic('light');
      if (it.msg && !String(it.key).startsWith('m:')) { editMsg(it.key, ''); return; }
      if (!prefs.preview) { send(it.key); return; }
      if (pvKey === it.key) { send(it.key); return; }
      showPv(it.key, b);
    }
    function editMsg(id, text) {
      openMsgEditor(id, text, key => { if (prefs.preview) showPv(key); else send(key); });
    }
    function send(key) {
      if (o.canSend && !o.canSend()) return;
      hidePv();
      pushRecent(key);
      haptic('light');
      const d = ART.def(baseId(key));
      if (d && d.fx) runFx(d.fx);
      try { if (o.onPick) o.onPick(key); } catch (e) { console.error(e); }
      if (tab === 'recent') drawBody();
    }

    let closed = false;
    function close(now) {
      if (closed) return; closed = true;
      PK = null;
      listeners.delete(onChange);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', placePv);
      if (o.scroller) o.scroller.removeEventListener('pointerdown', onChatTap);
      pv.remove();
      if (spacer) { spacer.style.height = '0px'; setTimeout(() => spacer.remove(), now ? 0 : 340); }
      if (o.onClose) try { o.onClose(); } catch (e) {}
      if (now) { root.remove(); return; }
      root.classList.remove('on');
      setTimeout(() => root.remove(), 340);
    }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (pvKey) hidePv(); else close(); } }
    function onChatTap() { if (pvKey) hidePv(); else close(); }
    function onChange() { drawTabs(); if (tab !== 'search') drawBody(); }
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', placePv);
    if (o.scroller) o.scroller.addEventListener('pointerdown', onChatTap);
    listeners.add(onChange);
    drawTabs(); drawBody();
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('on')));
    PK = { close, isOpen: () => !closed };
    return PK;
  }

  // ---------------------------------------------------------------- メッセージスタンプの文字入力
  function openMsgEditor(id, text, done) {
    css();
    const root = h('div', 'bstk bstk-me');
    const bd = h('div', 'bstk-ovbd');
    const c = h('div', 'bstk-mc');
    c.setAttribute('role', 'dialog'); c.setAttribute('aria-modal', 'true');
    const pv = h('div', 'pv');
    const inp = h('input', 'bstk-in'); inp.maxLength = 40; inp.placeholder = tr('stamp_msg_ph', 'スタンプに入れる文字'); inp.value = text || '';
    inp.style.width = '100%'; inp.style.boxSizing = 'border-box';
    const cnt = h('div', 'cnt');
    const bt = h('div', 'bt');
    const cancel = btn('', '', null, () => close()); cancel.textContent = tr('cancel', 'キャンセル');
    const ok = btn('go', '', null, () => {
      const v = inp.value.trim();
      if (!v) { inp.focus(); return; }
      close(); done(msgKey(id, v));
    });
    ok.textContent = tr('ok', 'OK');
    bt.appendChild(cancel); bt.appendChild(ok);
    const draw = () => {
      let v = Array.from(inp.value.replace(/[\u0000-\u001f]/g, ''));
      if (v.length > ART.MSG_MAX) { v = v.slice(0, ART.MSG_MAX); inp.value = v.join(''); }
      pv.innerHTML = ART.svg(id, { px: 180, text: v.join('') || ART.def(id).label });
      cnt.textContent = v.length + ' / ' + ART.MSG_MAX;
    };
    inp.addEventListener('input', draw);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok.click(); } });
    c.appendChild(pv); c.appendChild(inp); c.appendChild(cnt); c.appendChild(bt);
    root.appendChild(bd); root.appendChild(c);
    bd.addEventListener('click', () => close());
    document.body.appendChild(root);
    draw();
    setTimeout(() => { try { inp.focus(); } catch (e) {} }, 50);
    function close() { root.remove(); }
  }

  // ---------------------------------------------------------------- 下から出るカード・全画面の共通
  function overlay(opt) {
    css();
    const root = h('div', 'bstk bstk-ov' + (opt.full ? ' full' : ''));
    const bd = h('div', 'bstk-ovbd');
    const card = h('div', 'bstk-card');
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true');
    const hd = h('div', 'bstk-hd');
    const backB = btn('bstk-hb', opt.full ? ICON.back : ICON.x, tr('close', '閉じる'), () => api_.back());
    const title = h('h2'); title.textContent = opt.title || '';
    const right = h('div'); right.style.cssText = 'width:40px;flex:none;display:flex;justify-content:flex-end';
    hd.appendChild(backB); hd.appendChild(title); hd.appendChild(right);
    const sc = h('div', 'bstk-sc');
    card.appendChild(hd); card.appendChild(sc);
    root.appendChild(bd); root.appendChild(card);
    document.body.appendChild(root);
    bd.addEventListener('click', () => close());
    const stack = [];
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api_.back(); } }
    document.addEventListener('keydown', onKey, true);
    let closed = false;
    function close() {
      if (closed) return; closed = true;
      document.removeEventListener('keydown', onKey, true);
      root.classList.remove('on');
      setTimeout(() => root.remove(), 380);
      if (opt.onClose) try { opt.onClose(); } catch (e) {}
    }
    const api_ = {
      root, sc, title, right, close,
      // 画面を積む(戻るで前の画面へ)
      push(t, draw) { stack.push({ t, draw }); title.textContent = t; right.innerHTML = ''; sc.innerHTML = ''; sc.scrollTop = 0; draw(sc); },
      replace(t, draw) { stack.pop(); api_.push(t, draw); },
      redraw() { const top = stack[stack.length - 1]; if (top) { const y = sc.scrollTop; right.innerHTML = ''; sc.innerHTML = ''; top.draw(sc); sc.scrollTop = y; } },
      back() { stack.pop(); const top = stack[stack.length - 1]; if (!top) { close(); return; } title.textContent = top.t; right.innerHTML = ''; sc.innerHTML = ''; top.draw(sc); },
    };
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('on')));
    return api_;
  }

  async function addPack(id) {
    const r = await api('/api/stickers/mine/' + encodeURIComponent(id), 'POST');
    if (r.pack) { ST.packs[r.pack.id] = r.pack; (r.pack.stickers || []).forEach(putMeta); }
    if (!ST.order.includes(id)) ST.order.push(id);
    ST.hidden = ST.hidden.filter(x => x !== id);
    changed();
  }
  async function removePack(id) {
    await api('/api/stickers/mine/' + encodeURIComponent(id), 'DELETE');
    if (BUILTIN_IDS.includes(id)) { if (!ST.hidden.includes(id)) ST.hidden.push(id); }
    else { delete ST.packs[id]; ST.order = ST.order.filter(x => x !== id); ST.hidden = ST.hidden.filter(x => x !== id); }
    changed();
  }
  function isAdded(id) { return ST.order.includes(id) && !ST.hidden.includes(id) && (BUILTIN_IDS.includes(id) || !!ST.packs[id]); }

  // パックの詳細(ショップ・届いたスタンプから)
  function drawPackDetail(ov, p, focusKey) {
    return sc => {
      const hero = h('div', 'bstk-hero');
      const cv = h('div', 'cv');
      const firstKey = focusKey || (p.items[0] && p.items[0].key);
      if (firstKey) { const a = art(firstKey, 110, { eager: true }); cv.appendChild(a); setTimeout(() => { play(cv); sound(firstKey); }, 60); }
      const tx = h('div');
      const h3 = h('h3'); h3.textContent = p.title;
      const au = h('p'); au.textContent = (p.author || '') + (p.builtin ? ' ・ ' + tr('stamp_official', '公式') : '');
      const ds = h('p'); ds.textContent = p.desc || '';
      tx.appendChild(h3); tx.appendChild(au); if (p.desc) tx.appendChild(ds);
      hero.appendChild(cv); hero.appendChild(tx);
      sc.appendChild(hero);
      const added = isAdded(p.id);
      const big = btn('bstk-big' + (added ? ' done' : ''), '', null, async () => {
        big.disabled = true;
        try {
          if (isAdded(p.id)) { await removePack(p.id); toast(tr('stamp_removed', 'マイスタンプから外しました')); }
          else { await addPack(p.id); toast(tr('stamp_added', 'マイスタンプに追加しました')); haptic('success'); }
        } catch (e) { toast(e.message || tr('stamp_save_failed', '保存できませんでした')); }
        ov.redraw();
      });
      big.textContent = added ? tr('stamp_added_short', '追加済み(タップで外す)') : tr('stamp_download_free', '無料でダウンロード');
      if (p.deleted) { big.disabled = true; big.textContent = tr('stamp_pack_deleted', 'このスタンプは作った人が削除しました'); big.classList.add('done'); }
      sc.appendChild(big);
      const g = h('div', 'bstk-g');
      p.items.forEach(it => {
        const b = btn('bstk-b', '', it.label);
        b.appendChild(art(it.key, 96));
        if (isFav(it.key)) b.appendChild(h('span', 'fav', ICON.starF));
        b.addEventListener('click', () => { cv.innerHTML = ''; cv.appendChild(art(it.key, 110, { eager: true })); play(cv); sound(it.key); });
        let lt = 0;
        b.addEventListener('pointerdown', () => { clearTimeout(lt); lt = setTimeout(() => { haptic('medium'); toggleFav(it.key); ov.redraw(); }, 520); });
        ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(lt)));
        b.addEventListener('contextmenu', e => e.preventDefault());
        g.appendChild(b);
      });
      sc.appendChild(g);
      const hint = h('div', 'bstk-empty'); hint.style.padding = '12px'; hint.textContent = tr('stamp_long_fav', '長押しでお気に入りに追加'); sc.appendChild(hint);
      if (!p.builtin && !p.mine && p.authorId) {
        const rep = btn('bstk-link', '', null, () => reportPack(p)); rep.textContent = tr('stamp_report', 'このスタンプを通報する');
        sc.appendChild(rep);
      }
    };
  }
  async function loadPack(id) {
    if (BUILTIN_IDS.includes(id)) return packOf(id);
    const j = await api('/api/stickers/packs/' + encodeURIComponent(id));
    (j.stickers || []).forEach(putMeta);
    return { id: j.id, title: j.title, author: j.author, authorId: j.authorId, desc: j.description, builtin: false, mine: j.mine, deleted: j.deleted, items: (j.stickers || []).map(s => ({ key: 'u:' + s.id, label: s.label, kw: s.keywords })) };
  }
  async function reportPack(p) {
    const why = prompt(tr('stamp_report_why', 'どこが問題か教えてください(5文字以上)'), '');
    if (!why || why.trim().length < 5) return;
    try {
      await api('/api/reports', 'POST', { kind: 'user', category: 'inappropriate', targetUserId: p.authorId, message: '[スタンプ] ' + p.title + ' (' + p.id + ')\n' + why.trim() });
      toast(tr('stamp_reported', '通報しました'));
    } catch (e) { toast(e.message); }
  }
  function openPack(id, focusKey) {
    const ov = overlay({ full: false, title: '' });
    ov.push('', sc => { const e = h('div', 'bstk-empty'); e.textContent = '…'; sc.appendChild(e); });
    loadPack(id).then(p => {
      if (!p) { ov.close(); toast(tr('stamp_not_found', 'スタンプが見つかりません')); return; }
      ov.replace(p.title, drawPackDetail(ov, p, focusKey));
    }).catch(e => { ov.close(); toast(e.message); });
    return ov;
  }
  // トークのスタンプをタップした時
  async function openInfo(key) {
    const id = baseId(key);
    if (id.startsWith('u:')) {
      const m = META.get(id.slice(2)) || await resolveMeta(id.slice(2));
      if (!m || !m.packId) { toast(tr('stamp_not_found', 'スタンプが見つかりません')); return; }
      openPack(m.packId, id);
      return;
    }
    const p = ART.packs.find(pk => pk.stickers.some(s => s.id === id));
    if (p) openPack(p.id, key);
  }

  // ---------------------------------------------------------------- ショップ(全部無料)
  function packRow(ov, p, onOpen) {
    const row = h('div', 'bstk-row');
    const cv = h('div', 'cv');
    if (p.builtin) cv.appendChild(art(p.items[0].key, 58));
    else if (p.cover) { const im = document.createElement('img'); im.src = p.cover; im.alt = ''; im.loading = 'lazy'; cv.appendChild(im); }
    const tx = h('div', 'tx');
    const t1 = h('div', 't1'); t1.textContent = p.title;
    const t2 = h('div', 't2'); t2.textContent = (p.author || '') + ' ・ ' + (p.count != null ? p.count : p.items.length) + tr('stamp_count_unit', '個') + (p.builtin ? ' ・ ' + tr('stamp_official', '公式') : '');
    tx.appendChild(t1); tx.appendChild(t2);
    const added = isAdded(p.id);
    const add = btn('bstk-add' + (added ? ' done' : ''), '', null, async e => {
      e.stopPropagation();
      if (isAdded(p.id)) { onOpen(); return; }
      add.disabled = true;
      try { await addPack(p.id); toast(tr('stamp_added', 'マイスタンプに追加しました')); haptic('success'); add.classList.add('done'); add.textContent = tr('stamp_added_btn', '追加済み'); }
      catch (er) { toast(er.message); }
      add.disabled = false;
    });
    add.textContent = added ? tr('stamp_added_btn', '追加済み') : tr('stamp_free', '無料');
    row.appendChild(cv); row.appendChild(tx); row.appendChild(add);
    row.addEventListener('click', onOpen);
    return row;
  }
  function openShop(opt) {
    opt = opt || {};
    const ov = overlay({ full: true, title: tr('stamp_shop', 'スタンプショップ') });
    let mode = 'new', q = opt.q || '', items = [], offset = 0, more = false, busy = false;
    const draw = sc => {
      ov.right.appendChild(btn('bstk-hb', ICON.gear, tr('stamp_settings', 'スタンプ設定'), () => openManager()));
      const ban = btn('bstk-banner', '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg><span><b>' + tr('stamp_make', 'スタンプを作る') + '</b><small>' + tr('stamp_make_sub', '写真・手書き・文字で、自分だけのスタンプ') + '</small></span>', null, () => openMaker());
      sc.appendChild(ban);
      const sr = h('div', 'bstk-sr');
      const inp = h('input', 'bstk-in'); inp.type = 'search'; inp.placeholder = tr('stamp_shop_ph', 'スタンプを探す'); inp.value = q;
      inp.setAttribute('enterkeyhint', 'search');
      sr.appendChild(inp); sc.appendChild(sr);
      const seg = h('div', 'bstk-seg');
      [['new', tr('stamp_new', '新着')], ['popular', tr('stamp_popular', '人気')], ['official', tr('stamp_official', '公式')]].forEach(([k, t]) => {
        const b = btn(k === mode ? 'on' : '', '', null, () => { mode = k; reload(); }); b.textContent = t; seg.appendChild(b);
      });
      sc.appendChild(seg);
      const list = h('div'); sc.appendChild(list);
      const moreBox = h('div'); sc.appendChild(moreBox);
      function render() {
        list.innerHTML = ''; moreBox.innerHTML = '';
        if (mode === 'official') {
          ART.packs.filter(p => !q || norm(p.title + p.desc + p.stickers.map(s => s.label + s.kw.join('')).join('')).includes(norm(q)))
            .forEach(bp => { const p = packOf(bp.id); list.appendChild(packRow(ov, p, () => ov.push(p.title, drawPackDetail(ov, p)))); });
          return;
        }
        if (busy && !items.length) { const e = h('div', 'bstk-empty'); e.textContent = '…'; list.appendChild(e); return; }
        if (!items.length) { const e = h('div', 'bstk-empty'); e.textContent = q ? tr('stamp_search_none', '見つかりませんでした') : tr('stamp_shop_empty', 'まだ誰もスタンプを公開していません。最初の1つを作ってみよう'); list.appendChild(e); return; }
        items.forEach(p => list.appendChild(packRow(ov, Object.assign({ items: [] }, p), async () => {
          try { const full = await loadPack(p.id); ov.push(full.title, drawPackDetail(ov, full)); } catch (e) { toast(e.message); }
        })));
        if (more) { const b = btn('bstk-btn2', '', null, () => load(true)); b.textContent = tr('stamp_more', 'もっと見る'); moreBox.style.textAlign = 'center'; moreBox.appendChild(b); }
      }
      async function load(append) {
        if (mode === 'official') { render(); return; }
        busy = true; if (!append) { items = []; offset = 0; } render();
        try {
          const j = await api('/api/stickers/shop?sort=' + mode + '&q=' + encodeURIComponent(q) + '&offset=' + offset);
          items = items.concat(j.packs || []); offset = items.length; more = !!j.hasMore;
        } catch (e) { toast(e.message); }
        busy = false; render();
      }
      function reload() { seg.querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', ['new', 'popular', 'official'][i] === mode)); load(false); }
      let qt = 0;
      inp.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(() => { q = inp.value.trim(); load(false); }, 300); });
      if (items.length && mode !== 'official') render(); else load(false);
    };
    ov.push(tr('stamp_shop', 'スタンプショップ'), draw);
    return ov;
  }

  // ---------------------------------------------------------------- マイスタンプ編集・設定
  function openManager() {
    const ov = overlay({ full: true, title: tr('stamp_my', 'マイスタンプ') });
    refresh().then(() => ov.redraw());
    const saveOrder = () => api('/api/stickers/mine', 'PUT', { order: ST.order, hidden: ST.hidden }).catch(e => toast(e.message));
    const draw = sc => {
      const sw = (title, sub, key) => {
        const row = h('div', 'bstk-sw');
        const t = h('div'); t.textContent = title; const s = h('small'); s.textContent = sub; t.appendChild(s);
        const tg = btn('bstk-tg' + (prefs[key] ? ' on' : ''), '', title, () => { prefs[key] = !prefs[key]; lsSet('bro_stk_prefs_v1', prefs); tg.classList.toggle('on', prefs[key]); tg.setAttribute('aria-checked', prefs[key] ? 'true' : 'false'); });
        tg.setAttribute('role', 'switch'); tg.setAttribute('aria-checked', prefs[key] ? 'true' : 'false');
        row.appendChild(t); row.appendChild(tg); sc.appendChild(row);
      };
      const h1 = h('div', 'bstk-h3'); h1.textContent = tr('stamp_settings', 'スタンプ設定'); sc.appendChild(h1);
      sw(tr('stamp_pref_preview', 'スタンプのプレビュー'), tr('stamp_pref_preview_sub', '送る前に大きく表示して、もう一度タップで送信'), 'preview');
      sw(tr('stamp_pref_suggest', 'スタンプのサジェスト'), tr('stamp_pref_suggest_sub', '入力した言葉に合うスタンプを表示'), 'suggest');
      sw(tr('stamp_pref_sound', 'サウンドスタンプの音'), tr('stamp_pref_sound_sub', 'タップした時などに音を鳴らす'), 'sound');

      const h2 = h('div', 'bstk-h3'); h2.textContent = tr('stamp_my', 'マイスタンプ') + ' (' + tr('stamp_my_sub', '並び替え・非表示') + ')'; sc.appendChild(h2);
      const ids = ST.order.filter(id => BUILTIN_IDS.includes(id) || ST.packs[id]);
      ids.forEach((id, i) => {
        const p = packOf(id); if (!p) return;
        const row = h('div', 'bstk-row'); row.style.cursor = 'default';
        const cv = h('div', 'cv'); cv.style.width = cv.style.height = '46px';
        if (p.items[0]) cv.appendChild(art(p.items[0].key, 46));
        const hid = ST.hidden.includes(id);
        if (hid) cv.style.opacity = '.35';
        const tx = h('div', 'tx'); const t1 = h('div', 't1'); t1.textContent = p.title; const t2 = h('div', 't2'); t2.textContent = hid ? tr('stamp_hidden', '非表示') : (p.items.length + tr('stamp_count_unit', '個'));
        tx.appendChild(t1); tx.appendChild(t2);
        tx.style.cursor = 'pointer'; tx.addEventListener('click', () => ov.push(p.title, drawPackDetail(ov, p)));
        const mv = (d) => { const j = i + d; if (j < 0 || j >= ids.length) return; const a = ids.slice(); [a[i], a[j]] = [a[j], a[i]]; ST.order = a.concat(ST.order.filter(x => !a.includes(x))); changed(); saveOrder(); ov.redraw(); };
        const up = btn('bstk-mini', ICON.up, tr('stamp_up', '上へ'), () => mv(-1)); up.disabled = i === 0;
        const dn = btn('bstk-mini', ICON.down, tr('stamp_down', '下へ'), () => mv(1)); dn.disabled = i === ids.length - 1;
        const vis = btn('bstk-mini', hid ? ICON.eyeOff : ICON.eye, tr('stamp_toggle_visible', '表示/非表示'), () => {
          ST.hidden = hid ? ST.hidden.filter(x => x !== id) : ST.hidden.concat(id); changed(); saveOrder(); ov.redraw();
        });
        row.appendChild(cv); row.appendChild(tx); row.appendChild(up); row.appendChild(dn); row.appendChild(vis);
        if (!p.builtin) row.appendChild(btn('bstk-mini', ICON.trash, tr('stamp_remove', '削除'), async () => {
          if (!confirm(tr('stamp_remove_confirm', 'マイスタンプから外しますか?(ショップからまた追加できます)'))) return;
          try { await removePack(id); ov.redraw(); } catch (e) { toast(e.message); }
        }));
        sc.appendChild(row);
      });
      const h3 = h('div', 'bstk-h3'); h3.textContent = tr('stamp_more_title', 'スタンプを増やす'); sc.appendChild(h3);
      const b1 = btn('bstk-big', '', null, () => openMaker()); b1.textContent = tr('stamp_make', 'スタンプを作る'); sc.appendChild(b1);
      const b2 = btn('bstk-big done', '', null, () => openShop()); b2.textContent = tr('stamp_shop', 'スタンプショップ'); b2.style.color = 'var(--fg)'; sc.appendChild(b2);
    };
    ov.push(tr('stamp_my', 'マイスタンプ'), draw);
    return ov;
  }

  // ---------------------------------------------------------------- スタンプを作る(stampMaker.js を必要な時だけ読む)
  let makerP = null;
  function openMaker(opt) {
    if (!makerP) {
      makerP = new Promise((res, rej) => {
        if (window.BroStampMaker) { res(); return; }
        const s = document.createElement('script');
        s.src = '/js/stampMaker.js';
        s.onload = () => res(); s.onerror = () => { makerP = null; rej(new Error('load')); };
        document.head.appendChild(s);
      });
    }
    makerP.then(() => window.BroStampMaker.open(Object.assign({ api, toast, css, h, btn, ICON, overlay, tr, putMeta, onSaved: () => refresh() }, opt || {})))
      .catch(() => toast(tr('stamp_load_failed', '読み込めませんでした。通信を確認してください')));
  }

  // ---------------------------------------------------------------- 入力欄に付ける(スタンプボタン + サジェスト)
  function attach(o) {
    css();
    const input = o.input;
    if (!input || input._bstk) return;
    input._bstk = true;
    refresh();
    const ib = btn('bstk bstk-ib', ICON.smile, tr('stamp_title', 'スタンプ'));
    const form = o.form || input.parentNode;
    form.insertBefore(ib, o.buttonBefore || input.nextSibling);
    let pk = null;
    const sendKey = key => { try { o.send(encode(key)); } catch (e) { console.error(e); } };
    function toggle() {
      if (pk && pk.isOpen()) { pk.close(); return; }
      if (o.beforeOpen) try { o.beforeOpen(); } catch (e) {}
      try { input.blur(); } catch (e) {}
      hideSg();
      ib.classList.add('on');
      pk = openPicker({ dock: o.dock, scroller: o.scroller, canSend: o.canSend, onPick: sendKey, onClose: () => ib.classList.remove('on') });
    }
    ib.addEventListener('click', e => { e.preventDefault(); toggle(); });
    // 文字を打ち始めたらスタンプ欄は閉じる(キーボードと入れ替わる)
    input.addEventListener('focus', () => { if (pk && pk.isOpen()) pk.close(); });

    // ---- サジェスト ----
    let sg = null, sgT = 0, sgFor = '';
    function hideSg() { if (sg) sg.classList.remove('on'); }
    function showSg(items, text) {
      if (!sg) { sg = h('div', 'bstk bstk-sg'); sg.setAttribute('role', 'listbox'); sg.setAttribute('aria-label', tr('stamp_suggest', 'スタンプのおすすめ')); document.body.appendChild(sg); }
      sg.innerHTML = '';
      items.forEach(it => {
        const b = btn('', '', it.label || label(it.key));
        b.appendChild(art(it.key, 62, { eager: true }));
        b.addEventListener('pointerdown', e => e.preventDefault()); // 入力欄からフォーカスを外さない
        b.addEventListener('click', () => {
          if (o.canSend && !o.canSend()) return;
          if (input.value.trim() !== text) return;
          hideSg();
          input.value = '';
          try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) {}
          pushRecent(it.key);
          const d = ART.def(baseId(it.key)); if (d && d.fx) runFx(d.fx);
          haptic('light');
          sendKey(it.key);
        });
        sg.appendChild(b);
      });
      const r = (o.dock || form).getBoundingClientRect();
      const w = Math.min(r.width, 62 * items.length + 4 * (items.length - 1) + 12);
      sg.style.left = Math.max(8, r.left) + 'px';
      sg.style.width = w + 'px';
      sg.style.maxWidth = (innerWidth - 16) + 'px';
      sg.style.bottom = (innerHeight - r.top + 6) + 'px';
      sg.classList.add('on');
    }
    input.addEventListener('input', () => {
      clearTimeout(sgT);
      sgT = setTimeout(() => {
        const text = input.value.trim();
        if (!prefs.suggest || !text || text === sgFor) { if (!text) { hideSg(); sgFor = ''; } return; }
        sgFor = text;
        const items = suggest(text);
        if (items.length) showSg(items, text); else hideSg();
      }, 160);
    });
    input.addEventListener('blur', () => setTimeout(hideSg, 150));
    return { open: toggle, close: () => pk && pk.close() };
  }

  // ---- 初回のお知らせ(この端末で1回だけ。版が上がったら新しい文面で1回) ----
  const SEEN_KEY = 'bro_seen_stamp_announce_v2';
  function announceOnce() {
    try { if (localStorage.getItem(SEEN_KEY)) return; } catch (e) {}
    if (document.getElementById('bro-stamp-ann')) return;
    try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) {}
    const ov = overlay({ title: tr('stamp_new_title', 'スタンプが新しくなりました') });
    ov.root.id = 'bro-stamp-ann';
    ov.push(tr('stamp_new_title', 'スタンプが新しくなりました'), sc => {
      const row = h('div'); row.style.cssText = 'display:flex;justify-content:center;gap:4px;margin:4px 0 10px';
      ['omedeto', 'usa_hi', 'iine'].forEach(k => { const e = el(k, 96, { noTap: true }); row.appendChild(e); setTimeout(() => play(e), 300); });
      sc.appendChild(row);
      const ul = h('div'); ul.style.cssText = 'font-size:14px;line-height:1.9;padding:0 6px';
      [tr('stamp_new_1', '動く・音が鳴る・画面いっぱいに飛び出すスタンプ'), tr('stamp_new_2', '好きな文字を入れられるメッセージスタンプ'), tr('stamp_new_3', '写真や手書きで自分のスタンプを作って公開'), tr('stamp_new_4', 'ショップ(全部無料)・お気に入り・履歴・検索・サジェスト')].forEach(t => { const d = h('div'); d.textContent = '・' + t; ul.appendChild(d); });
      sc.appendChild(ul);
      const ok = btn('bstk-big', '', null, () => ov.close()); ok.textContent = 'OK'; ok.style.marginTop = '14px'; sc.appendChild(ok);
    });
  }

  window.BroStamps = {
    announceOnce, list: () => allItems().map(i => i.key), encode, parse, label, previewText, el, openPicker, attach,
    openShop, openManager, openMaker, openPack, refresh, search, suggest, msgKey,
    svgMarkup: (id, px) => ART.svg(id, { px }),
  };
})();
