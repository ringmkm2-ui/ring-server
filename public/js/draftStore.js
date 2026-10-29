// draftStore.js
// 入力途中の文章(下書き)をトークごとに端末へ残す。別のトークへ移ったりアプリを閉じても、戻ると続きから書ける。
// 保存先は localStorage の 'bro_draft_<key>'(最大20件、古い順に消す = LRU)。端末内だけで、サーバーには送らない。
// 設定 saveDrafts(BroSettings / bcSettings。既定 true)が false の時は読み書きを一切せず、残っている下書きも消す。
//
// 使い方(1:1は 'u_' + 相手ID、グループは 'g_' + グループID のように、トークごとに違う文字列を key にする):
//   const d = BroDrafts.attach(textarea, 'u_' + otherId);   // 開いた時: 下書きがあれば textarea.value に復元 / 入力のたびに保存(400ms まとめ書き)
//   ...送信に成功したら:  BroDrafts.clear('u_' + otherId);   // textarea.value = '' だけでは消えない(inputイベントが出ないため)
//   ...画面を離れる時:    d.detach();                        // 任意
// 復元時は textarea に 'bro:draftrestored' イベントを出す(高さの自動調整用。'input' は出さない = 「入力中...」を相手に送らないため)。
(function () {
  if (window.BroDrafts) return;

  const PREFIX = 'bro_draft_';
  const MAX = 20;
  const DELAY = 400;

  function enabled() {
    try {
      const s = window.BroSettings || window.bcSettings;
      const v = s && s.get ? s.get('saveDrafts') : undefined;
      return v === undefined || v === null ? true : !!v;
    } catch (e) { return true; }
  }
  const ls = () => { try { return window.localStorage; } catch (e) { return null; } };

  function keys() {
    const s = ls(), out = [];
    if (!s) return out;
    try { for (let i = 0; i < s.length; i++) { const k = s.key(i); if (k && k.indexOf(PREFIX) === 0) out.push(k); } } catch (e) {}
    return out;
  }
  function purgeAll() { const s = ls(); if (!s) return; keys().forEach(k => { try { s.removeItem(k); } catch (e) {} }); }
  function read(full) {
    try { const o = JSON.parse(ls().getItem(full)); return o && typeof o.t === 'string' ? o : null; } catch (e) { return null; }
  }
  function write(full, text) {
    const s = ls(); if (!s) return;
    const val = JSON.stringify({ t: text, ts: Date.now() });
    try { s.setItem(full, val); }
    catch (e) { evict(1, full); try { s.setItem(full, val); } catch (e2) {} }   // 容量がいっぱいなら古いものを消してもう一度
    evict(0, full);
  }
  // 20件を超えたら、最後に使った時刻が古いものから消す(今書いたものは残す)
  function evict(extra, keep) {
    const all = keys().filter(k => k !== keep);
    const over = all.length + 1 - MAX + (extra || 0);
    if (over <= 0) return;
    all.map(k => ({ k, ts: (read(k) || { ts: 0 }).ts })).sort((a, b) => a.ts - b.ts).slice(0, over)
      .forEach(o => { try { ls().removeItem(o.k); } catch (e) {} });
  }

  const timers = new Map();      // key -> {id, text}
  function flushKey(key) {
    const p = timers.get(key);
    if (!p) return;
    clearTimeout(p.id); timers.delete(key);
    if (!enabled()) return;
    if (p.text) write(PREFIX + key, p.text); else { try { ls() && ls().removeItem(PREFIX + key); } catch (e) {} }
  }
  function flushAll() { Array.from(timers.keys()).forEach(flushKey); }

  function get(key) {
    if (!key) return '';
    if (!enabled()) { purgeAll(); return ''; }
    const o = read(PREFIX + key);
    if (!o) return '';
    if (Date.now() - o.ts > 60000) { try { ls().setItem(PREFIX + key, JSON.stringify({ t: o.t, ts: Date.now() })); } catch (e) {} }   // 使った印(LRU)
    return o.t;
  }

  function set(key, text) {
    if (!key) return;
    if (!enabled()) { purgeAll(); return; }
    text = text == null ? '' : String(text);
    const prev = timers.get(key);
    if (prev) clearTimeout(prev.id);
    const id = setTimeout(() => flushKey(key), DELAY);
    timers.set(key, { id, text: text.trim() ? text : '' });
  }

  function clear(key) {
    if (!key) return;
    const p = timers.get(key);
    if (p) { clearTimeout(p.id); timers.delete(key); }   // 待っている書き込みが送信後に復活しないように
    try { ls() && ls().removeItem(PREFIX + key); } catch (e) {}
  }

  function attach(ta, key) {
    if (!ta || !key) return { detach() {}, clear() {} };
    if (ta._broDraft) ta._broDraft.detach();
    if (enabled() && !ta.value) {
      const d = get(key);
      if (d) {
        ta.value = d;
        try { ta.dispatchEvent(new CustomEvent('bro:draftrestored', { bubbles: true })); } catch (e) {}
      }
    } else if (!enabled()) purgeAll();
    const onInput = () => set(key, ta.value);
    ta.addEventListener('input', onInput);
    const handle = {
      detach() { ta.removeEventListener('input', onInput); flushKey(key); if (ta._broDraft === handle) ta._broDraft = null; },
      clear() { clear(key); },
    };
    ta._broDraft = handle;
    return handle;
  }

  // タブを閉じる/アプリが裏に回る時に、まだ書いていない分を確定させる
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
  window.addEventListener('pagehide', flushAll);
  if (!enabled()) purgeAll();

  window.BroDrafts = { get, set, clear, attach, flush: flushAll, _count: () => keys().length };
})();
