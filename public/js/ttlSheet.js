// ttlSheet.js
// 消えるメッセージ(自動削除)の時間を選ぶボトムシート。
//   BroTtl.openSheet({ current: 86400, onPick: async (seconds) => {...保存...}, title?, note? })
//     オフ(0) / 1時間 / 1日 / 1週間 のラジオ行。選ぶと onPick を待ち、成功したら閉じる(失敗したらシート内にエラーを出して開いたまま)。
//     下からバネで上がる(transform/opacity のみ)・背景は薄く暗くするだけ(backdrop-filter なし)。Esc/背景タップで閉じる。
//   BroTtl.label(86400)  -> '1日'     (0 -> 'オフ'。半端な値は '30分' '2日' のように)
//   BroTtl.badge(86400)  -> <span> (小さな時計のSVG + ラベル)。0/不正なら null。ヘッダーのタイトル横などに appendChild する。
// 1:1もグループも同じ。保存先のAPIは onPick の中でページ側が呼ぶ。
(function () {
  if (window.BroTtl) return;

  const tr = (k, fb) => { try { return (window.i18n && window.i18n.t) ? window.i18n.t(k, fb) : fb; } catch (e) { return fb; } };
  const reduced = () => document.documentElement.classList.contains('reduce-motion') ||
    (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const NS = 'http://www.w3.org/2000/svg';
  const OPTIONS = [[0, 'bro_ttl_off', 'オフ'], [3600, 'bro_ttl_1h', '1時間'], [86400, 'bro_ttl_1d', '1日'], [604800, 'bro_ttl_1w', '1週間']];

  function label(sec) {
    sec = Number(sec) || 0;
    for (const o of OPTIONS) if (o[0] === sec) return tr(o[1], o[2]);
    if (sec <= 0) return tr('bro_ttl_off', 'オフ');
    if (sec % 604800 === 0) return (sec / 604800) + tr('bro_ttl_unit_w', '週間');
    if (sec % 86400 === 0) return (sec / 86400) + tr('bro_ttl_unit_d', '日');
    if (sec % 3600 === 0) return (sec / 3600) + tr('bro_ttl_unit_h', '時間');
    if (sec >= 60) return Math.round(sec / 60) + tr('bro_ttl_unit_m', '分');
    return sec + tr('bro_ttl_unit_s', '秒');
  }

  function svg(w) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('width', w); s.setAttribute('height', w); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2.4');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
    return s;
  }
  function add(p, tag, attrs) { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); p.appendChild(e); return e; }

  function badge(sec) {
    sec = Number(sec) || 0;
    if (!(sec > 0)) return null;
    const b = document.createElement('span');
    b.className = 'bttl-badge';
    b.style.cssText = 'display:inline-flex;align-items:center;gap:3px;font-size:11px;font-weight:600;opacity:.7;vertical-align:middle;line-height:1';
    b.title = tr('bro_ttl_auto', '自動削除') + ': ' + label(sec);
    const c = svg(11); add(c, 'circle', { cx: 12, cy: 12, r: 9 }); add(c, 'polyline', { points: '12 7 12 12 15.5 14' });
    b.appendChild(c);
    const t = document.createElement('span'); t.textContent = label(sec);
    b.appendChild(t);
    return b;
  }

  function css() {
    if (document.getElementById('bro-ttl-css')) return;
    const s = document.createElement('style');
    s.id = 'bro-ttl-css';
    s.textContent =
      '.bttl{--bg:#fff;--fg:#0f172a;--sub:#64748b;--line:rgba(15,23,42,.1);--fld:#eef1f5;position:fixed;inset:0;z-index:20600;display:flex;align-items:flex-end;justify-content:center;font-family:inherit;-webkit-tap-highlight-color:transparent}' +
      'html.dark-mode .bttl{--bg:#1e293b;--fg:#e2e8f0;--sub:#94a3b8;--line:rgba(255,255,255,.1);--fld:#0f172a}' +
      '.bttl-bd{position:absolute;inset:0;background:rgba(0,0,0,.45);opacity:0}' +
      '.bttl-sh{position:relative;width:100%;max-width:520px;background:var(--bg);color:var(--fg);border-radius:18px 18px 0 0;padding:8px 0 calc(12px + env(safe-area-inset-bottom,0px));transform:translate3d(0,100%,0);will-change:transform}' +
      '.bttl.on .bttl-bd{opacity:1;transition:opacity .25s ease}' +
      '.bttl.on .bttl-sh{transform:none;transition:transform .5s cubic-bezier(.2,1.05,.3,1)}' +
      '.bttl.out .bttl-bd{opacity:0;transition:opacity .2s ease}' +
      '.bttl.out .bttl-sh{transform:translate3d(0,100%,0);transition:transform .22s ease-in}' +
      'html.reduce-motion .bttl .bttl-sh,html.reduce-motion .bttl .bttl-bd{transition:none!important}' +
      '@media (prefers-reduced-motion:reduce){.bttl .bttl-sh,.bttl .bttl-bd{transition:none!important}}' +
      '.bttl-grip{width:36px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 8px}' +
      '.bttl-h{padding:4px 20px 2px;font-size:17px;font-weight:700}' +
      '.bttl-n{padding:0 20px 8px;font-size:13px;color:var(--sub);line-height:1.5}' +
      '.bttl-r{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:52px;padding:0 20px;border:0;border-top:1px solid var(--line);background:transparent;color:inherit;font:inherit;font-size:16px;text-align:left;cursor:pointer}' +
      '.bttl-r:active{background:var(--fld)}' +
      '.bttl-r[disabled]{opacity:.55;cursor:default}' +
      '.bttl-r svg{flex:none;color:#007aff}' +
      '.bttl-e{padding:8px 20px 0;font-size:13px;color:#ef4444;min-height:0}' +
      '.bttl-c{display:block;width:calc(100% - 32px);margin:8px 16px 0;min-height:48px;border:0;border-radius:12px;background:var(--fld);color:inherit;font:inherit;font-size:16px;font-weight:600;cursor:pointer}';
    document.head.appendChild(s);
  }

  let cur = null;

  function openSheet(o) {
    o = o || {};
    if (cur) cur.close(true);
    css();
    const prevFocus = document.activeElement;
    const current = Number(o.current) || 0;

    const root = document.createElement('div'); root.className = 'bttl';
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
    const title = o.title || tr('bro_ttl_title', '消えるメッセージ');
    root.setAttribute('aria-label', title);
    const bd = document.createElement('div'); bd.className = 'bttl-bd';
    const sh = document.createElement('div'); sh.className = 'bttl-sh';
    const grip = document.createElement('div'); grip.className = 'bttl-grip';
    const h = document.createElement('div'); h.className = 'bttl-h'; h.textContent = title;
    sh.appendChild(grip); sh.appendChild(h);
    const noteText = o.note != null ? o.note : tr('bro_ttl_note', '設定した時間が過ぎると、このトークのメッセージが自動で消えます。');
    if (noteText) { const n = document.createElement('div'); n.className = 'bttl-n'; n.textContent = noteText; sh.appendChild(n); }

    const grp = document.createElement('div'); grp.setAttribute('role', 'radiogroup'); grp.setAttribute('aria-label', title);
    const rows = [];
    const err = document.createElement('div'); err.className = 'bttl-e'; err.setAttribute('role', 'alert');
    let busy = false, closed = false;

    // 現在値が4択に無い(別端末で違う値にした等)場合も、その値の行を足して選択済みに見せる
    const opts = OPTIONS.map(x => x[0]);
    const list = opts.indexOf(current) >= 0 ? OPTIONS.map(x => x[0]) : OPTIONS.map(x => x[0]).concat([current]);

    function check() {
      const s = svg(20); s.setAttribute('stroke-width', '2.8'); add(s, 'polyline', { points: '20 6 9 17 4 12' }); return s;
    }
    list.forEach(sec => {
      const r = document.createElement('button'); r.type = 'button'; r.className = 'bttl-r';
      r.setAttribute('role', 'radio'); r.setAttribute('aria-checked', sec === current ? 'true' : 'false'); r.dataset.sec = String(sec);
      const t = document.createElement('span'); t.textContent = label(sec); r.appendChild(t);
      if (sec === current) r.appendChild(check());
      r.addEventListener('click', () => pick(sec, r));
      grp.appendChild(r); rows.push(r);
    });
    sh.appendChild(grp); sh.appendChild(err);
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'bttl-c'; cancel.textContent = tr('bro_cancel', 'キャンセル');
    cancel.addEventListener('click', () => close());
    sh.appendChild(cancel);
    root.appendChild(bd); root.appendChild(sh);

    async function pick(sec, row) {
      if (busy || closed) return;
      if (sec === current) { close(); return; }
      busy = true; err.textContent = '';
      rows.forEach(r => { r.disabled = true; });
      // 押した行にすぐチェックを移す(保存の完了を待たずに反応させる)
      rows.forEach(r => { r.setAttribute('aria-checked', r === row ? 'true' : 'false'); const c = r.querySelector('svg'); if (c) c.remove(); });
      row.appendChild(check());
      try {
        if (o.onPick) await o.onPick(sec);
        busy = false;
        close();
      } catch (e) {
        busy = false;
        err.textContent = tr('bro_ttl_fail', '変更できませんでした。もう一度お試しください。');
        rows.forEach(r => {
          r.disabled = false;
          const on = r.dataset.sec === String(current);
          r.setAttribute('aria-checked', on ? 'true' : 'false');
          const c = r.querySelector('svg'); if (c) c.remove();
          if (on) r.appendChild(check());
        });
      }
    }

    bd.addEventListener('click', () => { if (!busy) close(); });
    const onKey = e => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);

    function close(instant) {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (cur && cur.root === root) cur = null;
      const done = () => { root.remove(); try { if (prevFocus && prevFocus.focus && !instant) prevFocus.focus({ preventScroll: true }); } catch (e) {} };
      if (instant || reduced()) { done(); return; }
      root.classList.remove('on'); root.classList.add('out');
      let fin = false;
      const f = () => { if (fin) return; fin = true; done(); };
      sh.addEventListener('transitionend', e => { if (e.target === sh && e.propertyName === 'transform') f(); });
      setTimeout(f, 450);
    }

    document.body.appendChild(root);
    void root.offsetWidth;
    root.classList.add('on');
    try { (rows.find(r => r.getAttribute('aria-checked') === 'true') || rows[0]).focus({ preventScroll: true }); } catch (e) {}
    cur = { root, close };
    return { close };
  }

  window.BroTtl = { openSheet, label, badge, OPTIONS: OPTIONS.map(x => x[0]) };
})();
