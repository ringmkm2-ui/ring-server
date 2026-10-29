// outbox.js
// 電波が悪くて送れなかったテキストを端末に取っておき、つながったら順番どおりに自動で再送する。
// 対象はネットワーク失敗だけ(暗号化エラー・ブロック・権限エラーなどは再送しても直らないので入れない)。
//
// ---- ページへの組み込み ----
// 1) ページを開いた時に、そのトーク用の送信関数を登録する(chatKey は 'u_'+相手ID / 'g_'+グループID など):
//      BroOutbox.register('u_' + otherId, async (item) => {
//        // item = { key, chatKey, text, tempId, replyTo, meta, ts }。いつもの送信と同じAPIを叩いて、サーバーのメッセージを返す。
//        // item.key(冪等キー)をリクエストに付けられるなら付ける(二重送信の保険)。
//        const r = await fetch('/api/messages/send', {...});
//        if (!r.ok) { const e = new Error('http ' + r.status); e.status = r.status; throw e; }   // ← status を付けて投げる
//        return (await r.json()).message;
//      }, {
//        onSent: (item, serverMsg) => { /* 仮表示(item.tempId)を本物に差し替える */ },
//        onFailedPermanently: (item, reason) => { /* 「送信できませんでした」表示に変える。reason: 'rejected'|'expired' */ }
//      });
// 2) 送信が「ネットワークエラーで」失敗した時だけ、いつもの失敗表示の代わりに:
//      if (BroOutbox.add('u_' + otherId, { text, tempId, replyTo })) { /* 「送信待ち...」表示にする */ }
//      else { /* false = 設定で自動再送オフ/満杯/期限切れ。従来どおりの「失敗」表示 */ }
// 3) 回線が戻ったとわかる場所(送信成功時、WebSocket再接続時など)で BroOutbox.kick() を呼ぶと即再送を試す。
//    ('online' イベントと画面が前に戻った時は自動で試す)
//
// 再送の挙動: トークごとに先頭の1件だけ送る(順番を守る)/ 全体で同時に最大3トーク / 失敗したら 2,4,8...最大60秒の間隔で再試行 /
//   24時間より古いものと51件目以降は捨てる / 同じ(text+tempId)は二重に積まない。
//   エラーの扱い: e.permanent===true か、e.status が 400〜499(408・429以外)なら「もう送れない」として捨てて onFailedPermanently。
//   それ以外(status無し=ネットワーク、5xx、408、429)は再試行。
// 設定 autoResend(既定 true)が false なら add() は何もせず false を返す。
(function () {
  if (window.BroOutbox) return;

  const KEY = 'bro_outbox_v1';
  const cfg = { base: 2000, max: 60000, inflight: 3, maxItems: 50, ttl: 24 * 3600 * 1000, lockMs: 30000 };
  const TAB = Math.random().toString(36).slice(2);

  const reg = new Map();        // chatKey -> {send, onSent, onFailedPermanently}
  const st = new Map();         // chatKey -> {fails, timer, busy}
  let running = 0;

  function enabled() {
    try {
      const s = window.BroSettings || window.bcSettings;
      const v = s && s.get ? s.get('autoResend') : undefined;
      return v === undefined || v === null ? true : !!v;
    } catch (e) { return true; }
  }

  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(KEY));
      return o && o.v === 1 && Array.isArray(o.items) ? o.items.filter(i => i && typeof i.chatKey === 'string' && typeof i.key === 'string') : [];
    } catch (e) { return []; }
  }
  function save(items) { try { localStorage.setItem(KEY, JSON.stringify({ v: 1, items })); return true; } catch (e) { return false; } }

  function keyOf(text, tempId) {
    // 軽い文字列ハッシュ(32bit x2)。サーバーに渡す冪等キーとして十分な長さ
    const s = String(text) + '\u0000' + String(tempId == null ? '' : tempId);
    let a = 0x811c9dc5, b = 0x1b873593;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b + c, 2246822519) ^ (b >>> 13); }
    return 'ob_' + (a >>> 0).toString(36) + (b >>> 0).toString(36) + '_' + s.length;
  }

  function sweep(items) {
    const now = Date.now();
    const keep = [], dead = [];
    for (const i of items) (now - (i.ts || 0) > cfg.ttl ? dead : keep).push(i);
    if (dead.length) {
      save(keep);
      dead.forEach(i => fire(i.chatKey, 'onFailedPermanently', i, 'expired'));
    }
    return keep;
  }

  function fire(chatKey, name, a, b) {
    const r = reg.get(chatKey);
    try { r && r[name] && r[name](a, b); } catch (e) { console.error('[outbox] ' + name, e); }
  }

  function add(chatKey, o) {
    if (!enabled() || !chatKey || !o || typeof o.text !== 'string' || !o.text) return false;
    const items = sweep(load());
    const key = keyOf(o.text, o.tempId);
    if (items.some(i => i.key === key && i.chatKey === chatKey)) return true;    // もう積んである
    if (items.length >= cfg.maxItems) return false;
    items.push({ key, chatKey, text: o.text, tempId: o.tempId == null ? null : o.tempId, replyTo: o.replyTo == null ? null : o.replyTo, meta: o.meta == null ? null : o.meta, ts: Date.now() });
    if (!save(items)) return false;
    schedule(chatKey, 0);
    return true;
  }

  function remove(chatKey, tempId) {
    const items = load();
    const n = items.filter(i => !(i.chatKey === chatKey && i.tempId === tempId));
    if (n.length !== items.length) save(n);
    return n.length !== items.length;
  }
  function pending(chatKey) { return load().filter(i => !chatKey || i.chatKey === chatKey); }

  function state(ck) { let s = st.get(ck); if (!s) { s = { fails: 0, timer: 0, busy: false }; st.set(ck, s); } return s; }

  function schedule(ck, delay) {
    const s = state(ck);
    clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = 0; flush(ck); }, delay);
  }

  function permanent(e) {
    if (!e) return false;
    if (e.permanent === true) return true;
    const c = +e.status;
    return c >= 400 && c < 500 && c !== 408 && c !== 429;
  }

  // 別タブが同じ項目を送っている最中ならスキップ(localStorage を共有しているため)
  function claim(item) {
    const items = load();
    const cur = items.find(i => i.key === item.key && i.chatKey === item.chatKey);
    if (!cur) return false;                                    // もう無い(送信済み/削除済み)
    if (cur.lock && cur.lock.tab !== TAB && Date.now() - cur.lock.at < cfg.lockMs) return false;
    cur.lock = { tab: TAB, at: Date.now() };
    save(items);
    return true;
  }
  function finish(item, ok) {
    const items = load();
    const idx = items.findIndex(i => i.key === item.key && i.chatKey === item.chatKey);
    if (idx < 0) return;
    if (ok) items.splice(idx, 1); else delete items[idx].lock;
    save(items);
  }

  async function flush(ck) {
    const s = state(ck), r = reg.get(ck);
    if (!r || s.busy || !enabled()) return;
    if (running >= cfg.inflight) { schedule(ck, 300); return; }     // 同時数の上限: 少し待つ
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;   // 'online' で再開する
    const items = sweep(load()).filter(i => i.chatKey === ck);       // 保存順 = 送信順
    const head = items[0];
    if (!head) { s.fails = 0; return; }
    if (!claim(head)) { schedule(ck, 5000); return; }
    s.busy = true; running++;
    let ok = false, perm = false, msg = null;
    try {
      msg = await r.send(head);
      ok = true;
    } catch (e) { perm = permanent(e); }
    s.busy = false; running--;
    if (ok) {
      finish(head, true);
      s.fails = 0;
      fire(ck, 'onSent', head, msg);
      schedule(ck, 0);                       // 次の1件へ
    } else if (perm) {
      finish(head, true);                     // もう送れないので捨てる(順番待ちを詰まらせない)
      s.fails = 0;
      fire(ck, 'onFailedPermanently', head, 'rejected');
      schedule(ck, 0);
    } else {
      finish(head, false);
      s.fails++;
      schedule(ck, Math.min(cfg.max, cfg.base * Math.pow(2, s.fails - 1)));
    }
  }

  // 登録されているトーク全部を、今すぐ試す(待ち時間の途中でも)
  function kick(ck) {
    if (!enabled()) return;
    const list = ck ? [ck] : Array.from(reg.keys());
    list.forEach(k => { if (reg.has(k) && !state(k).busy) schedule(k, 0); });
  }

  function register(ck, send, hooks) {
    if (!ck || typeof send !== 'function') return;
    reg.set(ck, { send, onSent: hooks && hooks.onSent, onFailedPermanently: hooks && hooks.onFailedPermanently });
    if (load().some(i => i.chatKey === ck)) schedule(ck, 500);       // 前回の残りがあれば開いてすぐ再送
  }
  function unregister(ck) { reg.delete(ck); const s = st.get(ck); if (s) clearTimeout(s.timer); st.delete(ck); }

  window.addEventListener('online', () => kick());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') kick(); });

  window.BroOutbox = {
    register, unregister, add, remove, pending, flush, kick,
    count: () => load().length,
    configure(o) { for (const k in o) if (k in cfg) cfg[k] = o[k]; },     // テスト用(待ち時間を縮める等)
    _keyOf: keyOf,
  };
})();
