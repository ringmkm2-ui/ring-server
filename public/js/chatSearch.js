// chatSearch.js
// トーク内検索。画面いっぱいのオーバーレイが下からバネで上がってきて、入力すると該当メッセージが一覧に出る。
// 全角/半角・大文字小文字・ひらがな/カタカナの違いは無視して一致させる(NFKC + カタカナ→ひらがな)。
// 一致した部分は <mark> で強調(DOM を textContent で組み立てるので、メッセージ本文に何が入っていても HTML としては解釈されない)。
//
// 使い方(admin.html / groupchat.html 共通。復号済みの平文だけを渡す):
//   BroChatSearch.open({
//     getMessages: () => realMessages.map(m => ({ id: m.id, text: plain(m), mine: m.senderId === me, senderName: nm, time: m.createdAt })),
//     onJump: (id) => scrollToMessage(id),   // 一覧をタップ → オーバーレイを閉じてから呼ばれる
//     title: '検索'                           // 省略可
//   });
//   戻り値 { close() }。Esc / 閉じるボタンでも閉じる。
// 5000件でも固まらないよう、正規化結果はメッセージごとにキャッシュし、描画は100件ずつ(「もっと見る」)。
(function () {
  if (window.BroChatSearch) return;

  const tr = (k, fb) => { try { return (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } };
  const reduced = () => document.documentElement.classList.contains('reduce-motion') ||
    (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  const PAGE = 100;

  // ---- 正規化 ----
  // 半角カナ+濁点(ｶﾞ)のように「複数文字で1文字」になるものがあるので、結合記号まで含めた塊ごとに NFKC をかけ、
  // 正規化後の各文字が元文字列のどこに当たるかも持つ(強調表示のため)。
  const CLUSTER = /[\s\S][゙゚ﾞﾟ̀-ͯ]*/g;
  const ASCII = /^[\x00-\x7f]*$/;
  function kata2hira(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      out += (c >= 0x30a1 && c <= 0x30f6) ? String.fromCharCode(c - 0x60) : s[i];
    }
    return out;
  }
  function normChunk(chunk) {
    let n = chunk;
    try { n = chunk.normalize('NFKC'); } catch (e) {}
    return kata2hira(n.toLowerCase());
  }
  function norm(s) {
    s = String(s == null ? '' : s);
    if (ASCII.test(s)) return s.toLowerCase();
    return s.replace(CLUSTER, normChunk);
  }
  // 正規化後 index -> 元 index の対応表(starts[i], ends[i])
  function normWithMap(s) {
    s = String(s == null ? '' : s);
    let out = '';
    const starts = [], ends = [];
    CLUSTER.lastIndex = 0;
    let m;
    while ((m = CLUSTER.exec(s))) {
      const n = normChunk(m[0]);
      for (let k = 0; k < n.length; k++) { starts.push(m.index); ends.push(m.index + m[0].length); }
      out += n;
    }
    return { norm: out, starts, ends };
  }

  // ---- 見た目 ----
  function css() {
    if (document.getElementById('bro-cs-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-cs-css';
    s.textContent =
      '.bcs{--bg:#fff;--fg:#0f172a;--sub:#64748b;--line:rgba(15,23,42,.1);--fld:#eef1f5;--mk:rgba(255,204,0,.5);position:fixed;inset:0;z-index:20500;background:var(--bg);color:var(--fg);display:flex;flex-direction:column;opacity:0;transform:translate3d(0,40px,0);will-change:transform,opacity;font-family:inherit;-webkit-tap-highlight-color:transparent;overscroll-behavior:contain}' +
      'html.dark-mode .bcs{--bg:#0f172a;--fg:#e2e8f0;--sub:#94a3b8;--line:rgba(255,255,255,.1);--fld:#1e293b;--mk:rgba(250,204,21,.38)}' +
      // バネっぽい動き(少し行き過ぎて戻る)。transform と opacity だけ
      '.bcs.on{opacity:1;transform:none;transition:transform .5s cubic-bezier(.2,1.1,.3,1),opacity .2s ease}' +
      '.bcs.out{opacity:0;transform:translate3d(0,40px,0);transition:transform .22s ease-in,opacity .2s ease}' +
      'html.reduce-motion .bcs.on,html.reduce-motion .bcs.out{transition:opacity .01s}' +
      '@media (prefers-reduced-motion:reduce){.bcs.on,.bcs.out{transition:opacity .01s}}' +
      '.bcs-top{display:flex;align-items:center;gap:8px;padding:calc(10px + env(safe-area-inset-top,0px)) 12px 10px;border-bottom:1px solid var(--line)}' +
      '.bcs-fld{flex:1;min-width:0;display:flex;align-items:center;gap:8px;background:var(--fld);border-radius:12px;padding:0 10px;min-height:44px}' +
      '.bcs-fld svg{flex:none;opacity:.55}' +
      '.bcs-in{flex:1;min-width:0;border:0;outline:0;background:transparent;color:inherit;font:inherit;font-size:16px;min-height:44px;padding:0}' +
      '.bcs-x{flex:none;min-width:44px;min-height:44px;display:flex;align-items:center;justify-content:center;border:0;background:transparent;color:#007aff;font:inherit;font-size:15px;font-weight:600;cursor:pointer;padding:0 4px}' +
      '.bcs-meta{padding:8px 16px;font-size:12px;color:var(--sub);min-height:20px}' +
      '.bcs-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding-bottom:calc(16px + env(safe-area-inset-bottom,0px))}' +
      '.bcs-row{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid var(--line);background:transparent;color:inherit;font:inherit;padding:12px 16px;min-height:44px;cursor:pointer;content-visibility:auto;contain-intrinsic-size:auto 72px}' +
      '.bcs-row:active{background:var(--fld)}' +
      '.bcs-h{display:flex;justify-content:space-between;gap:12px;font-size:12px;color:var(--sub);margin-bottom:4px}' +
      '.bcs-h b{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.bcs-h span{flex:none;font-variant-numeric:tabular-nums}' +
      '.bcs-t{font-size:15px;line-height:1.45;white-space:pre-line;overflow-wrap:anywhere;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}' +
      '.bcs-t mark{background:var(--mk);color:inherit;border-radius:3px;padding:0 1px}' +
      '.bcs-more{display:block;margin:12px auto;min-height:44px;padding:0 20px;border:1px solid var(--line);border-radius:22px;background:transparent;color:#007aff;font:inherit;font-size:14px;font-weight:600;cursor:pointer}' +
      '.bcs-empty{padding:48px 24px;text-align:center;color:var(--sub);font-size:14px;line-height:1.6}';
    document.head.appendChild(s);
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';
  function searchIcon() {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('width', '18'); s.setAttribute('height', '18'); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.2'); s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('aria-hidden', 'true');
    const c = document.createElementNS(SVG_NS, 'circle'); c.setAttribute('cx', '11'); c.setAttribute('cy', '11'); c.setAttribute('r', '7');
    const l = document.createElementNS(SVG_NS, 'line'); l.setAttribute('x1', '21'); l.setAttribute('y1', '21'); l.setAttribute('x2', '16.65'); l.setAttribute('y2', '16.65');
    s.appendChild(c); s.appendChild(l);
    return s;
  }

  function fmtTime(iso) {
    const t = Date.parse(iso);
    if (!isFinite(t)) return '';
    const d = new Date(t), now = new Date();
    const p = n => (n < 10 ? '0' : '') + n;
    const hm = p(d.getHours()) + ':' + p(d.getMinutes());
    if (d.getFullYear() !== now.getFullYear()) return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hm;
  }

  let cur = null;

  function open(opts) {
    opts = opts || {};
    if (cur) cur.close(true);
    css();
    const prevFocus = document.activeElement;

    const ov = document.createElement('div');
    ov.className = 'bcs';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-modal', 'true');
    ov.setAttribute('aria-label', opts.title || tr('bro_search_title', 'トーク内検索'));

    const top = document.createElement('div'); top.className = 'bcs-top';
    const fld = document.createElement('div'); fld.className = 'bcs-fld';
    fld.appendChild(searchIcon());
    const input = document.createElement('input');
    input.className = 'bcs-in'; input.type = 'search'; input.autocomplete = 'off';
    input.setAttribute('enterkeyhint', 'search');
    input.placeholder = opts.title || tr('bro_search_ph', 'メッセージを検索');
    fld.appendChild(input);
    const x = document.createElement('button');
    x.type = 'button'; x.className = 'bcs-x'; x.textContent = tr('bro_cancel', 'キャンセル');
    top.appendChild(fld); top.appendChild(x);
    const meta = document.createElement('div'); meta.className = 'bcs-meta'; meta.setAttribute('aria-live', 'polite');
    const list = document.createElement('div'); list.className = 'bcs-list';
    ov.appendChild(top); ov.appendChild(meta); ov.appendChild(list);

    // ---- データ ----
    let all = [];
    try { all = (opts.getMessages && opts.getMessages()) || []; } catch (e) { all = []; }
    const cache = new Map();            // id -> {text, n}  本文が変わらない限り正規化し直さない
    const getN = m => {
      const text = m.text == null ? '' : String(m.text);
      let c = cache.get(m.id);
      if (!c || c.text !== text) { c = { text, n: norm(text) }; cache.set(m.id, c); }
      return c.n;
    };

    let hits = [], shown = 0, q = '', qn = '', timer = 0, closed = false;

    function renderHit(m) {
      const text = m.text == null ? '' : String(m.text);
      const wm = normWithMap(text);
      // 一致範囲(正規化後)を全部拾って元の文字位置に直す
      const ranges = [];
      for (let p = wm.norm.indexOf(qn); p >= 0 && ranges.length < 20; p = wm.norm.indexOf(qn, p + qn.length)) {
        ranges.push([wm.starts[p], wm.ends[p + qn.length - 1]]);
      }
      // 長い本文は最初の一致の前後だけ切り出す
      const first = ranges.length ? ranges[0][0] : 0;
      const from = Math.max(0, first - 28);
      const to = Math.min(text.length, from + 140 + qn.length);
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'bcs-row';
      const h = document.createElement('div'); h.className = 'bcs-h';
      const nm = document.createElement('b');
      nm.textContent = m.mine ? tr('bro_search_me', '自分') : (m.senderName || '');
      const tm = document.createElement('span'); tm.textContent = fmtTime(m.time);
      h.appendChild(nm); h.appendChild(tm);
      const body = document.createElement('div'); body.className = 'bcs-t';
      if (from > 0) body.appendChild(document.createTextNode('…'));
      let pos = from;
      for (const r of ranges) {
        if (r[1] <= pos || r[0] >= to) continue;
        const s0 = Math.max(r[0], pos), e0 = Math.min(r[1], to);
        if (s0 > pos) body.appendChild(document.createTextNode(text.slice(pos, s0)));
        const mk = document.createElement('mark'); mk.textContent = text.slice(s0, e0);
        body.appendChild(mk);
        pos = e0;
      }
      if (pos < to) body.appendChild(document.createTextNode(text.slice(pos, to)));
      if (to < text.length) body.appendChild(document.createTextNode('…'));
      row.appendChild(h); row.appendChild(body);
      row.addEventListener('click', () => { const id = m.id; close(); try { opts.onJump && opts.onJump(id); } catch (e) { console.error('[chatSearch] onJump', e); } });
      return row;
    }

    function renderMore(btn) {
      const frag = document.createDocumentFragment();
      const end = Math.min(hits.length, shown + PAGE);
      for (let i = shown; i < end; i++) frag.appendChild(renderHit(hits[i]));
      shown = end;
      if (btn) btn.remove();
      list.appendChild(frag);
      if (shown < hits.length) {
        const more = document.createElement('button');
        more.type = 'button'; more.className = 'bcs-more';
        more.textContent = tr('bro_search_more', 'もっと見る') + '(' + (hits.length - shown) + ')';
        more.addEventListener('click', () => renderMore(more));
        list.appendChild(more);
      }
    }

    function emptyMsg(text) {
      list.textContent = '';
      const d = document.createElement('div'); d.className = 'bcs-empty'; d.textContent = text;
      list.appendChild(d);
    }

    function run() {
      timer = 0;
      if (closed) return;
      q = input.value.trim();
      qn = norm(q);
      list.textContent = ''; list.scrollTop = 0; hits = []; shown = 0;
      if (!qn) { meta.textContent = ''; emptyMsg(tr('bro_search_hint', 'キーワードを入力してください')); return; }
      try { all = (opts.getMessages && opts.getMessages()) || all; } catch (e) {}
      const idx = [];
      for (let i = 0; i < all.length; i++) {
        const m = all[i];
        if (!m || m.text == null || m.text === '') continue;
        if (getN(m).indexOf(qn) >= 0) idx.push(i);
      }
      // 新しい順(時刻が読めなければ配列の後ろ=新しい、とみなす)
      idx.sort((a, b) => {
        const ta = Date.parse(all[a].time), tb = Date.parse(all[b].time);
        if (isFinite(ta) && isFinite(tb) && ta !== tb) return tb - ta;
        return b - a;
      });
      hits = idx.map(i => all[i]);
      if (!hits.length) { meta.textContent = ''; emptyMsg(tr('bro_search_none', '見つかりませんでした')); return; }
      meta.textContent = hits.length + tr('bro_search_count', '件');
      renderMore(null);
    }

    function schedule() { clearTimeout(timer); timer = setTimeout(run, 150); }
    input.addEventListener('input', schedule);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); run(); input.blur(); } });
    x.addEventListener('click', () => close());
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);

    function close(instant) {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      if (cur && cur.ov === ov) cur = null;
      const done = () => { ov.remove(); try { if (prevFocus && prevFocus.focus && !instant) prevFocus.focus({ preventScroll: true }); } catch (e) {} };
      if (instant || reduced()) { done(); return; }
      ov.classList.remove('on'); ov.classList.add('out');
      let fin = false;
      const f = () => { if (fin) return; fin = true; done(); };
      ov.addEventListener('transitionend', e => { if (e.target === ov && e.propertyName === 'transform') f(); });
      setTimeout(f, 400);       // transitionend が来ない環境の保険
    }

    document.body.appendChild(ov);
    emptyMsg(tr('bro_search_hint', 'キーワードを入力してください'));
    void ov.offsetWidth;                  // 初期状態を確定させてから on を付ける(アニメが走る)
    ov.classList.add('on');
    setTimeout(() => { try { input.focus({ preventScroll: true }); } catch (e) {} }, reduced() ? 0 : 120);

    cur = { ov, close };
    return { close, _input: input };
  }

  window.BroChatSearch = { open, _norm: norm, _normWithMap: normWithMap };
})();
