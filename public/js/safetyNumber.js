// js/safetyNumber.js
// 安全番号(相手と自分の暗号鍵を照らし合わせるための60桁の数字とQR)。
//
// E2E暗号化していても、サーバーが「相手の公開鍵です」と言って自分の鍵を渡してきたら、
// こちらはそれに向けて暗号化してしまい、サーバーが読める(なりすまし)。それを見抜く方法は、
// 相手と直接会うか通話して、お互いの画面に出る同じ数字を見比べることしかない。
//
// - 番号は 自分の全端末の公開鍵 と 相手の全端末の公開鍵 から作る。どちらかの端末が増えたら番号も変わる
// - 一度確認したら、その時の相手の鍵を覚えておく。知らない鍵が増えたら「確認済み」を外して、
//   次に送る前に一度止める(このまま送るか、もう一度確認するか)
// - 初めて会った相手の鍵は覚えるだけ(TOFU)。2回目以降に知らない鍵が増えたら知らせる
// - 端末が減るのは攻撃にならない(読める人が減るだけ)ので知らせない
(function (g) {
  const VERSION = 1;
  const ITER = 5200;            // 番号の総当たり(似た番号になる鍵探し)を重くする
  const QR_PREFIX = 'BCSN' + VERSION + ':';
  const STORE = 'bc_sn_v1';     // { "<me>|<peer>": { known:[], verified:[]|null, alert:{added:[],at}|null, hold:bool } }

  const enc = new TextEncoder();
  const uniqSorted = list => Array.from(new Set((list || []).filter(k => typeof k === 'string' && k))).sort();

  function loadAll() { try { return JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { return {}; } }
  function saveAll(o) { try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) {} }
  const slot = (me, peer) => String(me) + '|' + String(peer);
  function get(me, peer) { return loadAll()[slot(me, peer)] || null; }
  function put(me, peer, v) { const o = loadAll(); if (v) o[slot(me, peer)] = v; else delete o[slot(me, peer)]; saveAll(o); }

  async function sha512(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-512', bytes)); }

  // 1人ぶんの30桁
  async function userDigits(userId, keys) {
    const blob = enc.encode('BroChatSafetyNumber|' + VERSION + '|' + userId + '|' + uniqSorted(keys).join(','));
    let h = blob;
    for (let i = 0; i < ITER; i++) {
      const b = new Uint8Array(h.length + blob.length);
      b.set(h); b.set(blob, h.length);
      h = await sha512(b);
    }
    let out = '';
    for (let i = 0; i < 6; i++) {
      // 5バイト(40bit)を数にして 10^5 で割った余り。2^40 は 10^5 より十分大きいので偏りは無視できる
      let n = 0;
      for (let j = 0; j < 5; j++) n = n * 256 + h[i * 5 + j];
      out += String(n % 100000).padStart(5, '0');
    }
    return out;
  }

  const cache = new Map();
  // 2人のIDの小さい方を先に並べる(どちらの画面でも同じ並びになる)
  async function compute(myId, myKeys, peerId, peerKeys) {
    const key = [myId, uniqSorted(myKeys).join(','), peerId, uniqSorted(peerKeys).join(',')].join('#');
    if (cache.has(key)) return cache.get(key);
    const [a, b] = await Promise.all([userDigits(String(myId), myKeys), userDigits(String(peerId), peerKeys)]);
    const digits = String(myId) < String(peerId) ? a + b : b + a;
    cache.set(key, digits);
    return digits;
  }
  const groups = digits => digits.match(/.{5}/g) || [];

  // サーバーから相手の鍵一覧を受け取るたびに呼ぶ
  // 戻り値: { added:[], verified:bool, hold:bool }
  function observe(me, peer, peerKeys) {
    const keys = uniqSorted(peerKeys);
    if (!me || !peer || !keys.length) return { added: [], verified: false, hold: false };
    const st = get(me, peer);
    if (!st) {
      put(me, peer, { known: keys, verified: null, alert: null, hold: false });
      return { added: [], verified: false, hold: false };
    }
    const known = new Set(st.known || []);
    const added = keys.filter(k => !known.has(k));
    if (added.length) {
      const wasVerified = Array.isArray(st.verified);
      st.known = uniqSorted([...(st.known || []), ...added]).slice(-40);
      st.alert = { added: uniqSorted([...((st.alert && st.alert.added) || []), ...added]), at: Date.now(), wasVerified: wasVerified || !!(st.alert && st.alert.wasVerified) };
      // 確認済みだった相手に知らない鍵が増えた: 次の送信を止める
      if (wasVerified) { st.hold = true; st.verified = null; }
      put(me, peer, st);
    }
    const vset = Array.isArray(st.verified) ? new Set(st.verified) : null;
    return { added, verified: !!(vset && keys.every(k => vset.has(k))), hold: !!st.hold };
  }

  function status(me, peer, peerKeys) {
    const st = get(me, peer);
    if (!st) return { verified: false, hold: false, alert: null };
    const vset = Array.isArray(st.verified) ? new Set(st.verified) : null;
    const keys = uniqSorted(peerKeys);
    return { verified: !!(vset && keys.length && keys.every(k => vset.has(k))), hold: !!st.hold, alert: st.alert || null };
  }

  function setVerified(me, peer, peerKeys, on) {
    const keys = uniqSorted(peerKeys);
    const st = get(me, peer) || { known: [], verified: null, alert: null, hold: false };
    st.known = uniqSorted([...(st.known || []), ...keys]).slice(-40);
    st.verified = on ? keys : null;
    if (on) { st.alert = null; st.hold = false; }
    put(me, peer, st);
  }
  // 「このまま送る」: 止めるのをやめる(確認済みにはしない)
  function acknowledge(me, peer) {
    const st = get(me, peer);
    if (!st) return;
    st.alert = null; st.hold = false;
    put(me, peer, st);
  }

  function holdError(peerName) {
    const t = (k, d) => (g.i18n ? g.i18n.t(k, d) : d);
    const e = new Error(t('sn_hold_err', '相手の暗号鍵が変わったので送信を止めました'));
    e.code = 'KEY_CHANGED';
    return e;
  }

  // ---------- 画面 ----------
  const SVG_SHIELD = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>';
  const SVG_SHIELD_OK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>';
  const SVG_WARN = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  const SVG_CAM = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

  function qrSvg(text) {
    if (typeof g.qrcode !== 'function') return '';
    const q = g.qrcode(0, 'M');
    q.addData(text); q.make();
    const n = q.getModuleCount(), m = 2;
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += 'M' + (c + m) + ' ' + (r + m) + 'h1v1h-1z';
    const s = n + m * 2;
    return '<svg viewBox="0 0 ' + s + ' ' + s + '" width="184" height="184" shape-rendering="crispEdges" style="display:block;background:#fff;border-radius:10px"><path fill="#0f172a" d="' + d + '"/></svg>';
  }

  function css() {
    if (document.getElementById('snCss')) return;
    const st = document.createElement('style');
    st.id = 'snCss';
    st.textContent = `
.sn-back{position:fixed;inset:0;z-index:30000;background:rgba(15,23,42,.45);display:flex;align-items:flex-end;justify-content:center}
.sn-sheet{width:100%;max-width:480px;max-height:92vh;overflow-y:auto;background:#fff;color:#0f172a;border-radius:20px 20px 0 0;padding:18px 18px calc(18px + env(safe-area-inset-bottom));box-sizing:border-box;font-size:14px;line-height:1.55}
.sn-sheet h3{margin:0 0 4px;font-size:17px}
.sn-sub{color:#64748b;font-size:12.5px;margin:0 0 12px}
.sn-pill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;border-radius:999px;padding:3px 10px;margin-bottom:10px}
.sn-pill.ok{background:#dcfce7;color:#166534}.sn-pill.no{background:#f1f5f9;color:#475569}.sn-pill.warn{background:#fee2e2;color:#991b1b}
.sn-num{display:grid;grid-template-columns:repeat(4,1fr);gap:6px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:17px;letter-spacing:.06em;text-align:center;background:#f8fafc;border-radius:12px;padding:12px 8px;margin-bottom:12px}
.sn-qr{display:flex;justify-content:center;margin:4px 0 12px}
.sn-row{display:flex;gap:8px;flex-wrap:wrap}
.sn-btn{flex:1;min-width:130px;display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:12px;padding:11px 12px;font-size:14px;font-weight:600;cursor:pointer;background:#e2e8f0;color:#0f172a}
.sn-btn.pri{background:#0ea5e9;color:#fff}.sn-btn.danger{background:#fee2e2;color:#991b1b}
.sn-cam{position:relative;margin:0 0 12px;border-radius:12px;overflow:hidden;background:#000;aspect-ratio:1/1;display:none}
.sn-cam video{width:100%;height:100%;object-fit:cover;display:block}
.sn-msg{font-size:13px;margin:0 0 10px;min-height:1em}
.sn-msg.ok{color:#15803d}.sn-msg.bad{color:#b91c1c}
.sn-how{color:#64748b;font-size:12px;margin-top:12px}
html.dark-mode .sn-sheet,body.dark-mode .sn-sheet{background:#0f172a;color:#e2e8f0}
html.dark-mode .sn-num,body.dark-mode .sn-num{background:#1e293b}
html.dark-mode .sn-btn,body.dark-mode .sn-btn{background:#334155;color:#e2e8f0}
html.dark-mode .sn-btn.pri,body.dark-mode .sn-btn.pri{background:#0284c7;color:#fff}
@media (prefers-color-scheme: dark){html:not([data-theme="light"]) .sn-sheet{background:#0f172a;color:#e2e8f0}html:not([data-theme="light"]) .sn-num{background:#1e293b}html:not([data-theme="light"]) .sn-btn{background:#334155;color:#e2e8f0}html:not([data-theme="light"]) .sn-btn.pri{background:#0284c7;color:#fff}}
`;
    document.head.appendChild(st);
  }

  function loadJsQR() {
    if (g.jsQR) return Promise.resolve(g.jsQR);
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = '/js/jsQR.min.js';
      s.onload = () => g.jsQR ? res(g.jsQR) : rej(new Error('jsQR'));
      s.onerror = () => rej(new Error('jsQR'));
      document.head.appendChild(s);
    });
  }

  // opts: { myId, peerId, peerName, getKeys: async () => ({ mine:[], peer:[] }), onChange?: () => void }
  async function openSheet(opts) {
    css();
    const t = (k, d, v) => { let s = g.i18n ? g.i18n.t(k, d) : d; if (v) for (const x in v) s = s.split('{' + x + '}').join(v[x]); return s; };
    const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const back = document.createElement('div');
    back.className = 'sn-back';
    back.innerHTML = '<div class="sn-sheet" role="dialog" aria-modal="true"><h3>' + esc(t('sn_title', '暗号化の確認')) + '</h3><p class="sn-sub">' + esc(t('sn_loading', '読み込み中…')) + '</p></div>';
    document.body.appendChild(back);
    const sheet = back.firstChild;
    let stream = null, raf = 0, closed = false;
    const stopCam = () => { if (raf) cancelAnimationFrame(raf); raf = 0; if (stream) stream.getTracks().forEach(tr => tr.stop()); stream = null; };
    const close = () => { closed = true; stopCam(); back.remove(); if (opts.onChange) opts.onChange(); };
    back.addEventListener('click', e => { if (e.target === back) close(); });

    let keys;
    try { keys = await opts.getKeys(); } catch (e) { keys = null; }
    if (closed) return;
    if (!keys || !keys.mine.length || !keys.peer.length) {
      sheet.innerHTML = '<h3>' + esc(t('sn_title', '暗号化の確認')) + '</h3><p class="sn-sub">' + esc(t('sn_no_keys', '相手の暗号鍵がまだありません。相手がアプリを開くと確認できるようになります')) + '</p><div class="sn-row"><button class="sn-btn" data-x>' + esc(t('close', '閉じる')) + '</button></div>';
      sheet.querySelector('[data-x]').onclick = close;
      return;
    }
    const digits = await compute(opts.myId, keys.mine, opts.peerId, keys.peer);
    if (closed) return;

    const render = (msg, cls) => {
      const st = status(opts.myId, opts.peerId, keys.peer);
      const pill = st.verified
        ? '<span class="sn-pill ok">' + SVG_SHIELD_OK + esc(t('sn_verified', '確認済み')) + '</span>'
        : (st.alert ? '<span class="sn-pill warn">' + SVG_WARN + esc(t('sn_changed', '鍵が変わりました')) + '</span>' : '<span class="sn-pill no">' + SVG_SHIELD + esc(t('sn_unverified', '未確認')) + '</span>');
      sheet.innerHTML =
        '<h3>' + esc(t('sn_title', '暗号化の確認')) + '</h3>' +
        '<p class="sn-sub">' + esc(t('sn_sub', '{name}さんの画面にも同じ数字が出ていれば、間に誰も入っていません', { name: opts.peerName || '' })) + '</p>' +
        pill +
        (st.alert ? '<p class="sn-msg bad">' + esc(t('sn_changed_note', '{name}さんの端末が増えたか、アプリを入れ直したようです。心当たりを本人に聞いて、もう一度確認してください', { name: opts.peerName || '' })) + '</p>' : '') +
        '<div class="sn-num">' + groups(digits).map(x => '<span>' + x + '</span>').join('') + '</div>' +
        '<div class="sn-qr">' + qrSvg(QR_PREFIX + digits) + '</div>' +
        '<div class="sn-cam"><video playsinline muted></video></div>' +
        '<p class="sn-msg ' + (cls || '') + '">' + esc(msg || '') + '</p>' +
        '<div class="sn-row">' +
          '<button class="sn-btn" data-scan>' + SVG_CAM + esc(t('sn_scan', '相手のQRを読む')) + '</button>' +
          (st.verified
            ? '<button class="sn-btn danger" data-unv>' + esc(t('sn_unverify', '確認を外す')) + '</button>'
            : '<button class="sn-btn pri" data-ver>' + SVG_SHIELD_OK + esc(t('sn_mark', '数字が同じだった')) + '</button>') +
        '</div>' +
        (st.hold ? '<div class="sn-row" style="margin-top:8px"><button class="sn-btn" data-ack>' + esc(t('sn_send_anyway', '確認せずに送れるようにする')) + '</button></div>' : '') +
        '<div class="sn-row" style="margin-top:8px"><button class="sn-btn" data-x>' + esc(t('close', '閉じる')) + '</button></div>' +
        '<p class="sn-how">' + esc(t('sn_how', '会っている時はQRを読み合うだけ。離れている時は通話しながら数字を読み上げてください(このトークのメッセージで送り合っても意味がありません)')) + '</p>';
      sheet.querySelector('[data-x]').onclick = close;
      const v = sheet.querySelector('[data-ver]'); if (v) v.onclick = () => { setVerified(opts.myId, opts.peerId, keys.peer, true); render(t('sn_marked', '確認済みにしました'), 'ok'); };
      const u = sheet.querySelector('[data-unv]'); if (u) u.onclick = () => { setVerified(opts.myId, opts.peerId, keys.peer, false); render(); };
      const a = sheet.querySelector('[data-ack]'); if (a) a.onclick = () => { acknowledge(opts.myId, opts.peerId); render(); };
      sheet.querySelector('[data-scan]').onclick = startScan;
    };

    async function startScan() {
      const box = sheet.querySelector('.sn-cam'), video = box.querySelector('video'), msgEl = sheet.querySelector('.sn-msg');
      stopCam();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      } catch (e) { msgEl.className = 'sn-msg bad'; msgEl.textContent = t('sn_cam_err', 'カメラを使えませんでした'); return; }
      if (closed) { stopCam(); return; }
      box.style.display = 'block';
      video.srcObject = stream;
      try { await video.play(); } catch (e) {}
      msgEl.className = 'sn-msg'; msgEl.textContent = t('sn_scanning', '相手の画面のQRを映してください');
      let detector = null;
      try { if ('BarcodeDetector' in g) detector = new g.BarcodeDetector({ formats: ['qr_code'] }); } catch (e) { detector = null; }
      let jsqr = null;
      if (!detector) { try { jsqr = await loadJsQR(); } catch (e) { msgEl.className = 'sn-msg bad'; msgEl.textContent = t('sn_cam_err', 'カメラを使えませんでした'); stopCam(); return; } }
      const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
      let busy = false;
      const done = text => {
        stopCam(); box.style.display = 'none';
        if (text === QR_PREFIX + digits) {
          setVerified(opts.myId, opts.peerId, keys.peer, true);
          render(t('sn_match', '一致しました。確認済みにしました'), 'ok');
        } else if (text.startsWith('BCSN')) {
          render(t('sn_mismatch', '数字が一致しません。どちらかの端末が増えたばかりなら、両方で開き直してからもう一度。それでも違うなら、間に誰かがいる可能性があります'), 'bad');
        } else {
          render(t('sn_not_ours', 'Bro Chatの確認用QRではありません'), 'bad');
        }
      };
      const tick = async () => {
        if (!stream || closed) return;
        raf = requestAnimationFrame(tick);
        if (busy || video.readyState < 2) return;
        busy = true;
        try {
          if (detector) {
            const r = await detector.detect(video);
            if (r && r[0] && r[0].rawValue) return done(String(r[0].rawValue));
          } else {
            const w = video.videoWidth, h = video.videoHeight;
            if (w && h) {
              const s = Math.min(1, 640 / Math.max(w, h));
              cv.width = Math.round(w * s); cv.height = Math.round(h * s);
              cx.drawImage(video, 0, 0, cv.width, cv.height);
              const img = cx.getImageData(0, 0, cv.width, cv.height);
              const r = jsqr(img.data, cv.width, cv.height, { inversionAttempts: 'dontInvert' });
              if (r && r.data) return done(String(r.data));
            }
          }
        } catch (e) {} finally { busy = false; }
      };
      raf = requestAnimationFrame(tick);
    }

    render();
  }

  g.SafetyNumber = { compute, groups, observe, status, setVerified, acknowledge, holdError, openSheet, QR_PREFIX, SVG_SHIELD, SVG_SHIELD_OK, SVG_WARN };
})(window);
