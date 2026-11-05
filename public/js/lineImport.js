// public/js/lineImport.js
// LINEの「トーク履歴を送信」で作った .txt を、このトークに読み込む。
// 読み込んだ文は端末の中(IndexedDB)にだけ置き、サーバーには送らない。相手にも届かない。
// LINEは写真・動画・スタンプの実物をこのファイルに入れないので、[写真] のような文字だけになる。
(function (g) {
  'use strict';
  const MAX_BYTES = 100 * 1024 * 1024, MAX_ITEMS = 500000;
  const MEDIA = /^\[(スタンプ|写真|動画|ボイスメッセージ|ファイル|連絡先|位置情報|アルバム|ノート|Sticker|Photo|Video|Voice message|File|Contact|Location|Album|Note|貼圖|照片|影片|語音訊息|檔案|이모티콘|사진|동영상|음성메시지|파일)\]$/;
  const TIME = /^(?:(午前|午後|AM|PM)\s*)?(\d{1,2}):(\d{2})(?:\s*(AM|PM))?$/i;

  function parseDate(line) {
    let m = /^(\d{4})[/.\-年](\d{1,2})[/.\-月](\d{1,2})日?(?:\s*[(（]?[^\t\d]*[)）]?)?$/.exec(line);
    if (m) return { y: +m[1], mo: +m[2], d: +m[3] };
    m = /^[A-Za-z]{3,9},?\s+(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(line);   // 英語版: Tue, 6/4/2019
    if (m) return { y: +m[3], mo: +m[1], d: +m[2] };
    return null;
  }
  function parseTime(s) {
    const m = TIME.exec(s.trim());
    if (!m) return null;
    let h = +m[2];
    const mi = +m[3], ap = (m[1] || m[4] || '').toUpperCase();
    if (h > 23 || mi > 59) return null;
    if ((ap === '午後' || ap === 'PM') && h < 12) h += 12;
    if ((ap === '午前' || ap === 'AM') && h === 12) h = 0;
    return { h, mi };
  }
  const TITLE = [
    /^\[LINE\]\s*(.+?)とのトーク履歴\s*$/, /^\[LINE\]\s*(.+?)のトーク履歴\s*$/,
    /^\[LINE\]\s*Chat history (?:with|in) (.+?)\s*$/i, /^\[LINE\]\s*與(.+?)的聊天記錄\s*$/, /^\[LINE\]\s*(.+?)(?:님과|와의|과의)\s*대화\s*$/,
  ];
  const SAVED = /^(保存日時|Saved on|儲存日期|저장한 날짜)\s*[:：]/i;

  // text -> { title, items: [{t, n, b, k}], names: {名前: 件数} } / LINEのファイルでなければ null
  function parse(text) {
    const lines = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    let title = '', cur = null, last = null, quoted = false, sawHeader = false;
    const items = [], names = {};
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (quoted) {
        // 複数行の文は "..." で囲まれている(文中の " は "" になる)
        // 行末の " でも、次の行が新しい文か日付でなければ本文の一部(引用符を含む文がありうる)
        const next = lines[i + 1];
        const nextStarts = next === undefined || !next.trim() || !!parseDate(next.trim()) || (next.includes('\t') && !!parseTime(next.split('\t')[0]));
        const end = /(^|[^"])"$/.test(line) && !/(^|[^"])""$/.test(line) && nextStarts;
        last.b += '\n' + (end ? line.slice(0, -1) : line).replace(/""/g, '"');
        if (end) quoted = false;
        continue;
      }
      if (!sawHeader && i < 5) {
        let hit = false;
        for (const re of TITLE) { const m = re.exec(line); if (m) { title = m[1]; hit = true; break; } }
        if (hit) { sawHeader = true; continue; }
      }
      if (SAVED.test(line)) continue;
      if (!line.trim()) { continue; }
      const date = parseDate(line.trim());
      if (date) { cur = date; last = null; continue; }
      const cols = line.split('\t');
      const tm = cols.length >= 2 ? parseTime(cols[0]) : null;
      let name = null, body = null, time = tm;
      if (tm) {
        if (cols.length >= 3) { name = cols[1]; body = cols.slice(2).join('\t'); }
        else { body = cols[1]; }   // 2列は「○○が参加しました」などのお知らせ
      } else {
        // タブが無い書き出し(古いiPhone版): 時刻 名前 本文
        const sp = /^(\S+)\s+(\S+)\s+([\s\S]*)$/.exec(line);
        const t2 = sp ? parseTime(sp[1]) : null;
        if (t2) { time = t2; name = sp[2]; body = sp[3]; }
      }
      if (!time) {
        // 形に合わない行は、前の文の続き(引用符なしの改行)
        if (last) last.b += '\n' + line;
        continue;
      }
      if (items.length >= MAX_ITEMS) break;
      if (body.startsWith('"') && !(body.length > 1 && body.endsWith('"') && !body.endsWith('""'))) {
        quoted = true;
        body = body.slice(1);
      } else if (body.length > 1 && body.startsWith('"') && body.endsWith('"')) {
        body = body.slice(1, -1);
      }
      body = body.replace(/""/g, '"');
      const t = cur ? new Date(cur.y, cur.mo - 1, cur.d, time.h, time.mi).getTime() : null;
      last = { t, n: name, b: body, k: name == null ? 'system' : (MEDIA.test(body.trim()) ? 'media' : 'text') };
      items.push(last);
      if (name != null) names[name] = (names[name] || 0) + 1;
    }
    if (!items.length || (!sawHeader && !items.some(x => x.t))) return null;
    return { title, items, names };
  }

  function decode(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {}
    try { return new TextDecoder('shift_jis').decode(buf); } catch (e) { return new TextDecoder().decode(buf); }
  }

  // --- 端末内の保存 ---
  const dbName = uid => 'bc_lineimport_' + uid;
  function openDb(uid) {
    return new Promise((res, rej) => {
      const r = indexedDB.open(dbName(uid), 1);
      r.onupgradeneeded = () => r.result.createObjectStore('talks');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function run(uid, mode, fn) {
    const d = await openDb(uid);
    return new Promise((res, rej) => {
      const t = d.transaction('talks', mode), req = fn(t.objectStore('talks'));
      t.oncomplete = () => { d.close(); res(req && req.result); };
      t.onerror = t.onabort = () => { d.close(); rej(t.error); };
    });
  }
  const load = (uid, peer) => run(uid, 'readonly', s => s.get(String(peer)));
  const save = (uid, peer, v) => run(uid, 'readwrite', s => s.put(v, String(peer)));
  const remove = (uid, peer) => run(uid, 'readwrite', s => s.delete(String(peer)));

  g.BroLineImport = { parse, decode, load, save, remove, MAX_BYTES };
  if (typeof document === 'undefined') return;

  // --- 画面 ---
  const T = (k, d) => (g.i18n && i18n.t ? i18n.t(k, d) : d);
  const pad = n => String(n).padStart(2, '0');
  const dayKey = t => { const d = new Date(t); return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()); };
  const clock = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const PAGE = 200;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;   // 取り込んだ文は必ず文字として入れる
    return e;
  }
  function injectStyle() {
    if (document.getElementById('lineImportCss')) return;
    const s = document.createElement('style');
    s.id = 'lineImportCss';
    s.textContent = `
#lineHist{display:block}
.li-pill{display:block;margin:10px auto;padding:9px 16px;border:0;border-radius:18px;font-size:13px;font-weight:700;cursor:pointer;color:#0f172a;background:rgba(255,255,255,.82);box-shadow:0 1px 4px rgba(15,23,42,.12);min-height:40px}
html.dark-mode .li-pill{color:#e2e8f0;background:rgba(30,41,59,.85)}
.li-note{text-align:center;font-size:12px;line-height:1.5;margin:6px 16px;opacity:.65}
.li-day{text-align:center;font-size:12px;font-weight:700;margin:12px 0 6px;opacity:.6}
.li-sys{text-align:center;font-size:12px;margin:6px 24px;opacity:.6;white-space:pre-wrap;overflow-wrap:anywhere}
.li-msg .bubble{white-space:pre-wrap;overflow-wrap:anywhere;-webkit-user-select:text;user-select:text}
.li-media .bubble{opacity:.65;font-style:italic}
.li-name{font-size:11px;font-weight:700;margin:0 0 2px 4px;opacity:.65}
.li-end{display:flex;align-items:center;gap:10px;font-size:12px;font-weight:700;opacity:.55;margin:14px 16px}
.li-end::before,.li-end::after{content:'';flex:1;height:1px;background:currentColor;opacity:.4}
@keyframes liIn{from{opacity:0;transform:translateY(-8px)}}
.li-in{animation:liIn .28s ease-out}
html.reduce-motion .li-in{animation:none}
@media (prefers-reduced-motion:reduce){.li-in{animation:none}}
.li-ov{position:fixed;inset:0;z-index:30000;background:rgba(15,23,42,.5);display:flex;align-items:flex-end;justify-content:center}
.li-sh{width:100%;max-width:480px;max-height:85vh;overflow:auto;box-sizing:border-box;padding:24px 20px calc(20px + env(safe-area-inset-bottom,0px));border-radius:26px 26px 0 0;color:#0f172a;background:#fff}
html.dark-mode .li-sh{color:#f1f5f9;background:#1e293b}
.li-sh h3{margin:0 0 8px;font-size:18px;font-weight:800}
.li-sh p{margin:0 0 12px;font-size:14px;line-height:1.6;opacity:.8}
.li-opt{display:block;width:100%;min-height:48px;margin:0 0 8px;padding:10px 14px;border:0;border-radius:14px;text-align:left;font-size:15px;font-weight:700;cursor:pointer;color:inherit;background:rgba(120,120,128,.14);overflow-wrap:anywhere}
.li-cancel{display:block;width:100%;min-height:44px;border:0;background:none;font-size:14px;cursor:pointer;color:inherit;opacity:.7}
`;
    document.head.appendChild(s);
  }

  // ctx: { uid, peerId, peerName, chat: 画面の要素 }
  function renderBlock(ctx, talk) {
    injectStyle();
    let box = document.getElementById('lineHist');
    if (!talk) { if (box) box.remove(); return; }
    if (!box) { box = el('div'); box.id = 'lineHist'; }
    ctx.chat.insertBefore(box, ctx.chat.firstChild);
    box.textContent = '';
    let shown = 0;
    const list = el('div');
    const more = el('button', 'li-pill');
    more.type = 'button';
    const label = () => {
      const left = talk.items.length - shown;
      more.textContent = shown
        ? T('li_more', 'さらに前を見る({n}件)').replace('{n}', left.toLocaleString())
        : T('li_show', 'LINEの履歴を見る({n}件)').replace('{n}', talk.items.length.toLocaleString());
    };
    more.addEventListener('click', () => {
      const end = talk.items.length - shown, start = Math.max(0, end - PAGE);
      const prevH = ctx.chat.scrollHeight, prevTop = ctx.chat.scrollTop;
      list.insertBefore(renderRange(talk, start, end, !shown), list.firstChild);
      shown = talk.items.length - start;
      if (start === 0) more.remove(); else label();
      ctx.chat.scrollTop = prevTop + (ctx.chat.scrollHeight - prevH);
    });
    label();
    box.append(more, list);
  }
  function renderRange(talk, start, end, withEnd) {
    const f = document.createDocumentFragment();
    let day = start > 0 && talk.items[start - 1].t ? dayKey(talk.items[start - 1].t) : '';
    const others = Object.keys(talk.names || {}).filter(n => n !== talk.myName);
    for (let i = start; i < end; i++) {
      const it = talk.items[i];
      if (it.t) { const k = dayKey(it.t); if (k !== day) { f.appendChild(el('div', 'li-day', k)); day = k; } }
      if (it.k === 'system' || it.n == null) { f.appendChild(el('div', 'li-sys', it.b)); continue; }
      const mine = it.n === talk.myName;
      const row = el('div', 'message li-msg li-in ' + (mine ? 'outgoing' : 'incoming') + (it.k === 'media' ? ' li-media' : ''));
      const wrap = el('div', 'msg-wrap');
      if (!mine && others.length > 1) wrap.appendChild(el('div', 'li-name', it.n));
      const bub = el('div', 'bubble');
      bub.appendChild(el('span', 'msg-text', it.b));
      if (it.t) { const meta = el('div', 'msg-meta'); meta.appendChild(el('span', '', clock(it.t))); bub.appendChild(meta); }
      wrap.appendChild(bub);
      row.appendChild(wrap);
      f.appendChild(row);
    }
    if (withEnd) f.appendChild(el('div', 'li-end', T('li_end', 'ここまでLINEの履歴')));
    return f;
  }
  function sheet(build) {
    injectStyle();
    const ov = el('div', 'li-ov');
    const sh = el('div', 'li-sh');
    sh.setAttribute('role', 'dialog'); sh.setAttribute('aria-modal', 'true');
    const close = () => ov.remove();
    build(sh, close);
    ov.appendChild(sh);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    document.body.appendChild(ov);
  }
  function pickFile(ctx) {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.txt,text/plain';
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if (!f) return;
      if (f.size > MAX_BYTES) { alert(T('li_too_big', 'ファイルが大きすぎます')); return; }
      let talk;
      try { talk = parse(decode(new Uint8Array(await f.arrayBuffer()))); } catch (e) { talk = null; }
      if (!talk) { alert(T('li_bad_file', 'LINEのトーク履歴のファイルではないようです')); return; }
      confirmSelf(ctx, talk);
    });
    input.click();
  }
  // LINEの名前のどれが自分かは、ファイルからは分からないので選んでもらう
  function confirmSelf(ctx, talk) {
    const names = Object.keys(talk.names).sort((a, b) => talk.names[b] - talk.names[a]);
    sheet((sh, close) => {
      sh.appendChild(el('h3', '', T('li_who_title', 'LINEでのあなたの名前は?')));
      sh.appendChild(el('p', '', T('li_who_desc', '{n}件を {name} さんとのトークに読み込みます。この端末の中にだけ保存され、サーバーにも相手にも送られません。写真やスタンプは文字だけになります。').replace('{n}', talk.items.length.toLocaleString()).replace('{name}', ctx.peerName)));
      names.forEach(n => {
        const b = el('button', 'li-opt', n + ' (' + talk.names[n].toLocaleString() + ')');
        b.type = 'button';
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const v = { title: talk.title, myName: n, names: talk.names, items: talk.items, importedAt: Date.now() };
            await save(ctx.uid, ctx.peerId, v);
            close();
            renderBlock(ctx, v);
            ctx.chat.scrollTop = 0;
          } catch (e) { b.disabled = false; alert(T('li_save_failed', '保存できませんでした。端末の空き容量を確かめてください')); }
        });
        sh.appendChild(b);
      });
      const c = el('button', 'li-cancel', T('close', '閉じる'));
      c.type = 'button'; c.addEventListener('click', close);
      sh.appendChild(c);
    });
  }
  function confirmRemove(ctx) {
    sheet((sh, close) => {
      sh.appendChild(el('h3', '', T('li_del_title', '読み込んだLINEの履歴を消しますか?')));
      sh.appendChild(el('p', '', T('li_del_desc', 'この端末の中から消えます。LINE本体のトークは消えません。')));
      const d = el('button', 'li-opt', T('li_del_btn', '消す'));
      d.type = 'button';
      d.addEventListener('click', async () => { await remove(ctx.uid, ctx.peerId); close(); renderBlock(ctx, null); });
      sh.appendChild(d);
      const c = el('button', 'li-cancel', T('close', '閉じる'));
      c.type = 'button'; c.addEventListener('click', close);
      sh.appendChild(c);
    });
  }
  async function mount(ctx) {
    try { renderBlock(ctx, await load(ctx.uid, ctx.peerId)); } catch (e) {}
  }
  g.BroLineImport.mount = mount;
  g.BroLineImport.pickFile = pickFile;
  g.BroLineImport.confirmRemove = confirmRemove;
  g.BroLineImport.has = async ctx => { try { return !!(await load(ctx.uid, ctx.peerId)); } catch (e) { return false; } };
})(typeof window !== 'undefined' ? window : globalThis);
