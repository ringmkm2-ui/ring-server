'use strict';
/* 共通部品: DOM構築, アイコン, 整形, API, ダイアログ, トースト
   外部から来る文字列は必ず textContent / テキストノードで入れる。innerHTML は使わない。 */
(function () {
  const BC = window.BC = {};
  const NS = 'http://www.w3.org/2000/svg';

  /* ---------- DOM ---------- */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    add(el, kids);
    return el;
  }
  function add(el, kids) {
    for (const c of kids) {
      if (c == null || c === false) continue;
      if (Array.isArray(c)) add(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
  BC.h = h; BC.add = add; BC.clear = clear;

  /* ---------- アイコン (stroke, currentColor) ---------- */
  const P = (d) => ['path', { d }];
  const L = (x1, y1, x2, y2) => ['line', { x1, y1, x2, y2 }];
  const C = (cx, cy, r) => ['circle', { cx, cy, r }];
  const R = (x, y, w, hh, rx) => ['rect', { x, y, width: w, height: hh, rx: rx || 0 }];
  const PL = (points) => ['polyline', { points }];
  const ICONS = {
    shield: [P('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'), PL('9 12 11 14 15 10')],
    dashboard: [R(3, 3, 7, 9, 1.5), R(14, 3, 7, 5, 1.5), R(14, 12, 7, 9, 1.5), R(3, 16, 7, 5, 1.5)],
    users: [P('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'), C(9, 7, 4), P('M23 21v-2a4 4 0 0 0-3-3.87'), P('M16 3.13a4 4 0 0 1 0 7.75')],
    online: [PL('22 12 18 12 15 21 9 3 6 12 2 12')],
    flag: [P('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z'), L(4, 22, 4, 15)],
    posts: [P('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z')],
    audit: [P('M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2'), R(9, 3, 6, 4, 1), L(9, 12, 15, 12), L(9, 16, 13, 16)],
    refresh: [P('M21 12a9 9 0 1 1-3-6.7'), PL('21 3 21 9 15 9')],
    logout: [P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), PL('16 17 21 12 16 7'), L(21, 12, 9, 12)],
    search: [C(11, 11, 7), L(21, 21, 16.65, 16.65)],
    x: [L(18, 6, 6, 18), L(6, 6, 18, 18)],
    lock: [R(3, 11, 18, 11, 2), P('M7 11V7a5 5 0 0 1 10 0v4')],
    unlock: [R(3, 11, 18, 11, 2), P('M7 11V7a5 5 0 0 1 9.9-1')],
    ban: [C(12, 12, 10), L(4.93, 4.93, 19.07, 19.07)],
    checkcircle: [P('M22 11.08V12a10 10 0 1 1-5.93-9.14'), PL('22 4 12 14.01 9 11.01')],
    check: [PL('20 6 9 17 4 12')],
    key: [C(7.5, 15.5, 4.5), P('M10.7 12.3L21 2'), P('M17 6l3 3')],
    copy: [R(9, 9, 13, 13, 2), P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
    trash: [PL('3 6 5 6 21 6'), P('M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6'), L(10, 11, 10, 17), L(14, 11, 14, 17), P('M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2')],
    undo: [PL('1 4 1 10 7 10'), P('M3.51 15a9 9 0 1 0 2.13-9.36L1 10')],
    left: [PL('15 18 9 12 15 6')],
    right: [PL('9 18 15 12 9 6')],
    alert: [P('M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z'), L(12, 9, 12, 13), L(12, 17, 12.01, 17)],
    server: [R(2, 2, 20, 8, 2), R(2, 14, 20, 8, 2), L(6, 6, 6.01, 6), L(6, 18, 6.01, 18)],
    eye: [P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'), C(12, 12, 3)],
    eyeoff: [P('M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24'), L(1, 1, 23, 23)],
    up: [L(12, 19, 12, 5), PL('5 12 12 5 19 12')],
    down: [L(12, 5, 12, 19), PL('19 12 12 19 5 12')],
    dice: [R(3, 3, 18, 18, 3), C(8.5, 8.5, 0.6), C(15.5, 15.5, 0.6), C(12, 12, 0.6), C(15.5, 8.5, 0.6), C(8.5, 15.5, 0.6)],
    play: [['polygon', { points: '6 3 20 12 6 21' }]],
    image: [R(3, 3, 18, 18, 2), C(8.5, 8.5, 1.5), PL('21 15 16 10 5 21')],
    device: [R(2, 3, 20, 14, 2), L(8, 21, 16, 21), L(12, 17, 12, 21)],
    eyeview: [P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'), C(12, 12, 3)],
    user: [P('M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'), C(12, 7, 4)],
    inbox: [P('M22 12h-6l-2 3h-4l-2-3H2'), P('M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z')],
  };
  function icon(name, size) {
    const def = ICONS[name] || [];
    const s = String(size || 16);
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
    svg.classList.add('ic');
    for (const [tag, attrs] of def) {
      const n = document.createElementNS(NS, tag);
      for (const k of Object.keys(attrs)) n.setAttribute(k, String(attrs[k]));
      svg.appendChild(n);
    }
    return svg;
  }
  BC.icon = icon;
  // <span data-icon="name"> を実アイコンに置き換える
  BC.hydrateIcons = (root) => {
    (root || document).querySelectorAll('[data-icon]').forEach(el => {
      el.replaceWith(icon(el.getAttribute('data-icon'), Number(el.getAttribute('data-size')) || 16));
    });
  };

  /* ---------- 整形 ---------- */
  const pad = n => String(n).padStart(2, '0');
  function parseDate(v) {
    if (v == null || v === '') return null;
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (typeof v === 'number') { const d = new Date(v); return isNaN(d) ? null : d; }
    let s = String(v).trim();
    if (/^\d{10,}$/.test(s)) { const d = new Date(Number(s)); return isNaN(d) ? null : d; }
    if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s)) s += 'Z';
    const d = new Date(s);
    return isNaN(d) ? null : d;
  }
  const fmt = BC.fmt = {
    num: n => (n == null || isNaN(Number(n))) ? '-' : Number(n).toLocaleString('ja-JP'),
    date: v => { const d = parseDate(v); return d ? `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}` : '-'; },
    dt: v => { const d = parseDate(v); return d ? `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : '-'; },
    time: d => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
    rel: v => {
      const d = parseDate(v); if (!d) return '-';
      const s = Math.round((Date.now() - d.getTime()) / 1000);
      if (s < 45) return 'たった今';
      if (s < 3600) return Math.round(s / 60) + '分前';
      if (s < 86400) return Math.floor(s / 3600) + '時間前';
      if (s < 86400 * 30) return Math.floor(s / 86400) + '日前';
      return fmt.date(d);
    },
    uptime: s => {
      if (s == null) return '-';
      const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
      return d ? `${d}日${hh}時間` : hh ? `${hh}時間${m}分` : `${m}分`;
    },
    until: ms => {
      if (ms == null) return '';
      const t = Number(ms) - Date.now();
      if (t > 3000 * 86400000) return '無期限';
      const hh = Math.max(1, Math.ceil(t / 36e5));
      return 'あと' + (hh >= 24 ? Math.floor(hh / 24) + '日' + (hh % 24 ? (hh % 24) + '時間' : '') : hh + '時間');
    },
  };
  BC.parseDate = parseDate;

  /* ---------- 小さな部品 ---------- */
  BC.tag = (text, tone, title) => h('span', { class: 'tag' + (tone ? ' ' + tone : ''), title: title || null }, text);
  BC.avatar = (name, size) => {
    const s = String(name || '?');
    let hue = 0; for (const ch of s) hue = (hue * 31 + ch.codePointAt(0)) % 360;
    const el = h('span', { class: 'avatar' + (size ? ' ' + size : ''), 'aria-hidden': 'true' }, (Array.from(s.trim())[0] || '?').toUpperCase());
    el.style.setProperty('--h', String(hue));
    return el;
  };
  BC.skelRows = (n, cols) => {
    const f = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const row = h('div', { class: 'skel-row' });
      for (let c = 0; c < (cols || 3); c++) row.appendChild(h('i', { class: 'skel', style: { width: (c === 0 ? 34 : 18 + ((i * 7 + c * 13) % 28)) + '%' } }));
      f.appendChild(row);
    }
    return f;
  };
  BC.empty = (ic, title, sub, action) => h('div', { class: 'empty' },
    h('span', { class: 'empty-ic' }, icon(ic || 'inbox', 28)),
    h('strong', null, title),
    sub ? h('span', { class: 'muted' }, sub) : null,
    action || null);
  BC.seg = (opts, value, onChange, label) => {
    const el = h('div', { class: 'seg', role: 'group', 'aria-label': label || null });
    let cur = value;
    const btns = opts.map(([v, text]) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(v === cur), onclick: () => { if (cur === v) return; set(v); onChange(v); } }, text);
      el.appendChild(b); return [v, b];
    });
    function set(v) { cur = v; btns.forEach(([x, b]) => b.setAttribute('aria-pressed', String(x === v))); }
    return { el, set, get: () => cur };
  };
  BC.pager = (limit, onPage) => {
    const info = h('span', { class: 'muted pager-info' });
    const prev = h('button', { class: 'btn sm', type: 'button', 'aria-label': '前のページ', onclick: () => onPage(-1) }, icon('left', 14), '前へ');
    const next = h('button', { class: 'btn sm', type: 'button', 'aria-label': '次のページ', onclick: () => onPage(1) }, '次へ', icon('right', 14));
    const el = h('div', { class: 'pager' }, info, h('span', { class: 'grow' }), prev, next);
    return {
      el,
      update(total, offset, shown) {
        const from = total ? offset + 1 : 0, to = offset + shown;
        info.textContent = total ? `${fmt.num(from)} - ${fmt.num(to)} / ${fmt.num(total)} 件` : '0 件';
        prev.disabled = offset <= 0;
        next.disabled = offset + limit >= total;
        el.hidden = total <= limit;
      },
    };
  };
  BC.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  BC.searchBox = (placeholder, onInput) => {
    const input = h('input', { class: 'inp', type: 'text', spellcheck: 'false', placeholder, 'aria-label': placeholder });
    const d = BC.debounce(() => onInput(input.value.trim()), 250);
    input.addEventListener('input', d);
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { input.value = ''; onInput(''); e.stopPropagation(); } });
    return { el: h('span', { class: 'search' }, icon('search', 15), input), input };
  };
  BC.isHttps = u => typeof u === 'string' && /^https:\/\//i.test(u);
  BC.isVideo = (url, type) => /video/i.test(String(type || '')) || /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(String(url)) || /\/video\/upload\//.test(String(url));

  // メディアの小さなサムネ。クリックで拡大。
  BC.mediaThumb = (url, type) => {
    if (!BC.isHttps(url)) return null;
    const video = BC.isVideo(url, type);
    const btn = h('button', { class: 'thumb', type: 'button', title: '拡大', 'aria-label': video ? '動画を拡大' : '画像を拡大', onclick: () => BC.lightbox(url, video) });
    if (video) {
      const v = h('video', { preload: 'metadata', muted: true, playsinline: true, tabindex: '-1' });
      v.muted = true; v.src = url;
      btn.append(v, h('span', { class: 'thumb-play' }, icon('play', 14)));
    } else {
      const img = h('img', { alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
      img.addEventListener('error', () => { btn.classList.add('broken'); clear(btn).appendChild(icon('image', 18)); });
      img.src = url; btn.appendChild(img);
    }
    return btn;
  };

  /* ---------- トースト ---------- */
  BC.toast = (msg, kind) => {
    const box = document.getElementById('toasts');
    const t = h('div', { class: 'toast ' + (kind || 'ok'), role: kind === 'err' ? 'alert' : 'status' },
      icon(kind === 'err' ? 'alert' : 'check', 16), h('span', null, String(msg)));
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    try { box.hidePopover(); } catch (e) {}
    try { box.showPopover(); } catch (e) {}   // ダイアログより手前に出す
    const ms = kind === 'err' ? 5200 : 2800;
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => { t.remove(); if (!box.children.length) { try { box.hidePopover(); } catch (e) {} } }, 200);
    }, ms);
  };

  /* ---------- クリップボード ---------- */
  BC.copy = async (text) => {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {}
    try {
      const ta = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', class: 'offscreen' });
      ta.value = text; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  };
  BC.copyBtn = (text, label, small) => {
    const b = h('button', { class: 'btn' + (small ? ' sm' : ''), type: 'button' }, icon('copy', 14), h('span', null, label || 'コピー'));
    b.addEventListener('click', async () => {
      const ok = await BC.copy(typeof text === 'function' ? text() : text);
      const s = b.querySelector('span'); const old = label || 'コピー';
      s.textContent = ok ? 'コピーした' : '失敗';
      setTimeout(() => { s.textContent = old; }, 1400);
    });
    return b;
  };

  /* ---------- ダイアログ(<dialog>) ---------- */
  function openDialog(cls, build) {
    return new Promise(resolve => {
      const dlg = h('dialog', { class: 'dlg ' + (cls || '') });
      let result = null;
      const api = {
        dlg,
        done(v) { result = v; if (dlg.open) dlg.close(); },
      };
      dlg.appendChild(build(api));
      dlg.addEventListener('close', () => { dlg.remove(); resolve(result); });
      dlg.addEventListener('mousedown', e => { if (e.target === dlg) api.done(null); });
      document.body.appendChild(dlg);
      dlg.showModal();
      if (api.focus) api.focus();
    });
  }
  BC.openDialog = openDialog;

  BC.confirm = ({ title, message, okText, cancelText, danger, detail }) => openDialog('sm', api => {
    const ok = h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), type: 'button', onclick: () => api.done(true) }, okText || '実行');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => api.done(false) }, cancelText || 'やめる');
    api.focus = () => (danger ? cancel : ok).focus();
    return h('div', { class: 'dlg-body', role: 'alertdialog', 'aria-label': title },
      h('h3', null, title),
      message ? h('p', { class: 'dlg-msg' }, message) : null,
      detail ? h('p', { class: 'dlg-detail' }, detail) : null,
      h('div', { class: 'dlg-actions' }, cancel, ok));
  }).then(v => v === true);

  // BANダイアログ -> {hours, reason} | null
  BC.banDialog = (user) => openDialog('', api => {
    const PRESETS = [[1, '1時間'], [24, '1日'], [72, '3日'], [168, '7日'], [720, '30日'], [87600, '無期限']];
    let hours = 24;
    const hoursIn = h('input', { class: 'inp', type: 'number', min: '1', max: '87600', step: '1', value: '24', 'aria-label': '時間' });
    const reason = h('textarea', { class: 'inp', rows: '3', maxlength: '200', placeholder: '理由 (任意、200文字まで)', 'aria-label': '理由' });
    const count = h('span', { class: 'muted' }, '0 / 200');
    const until = h('p', { class: 'muted ban-until' });
    const err = h('p', { class: 'form-err', role: 'alert' });
    const chips = PRESETS.map(([v, text]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: () => { hoursIn.value = String(v); sync(); } }, text));
    function valid() { const n = Number(hoursIn.value); return Number.isInteger(n) && n >= 1 && n <= 87600 ? n : null; }
    function sync() {
      const n = valid();
      chips.forEach((c, i) => c.setAttribute('aria-pressed', String(n === PRESETS[i][0])));
      if (n == null) { until.textContent = '1 から 87600 の整数で入れる'; ok.disabled = true; return; }
      ok.disabled = false; hours = n;
      until.textContent = n >= 87600 ? '解除予定: 無期限 (87600時間)' : '解除予定: ' + fmt.dt(Date.now() + n * 3600000);
    }
    hoursIn.addEventListener('input', sync);
    reason.addEventListener('input', () => { count.textContent = reason.value.length + ' / 200'; });
    const ok = h('button', { class: 'btn danger', type: 'submit' }, 'BANする');
    const form = h('form', { class: 'dlg-body', onsubmit: e => { e.preventDefault(); if (valid() != null) api.done({ hours, reason: reason.value.trim() }); } },
      h('h3', null, 'BAN'),
      h('p', { class: 'dlg-msg' }, (user.displayName || user.username) + ' を利用停止にする。全端末のセッションは切れる。'),
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '期間'), h('div', { class: 'chips' }, chips),
        h('div', { class: 'inline' }, hoursIn, h('span', { class: 'muted' }, '時間'))),
      until,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '理由'), reason, h('div', { class: 'right' }, count)),
      err,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => api.done(null) }, 'やめる'), ok));
    api.focus = () => hoursIn.focus();
    sync();
    return form;
  });

  // パスワード生成: 紛らわしい文字を除いた英数字+記号
  BC.genPassword = (len) => {
    const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '-_!@#%+='];
    const all = sets.join('');
    const rnd = (n) => { // 偏りなし
      const buf = new Uint32Array(1); const lim = Math.floor(0x100000000 / n) * n;
      do { crypto.getRandomValues(buf); } while (buf[0] >= lim);
      return buf[0] % n;
    };
    const out = sets.map(s => s[rnd(s.length)]);
    while (out.length < (len || 18)) out.push(all[rnd(all.length)]);
    for (let i = out.length - 1; i > 0; i--) { const j = rnd(i + 1); [out[i], out[j]] = [out[j], out[i]]; }
    return out.join('');
  };

  // パスワード再設定。submit(pw) は Promise (失敗は throw)。
  BC.passwordDialog = (user, submit) => openDialog('', api => {
    const input = h('input', { class: 'inp mono', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': '新しいパスワード', placeholder: '8文字以上' });
    const err = h('p', { class: 'form-err', role: 'alert' });
    const gen = h('button', { class: 'btn', type: 'button', onclick: () => { input.value = BC.genPassword(18); input.focus(); err.textContent = ''; } }, icon('dice', 14), '生成');
    const copy = BC.copyBtn(() => input.value, 'コピー');
    const ok = h('button', { class: 'btn primary', type: 'submit' }, '変更する');
    const cancel = h('button', { class: 'btn', type: 'button', onclick: () => api.done(false) }, 'やめる');
    const actions = h('div', { class: 'dlg-actions' }, cancel, ok);
    const msg = h('p', { class: 'dlg-msg' }, (user.displayName || user.username) + ' のパスワードを変える。全端末はログアウトされ、ロックも解ける。');
    const title = h('h3', null, 'パスワード再設定');
    const form = h('form', { class: 'dlg-body', onsubmit: async e => {
      e.preventDefault();
      const pw = input.value;
      if (pw.length < 8) { err.textContent = '8文字以上にする'; return; }
      ok.disabled = true; ok.textContent = '変更中...'; err.textContent = '';
      try {
        await submit(pw);
        // 成功後はパスワードを残して、コピーできるようにする
        title.textContent = '変更した';
        msg.textContent = 'このパスワードは再表示できない。今コピーして本人に伝える。';
        input.readOnly = true; gen.hidden = true;
        clear(actions).appendChild(h('button', { class: 'btn primary', type: 'button', onclick: () => api.done(true) }, '閉じる'));
        copy.focus();
      } catch (e2) { err.textContent = e2.message || '失敗した'; ok.disabled = false; ok.textContent = '変更する'; }
    } },
      title, msg,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, '新しいパスワード'), h('div', { class: 'inline grow-first' }, input, gen, copy)),
      err, actions);
    api.focus = () => input.focus();
    return form;
  });

  BC.lightbox = (url, video) => openDialog('light', api => {
    const media = video
      ? h('video', { src: url, controls: true, autoplay: true, class: 'light-media' })
      : h('img', { src: url, alt: '', class: 'light-media', referrerpolicy: 'no-referrer' });
    const close = h('button', { class: 'iconbtn light-close', type: 'button', 'aria-label': '閉じる', onclick: () => api.done(null) }, icon('x', 18));
    api.focus = () => close.focus();
    return h('div', { class: 'light-body', onclick: e => { if (e.target === e.currentTarget) api.done(null); } }, media, close);
  });

  /* ---------- API ---------- */
  BC.cfg = { url: '', key: '' };
  BC.hooks = { down() {}, up() {}, auth() {} };
  const CAT = { spam: 'スパム・迷惑行為', harassment: '嫌がらせ・脅し', impersonation: 'なりすまし', inappropriate: '不適切な内容', other: 'その他' };
  BC.CAT = CAT;

  function apiError(status, msg, extra) {
    const e = new Error(msg); e.status = status; return Object.assign(e, extra || {});
  }
  BC.api = async function (method, path, body, opts) {
    const quiet = opts && opts.quiet;
    let r;
    try {
      r = await window.admin.api({ url: BC.cfg.url, key: BC.cfg.key, method, path, body });
    } catch (e) { r = { status: 0, error: '内部エラー' }; }
    if (!r) r = { status: 0, error: '応答がない' };
    if (r.status === 0 || (r.status >= 502 && r.status <= 504)) {
      const err = apiError(0, r.error || 'サーバーに接続できない', { network: true });
      if (!quiet) BC.hooks.down(err);
      throw err;
    }
    BC.hooks.up();
    const d = r.data;
    if (r.status === 401) { const err = apiError(401, '管理キーが違う', { auth: true }); if (!quiet) BC.hooks.auth(err); throw err; }
    if (r.status === 404 && path === '/api/admin/stats') throw apiError(404, '管理APIが無効。ADMIN_API_KEY が未設定か、未デプロイ');
    if (r.status === 429) throw apiError(429, '試行が多すぎる。しばらく待つ');
    if (r.status >= 400) throw apiError(r.status, (d && d.error) || ('エラー ' + r.status));
    return d;
  };
})();
