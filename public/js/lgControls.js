// public/js/lgControls.js
// -----------------------------------------------------------------------
// iOS 26 Liquid Glass: 丸いボタン全部 + スイッチ
//
// WWDC25「Meet Liquid Glass」の挙動に合わせてある:
//  - 普段は静か。触った瞬間にだけ本物の屈折(レンズ)が立ち上がる
//    (フェードではなく屈折の強さを上げて「現れる」)
//  - 指の真下から光が広がる
//  - ゼリーみたいに指の方向へ伸びて、離すと弾んで戻る
//  - 大きくなるほど厚いガラス扱い: 屈折と影が強くなる
//  - スイッチのノブは触ると透明なガラスになって膨らみ、下のトラックが透けて見える
//
// 性能メモ(learnings):
//  backdrop-filter:url() は背後が変わるたびに再計算される重いフィルタなので、
//  「押している間とその余韻だけ」付けて、落ち着いたら外す。常時付けっぱなしにしない。
//  DOM監視(MutationObserver)もしない。タップ直後に軽く再スキャンするだけ。
// -----------------------------------------------------------------------
(function () {
  'use strict';
  if (window.LGControls) return;

  const NS = 'http://www.w3.org/2000/svg';
  const IOR = 1.5;
  const DISP = [1, 1.035, 1.07];           // RGBごとの分散(縁の色収差)
  const RM = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const calm = () => RM || localStorage.getItem('batterySaverAnimations') === '1';

  // backdrop-filter: url() が効くのはChromium(Android APK/WebView)だけ
  const CAN_REFRACT = (() => {
    try {
      const t = document.createElement('div');
      t.style.backdropFilter = 'url(#x)';
      return !!window.chrome && t.style.backdropFilter.indexOf('url') >= 0;
    } catch (e) { return false; }
  })();

  // ============================================================
  // 屈折マップ
  // 縁の断面: ボタン=convex squircle / スイッチのノブ=lip(縁は凸、中央は少し凹む)
  // 真上からの光線をSnellの法則で曲げ、ガラスの厚みぶんの横ずれを求める。
  // 縁ぎりぎりはフレネル反射で透過が減るので、その分ずらしを弱める。
  // ============================================================
  const convex = x => Math.pow(1 - Math.pow(1 - x, 4), 0.25);
  const lip = x => {
    const c = convex(x), v = 1 - 0.45 * c, s = x * x * x * (x * (x * 6 - 15) + 10);
    return c * (1 - s) + v * s;
  };
  function profile(f, B, Hh) {
    const N = 160, T0 = Hh * 0.15, prof = new Float32Array(N + 1);
    let max = 0;
    for (let i = 0; i <= N; i++) {
      const x = Math.max(i / N, 0.004), e = 0.002;
      const fx = t => f(Math.min(1, Math.max(0, t)));
      const fp = (fx(x + e) - fx(x - e)) / (2 * e);
      const ts = Math.atan(fp * Hh / B), tr = Math.asin(Math.sin(ts) / IOR);
      const Fr = 0.04 + 0.96 * Math.pow(1 - Math.cos(ts), 5);
      const d = (Hh * fx(x) + T0) * Math.tan(ts - tr) * (1 - Fr);
      prof[i] = d;
      if (Math.abs(d) > max) max = Math.abs(d);
    }
    return { prof, max: max || 1, N };
  }
  function sdRR(px, py, w, h, r) {
    const qx = Math.abs(px - w / 2) - (w / 2 - r), qy = Math.abs(py - h / 2) - (h / 2 - r);
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  }
  function buildMap(w, h, rad, kind) {
    const half = Math.min(w, h) / 2;
    const B = kind === 'lip' ? half : half * 0.62;
    const Hh = B * (kind === 'lip' ? 0.8 : 0.75);
    const P = profile(kind === 'lip' ? lip : convex, B, Hh);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(w, h), D = img.data;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const X = px + 0.5, Y = py + 0.5, dE = -sdRR(X, Y, w, h, rad), i = (py * w + px) * 4;
        let vx = 0, vy = 0;
        if (dE > 0 && dE < B + 0.5) {
          const gx = sdRR(X + 0.5, Y, w, h, rad) - sdRR(X - 0.5, Y, w, h, rad);
          const gy = sdRR(X, Y + 0.5, w, h, rad) - sdRR(X, Y - 0.5, w, h, rad);
          const gl = Math.hypot(gx, gy);
          if (gl > 1e-4) {
            const m = P.prof[Math.min(P.N, Math.round(dE / B * P.N))] / P.max;
            vx = -gx / gl * m; vy = -gy / gl * m;
          }
        }
        D[i] = 128 + vx * 127; D[i + 1] = 128 + vy * 127; D[i + 2] = 128; D[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return { url: cv.toDataURL('image/png'), max: P.max };
  }

  let defs = null;
  function ensureDefs() {
    if (defs) return defs;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('style', 'position:absolute;width:0;height:0;pointer-events:none');
    defs = document.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    document.body.appendChild(svg);
    return defs;
  }
  function mk(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const CH = ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'];
  // 同じ(幅,高さ,角丸,断面)ならフィルタは1個を使い回す
  const filterCache = new Map();
  let fid = 0;
  function getFilter(w, h, rad, kind) {
    const key = w + 'x' + h + 'r' + rad + kind;
    if (filterCache.has(key)) return filterCache.get(key);
    const map = buildMap(w, h, rad, kind);
    const id = 'lgc-f' + (fid++);
    const f = mk('filter', { id, x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, ensureDefs());
    mk('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: kind === 'lip' ? 0.3 : 0.8, result: 'src' }, f);
    const fi = mk('feImage', { x: 0, y: 0, width: w, height: h, result: 'map', preserveAspectRatio: 'none' }, f);
    fi.setAttribute('href', map.url);
    const dms = [];
    if (kind === 'lip') {
      // ノブは中央が外側を映すので、色を分けると端でサンプルが外に出て色ズレの点が出る。単色で曲げる
      dms.push(mk('feDisplacementMap', { in: 'src', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: 'out' }, f));
    } else {
      ['r', 'g', 'b'].forEach((c, i) => {
        dms.push(mk('feDisplacementMap', { in: 'src', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + c }, f));
        mk('feColorMatrix', { in: 'd' + c, type: 'matrix', values: CH[i], result: c }, f);
      });
      mk('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }, f);
      mk('feBlend', { in: 'rg', in2: 'b', mode: 'screen', result: 'out' }, f);
    }
    // 端で範囲外を拾って抜けた所は、曲げる前の背景で埋める
    mk('feComposite', { in: 'out', in2: 'src', operator: 'over' }, f);
    const out = { id, dms, max: map.max, last: -1 };
    filterCache.set(key, out);
    return out;
  }
  function setDisp(f, ds) {
    if (Math.abs(ds - f.last) < 0.05) return;
    f.last = ds;
    f.dms.forEach((dm, i) => dm.setAttribute('scale', (ds * DISP[i]).toFixed(2)));
  }

  // ============================================================
  // アニメーションループ(動いているものがある間だけ回す)
  // ============================================================
  const active = new Set();
  let raf = 0;
  function kick(a) {
    active.add(a);
    if (!raf) raf = requestAnimationFrame(tick);
  }
  function tick() {
    raf = 0;
    active.forEach(a => { if (!a.step()) active.delete(a); });
    if (active.size) raf = requestAnimationFrame(tick);
  }
  const fx3 = n => n.toFixed(3);

  // ============================================================
  // 丸いボタン
  // ============================================================
  const CAND = 'button,[role="button"],a[href],[onclick],.hbtn,.pbtn,.back-btn,.back-link';
  // 通話系は膨張させない(learnings: scaleでtouchendが別要素で発火してonclickが効かなくなる)
  const NOSCALE = '.phone-btn,.end-btn,.call-control-btn,.call-assist-btn,.accept-btn-glass,.decline-btn-glass,.lg-no-scale';
  const rejected = new WeakSet();
  const states = new WeakMap();

  function roundSize(e) {
    if (e.classList.contains('lg-no-lens') || e.closest('.ts-wrap,.lg-sw')) return 0;
    const w = e.offsetWidth, h = e.offsetHeight;
    if (!w || !h) return 0;
    if (w < 22 || h < 22 || w > 120 || h > 120 || Math.abs(w - h) > 2) { rejected.add(e); return 0; }
    const cs = getComputedStyle(e);
    let br = cs.borderTopLeftRadius || '0';
    br = br.endsWith('%') ? parseFloat(br) * w / 100 : parseFloat(br);
    if (br < w / 2 - 1.5 || cs.visibility === 'hidden') { rejected.add(e); return 0; }
    return w;
  }
  function enhance(e) {
    if (e.classList.contains('lg-round')) return;
    const cs = getComputedStyle(e);
    if (cs.position === 'static') e.style.position = 'relative';
    const base = cs.transform;
    e.style.setProperty('--lg-base', base && base !== 'none' ? base : 'none');
    e.dataset.lgBase = base && base !== 'none' ? base : '';
    e.classList.add('lg-round');
    const fx = document.createElement('span');
    fx.className = 'lg-fx';
    fx.setAttribute('aria-hidden', 'true');
    fx.innerHTML = '<span class="lg-glow"></span><span class="lg-bloom"></span><span class="lg-spec"></span>';
    e.appendChild(fx);
  }
  function scan() {
    document.querySelectorAll(CAND).forEach(e => {
      if (e.classList.contains('lg-round') || rejected.has(e)) return;
      if (roundSize(e)) enhance(e);
    });
  }
  let scanT = 0;
  function scanSoon(ms) { clearTimeout(scanT); scanT = setTimeout(scan, ms || 350); }

  function pressRound(e, ev) {
    let s = states.get(e);
    const w = e.offsetWidth, h = e.offsetHeight;
    if (!s) {
      s = {
        e, w, h, noScale: e.matches(NOSCALE),
        ox: 0, oy: 0, vox: 0, voy: 0, dx: 0, dy: 0, sc: 1, vs: 0, ts: 1, gE: 0, gR: 0.1, gx: w / 2, gy: h / 2,
        pressed: false, pid: null, filter: null, applied: false,
        fx: e.querySelector(':scope > .lg-fx'),
      };
      s.glow = s.fx && s.fx.querySelector('.lg-glow');
      s.step = () => stepRound(s);
      states.set(e, s);
    }
    s.w = w; s.h = h;
    s.pressed = true; s.pid = ev.pointerId;
    s.p0x = ev.clientX; s.p0y = ev.clientY; s.dx = s.dy = 0;
    s.ts = (s.noScale || calm()) ? 1 : 1.22;
    s.gR = 0.08;
    const r = e.getBoundingClientRect();
    s.gx = Math.max(0, Math.min(w, (ev.clientX - r.left) * w / (r.width || w)));
    s.gy = Math.max(0, Math.min(h, (ev.clientY - r.top) * h / (r.height || h)));
    if (CAN_REFRACT && !s.applied) {
      s.filter = getFilter(w, h, Math.round(Math.min(w, h) / 2), 'convex');
      s.prevBF = e.style.getPropertyValue('backdrop-filter');
      s.prevWBF = e.style.getPropertyValue('-webkit-backdrop-filter');
      e.style.setProperty('backdrop-filter', `url(#${s.filter.id}) saturate(1.5)`, 'important');
      e.style.setProperty('-webkit-backdrop-filter', `url(#${s.filter.id}) saturate(1.5)`, 'important');
      s.applied = true;
    }
    if (!s.zSet) { s.prevZ = e.style.zIndex; e.style.zIndex = '60'; s.zSet = true; }
    e.classList.add('lg-live');
    kick(s);
  }

  function stepRound(s) {
    const e = s.e, S = Math.max(s.w, s.h);
    if (calm()) { s.ox = s.oy = 0; s.sc = s.ts; s.vox = s.voy = s.vs = 0; }
    else {
      // もったり: 柔らかいばね + 強めの減衰
      s.vox += (s.dx - s.ox) * 0.09; s.vox *= 0.8; s.ox += s.vox;
      s.voy += (s.dy - s.oy) * 0.09; s.voy *= 0.8; s.oy += s.voy;
      s.vs += (s.ts - s.sc) * 0.09; s.vs *= 0.8; s.sc += s.vs;
    }
    s.gE += ((s.pressed ? 1 : 0) - s.gE) * (s.pressed ? 0.16 : 0.06);
    if (s.pressed) s.gR += (1.7 - s.gR) * 0.05;

    let a = s.sc, c = s.sc, th = 0, tx = 0, ty = 0, r = 0;
    if (!s.noScale && !calm()) {
      const len = Math.hypot(s.ox, s.oy);
      r = len / (len + S * 1.3);
      if (len > 0.01) {
        th = Math.atan2(s.oy, s.ox) * 180 / Math.PI;
        tx = s.ox / len * r * S * 0.24; ty = s.oy / len * r * S * 0.24;
      }
      a = s.sc * (1 + 0.45 * r); c = s.sc * (1 - 0.2 * r);
    }
    const base = e.dataset.lgBase || '';
    e.style.setProperty('transform', `${base} translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) rotate(${th.toFixed(2)}deg) scale(${a.toFixed(4)},${c.toFixed(4)}) rotate(${(-th).toFixed(2)}deg)`, 'important');

    // 押した瞬間に屈折が立ち上がり、離すと引いていく(=materialize)
    const grow = Math.max(0, s.sc - 1) + r * 0.35;
    if (s.filter) setDisp(s.filter, 2 * s.filter.max * 1.6 * (1 + grow * 2.6) * s.gE);
    if (s.glow) {
      if (s.gE > 0.003) {
        const g = s.gE;
        s.glow.style.background = `radial-gradient(circle at ${s.gx.toFixed(1)}px ${s.gy.toFixed(1)}px,rgba(255,255,255,${fx3(0.5 * g)}) 0,rgba(255,255,255,${fx3(0.16 * g)}) ${(s.gR * 45).toFixed(1)}%,rgba(255,255,255,0) ${(s.gR * 100).toFixed(1)}%)`;
      } else s.glow.style.background = '';
    }
    e.style.setProperty('--lg-press', fx3(s.gE));
    if (s.pressed) {
      const ang = (Math.atan2(s.gx - s.w / 2, -(s.gy - s.h / 2)) * 180 / Math.PI + 360) % 360;
      e.style.setProperty('--la', ang.toFixed(1) + 'deg');
    }

    const settled = !s.pressed && Math.abs(s.sc - 1) < 0.002 && Math.abs(s.vs) < 0.001 &&
      Math.hypot(s.ox, s.oy) < 0.3 && Math.hypot(s.vox, s.voy) < 0.05 && s.gE < 0.004;
    if (settled) {
      e.style.removeProperty('transform');
      if (s.applied) {
        e.style.removeProperty('backdrop-filter');
        e.style.removeProperty('-webkit-backdrop-filter');
        if (s.prevBF) e.style.setProperty('backdrop-filter', s.prevBF);
        if (s.prevWBF) e.style.setProperty('-webkit-backdrop-filter', s.prevWBF);
        s.applied = false;
        if (s.filter) setDisp(s.filter, 0);
      }
      if (s.zSet) { e.style.zIndex = s.prevZ || ''; s.zSet = false; }
      if (s.glow) s.glow.style.background = '';
      e.style.removeProperty('--lg-press');
      e.style.removeProperty('--la');
      e.classList.remove('lg-live');
      s.gE = 0; s.sc = 1; s.ox = s.oy = 0;
      return false;
    }
    return true;
  }

  document.addEventListener('pointerdown', ev => {
    if (ev.button > 0) return;
    const e = ev.target.closest && ev.target.closest(CAND);
    if (!e || e.disabled || e.closest('.lg-sw')) return;
    if (!e.classList.contains('lg-round')) {
      if (rejected.has(e) || !roundSize(e)) return;
      enhance(e);
    }
    pressRound(e, ev);
  }, { capture: true, passive: true });

  document.addEventListener('pointermove', ev => {
    active.forEach(s => {
      if (!s.e || !s.pressed || s.pid !== ev.pointerId) return;
      s.dx = ev.clientX - s.p0x; s.dy = ev.clientY - s.p0y;
    });
  }, { passive: true });
  const release = ev => {
    active.forEach(s => {
      if (!s.e || !s.pressed || s.pid !== ev.pointerId) return;
      s.pressed = false; s.ts = 1; s.dx = s.dy = 0;
    });
  };
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  document.addEventListener('click', () => scanSoon(380), { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scanSoon(200); });

  // ============================================================
  // スイッチ (.ts-wrap の中の checkbox をそのまま使う)
  // iOS 26: 横長トラック + 白いピル。触るとノブが透明なガラスになって
  // トラックより大きく膨らみ、ガラス越しに下のトラックが見える。
  // ============================================================
  const TW = 64, TH = 28, KW0 = 39, KH0 = 24, KS = 1.5;
  const KW = Math.round(KW0 * KS), KH = Math.round(KH0 * KS), INS = (TH - KH0) / 2;
  const OFFX = INS + KW0 / 2, ONX = TW - INS - KW0 / 2;
  const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const nativeChecked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');

  function upgradeSwitch(wrap) {
    if (wrap.dataset.lgSw) return;
    const input = wrap.querySelector('input[type="checkbox"]');
    if (!input) return;
    wrap.dataset.lgSw = '1';
    wrap.querySelectorAll('.ts-track').forEach(n => n.remove());

    const root = document.createElement('div');
    root.className = 'lg-sw';
    root.setAttribute('role', 'switch');
    root.tabIndex = 0;
    const label = wrap.closest('.sgrow') && wrap.closest('.sgrow').querySelector('.sgtitle');
    if (label) root.setAttribute('aria-label', label.textContent.trim());
    root.innerHTML = '<div class="lg-sw-track"><i></i></div>' +
      '<div class="lg-sw-knob"><span class="lg-sw-fill"></span><span class="lg-bloom"></span><span class="lg-spec"></span></div>';
    wrap.insertBefore(root, input);
    const trackOn = root.querySelector('.lg-sw-track i');
    const knob = root.querySelector('.lg-sw-knob');
    const fill = root.querySelector('.lg-sw-fill');
    knob.style.width = KW + 'px'; knob.style.height = KH + 'px';
    knob.style.top = ((TH - KH) / 2) + 'px';

    const on0 = nativeChecked.get.call(input);
    const s = {
      on: on0, x: on0 ? ONX : OFFX, vx: 0, sc: 1 / KS, vs: 0, ts: 1 / KS, g: 0,
      pressed: false, moved: 0, drag: 0, filter: null, applied: false,
    };

    function render() {
      const st = calm() ? 0 : Math.min(0.22, Math.abs(s.vx) * 0.035);
      const a = s.sc * (1 + st), c = s.sc * (1 - st * 0.5);
      knob.style.transform = `translateX(${(s.x - KW / 2).toFixed(2)}px) scale(${a.toFixed(4)},${c.toFixed(4)})`;
      const p = (s.x - OFFX) / (ONX - OFFX);
      trackOn.style.opacity = fx3(sstep(0.25, 0.75, p));
      // g: ガラスになる度合い。白が抜けて屈折・縁の光・影が立ち上がる
      fill.style.opacity = fx3(1 - s.g * 0.95);
      knob.style.setProperty('--lg-press', fx3(s.g));
      if (s.filter) setDisp(s.filter, 2 * s.filter.max * 1.2 * s.g);
    }
    function setOn(v, fire) {
      s.on = v;
      root.setAttribute('aria-checked', v ? 'true' : 'false');
      if (nativeChecked.get.call(input) !== v) {
        nativeChecked.set.call(input, v);
        if (fire) input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      kick(s);
    }
    // 他のコードが input.checked = x で書き換えてもノブが追従するように
    try {
      Object.defineProperty(input, 'checked', {
        configurable: true,
        get() { return nativeChecked.get.call(this); },
        set(v) { nativeChecked.set.call(this, v); if (s.on !== !!v) { s.on = !!v; root.setAttribute('aria-checked', v ? 'true' : 'false'); kick(s); } },
      });
    } catch (e) { /* 古い環境では追従しないだけ */ }
    input.addEventListener('change', () => { const v = nativeChecked.get.call(input); if (v !== s.on) { s.on = v; kick(s); } });

    s.step = () => {
      const tgt = s.pressed ? s.drag : (s.on ? ONX : OFFX);
      if (calm()) { s.x = tgt; s.vx = 0; s.sc = s.ts; s.vs = 0; s.g = s.pressed ? 1 : 0; }
      else {
        s.vx += (tgt - s.x) * 0.1; s.vx *= 0.78; s.x += s.vx;
        s.vs += (s.ts - s.sc) * 0.09; s.vs *= 0.78; s.sc += s.vs;
        s.g += ((s.pressed ? 1 : 0) - s.g) * (s.pressed ? 0.14 : 0.08);
      }
      render();
      const settled = !s.pressed && Math.abs(s.x - tgt) < 0.05 && Math.abs(s.vx) < 0.02 &&
        Math.abs(s.sc - s.ts) < 0.002 && Math.abs(s.vs) < 0.001 && s.g < 0.004;
      if (settled) {
        s.x = tgt; s.sc = s.ts; s.g = 0; render();
        if (s.applied) {
          knob.style.removeProperty('backdrop-filter');
          knob.style.removeProperty('-webkit-backdrop-filter');
          s.applied = false;
        }
        root.classList.remove('lg-live');
        return false;
      }
      return true;
    };

    root.addEventListener('pointerdown', ev => {
      if (ev.button > 0) return;
      try { root.setPointerCapture(ev.pointerId); } catch (e) { }
      s.pressed = true; s.moved = 0; s.p0 = ev.clientX;
      s.start = s.on ? ONX : OFFX; s.drag = s.start; s.ts = 1;
      if (CAN_REFRACT && !s.applied) {
        s.filter = getFilter(KW, KH, KH / 2, 'lip');
        knob.style.setProperty('backdrop-filter', `url(#${s.filter.id}) saturate(1.4)`);
        knob.style.setProperty('-webkit-backdrop-filter', `url(#${s.filter.id}) saturate(1.4)`);
        s.applied = true;
      }
      root.classList.add('lg-live');
      if (window.LiquidGlass && LiquidGlass.haptic) LiquidGlass.haptic('selection');
      kick(s);
    });
    root.addEventListener('pointermove', ev => {
      if (!s.pressed) return;
      const dx = ev.clientX - s.p0;
      s.moved = Math.max(s.moved, Math.abs(dx));
      let raw = s.start + dx;
      if (raw > ONX) raw = ONX + (raw - ONX) * 0.22;
      if (raw < OFFX) raw = OFFX + (raw - OFFX) * 0.22;
      s.drag = raw;
    });
    const up = () => {
      if (!s.pressed) return;
      s.pressed = false; s.ts = 1 / KS;
      setOn(s.moved < 4 ? !s.on : s.x > (OFFX + ONX) / 2, true);
    };
    root.addEventListener('pointerup', up);
    root.addEventListener('pointercancel', up);
    root.addEventListener('click', ev => ev.stopPropagation());
    root.addEventListener('keydown', ev => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); setOn(!s.on, true); }
    });

    root.setAttribute('aria-checked', s.on ? 'true' : 'false');
    render();
  }
  function upgradeSwitches() { document.querySelectorAll('.ts-wrap').forEach(upgradeSwitch); }

  function init() {
    upgradeSwitches();
    scan();
    // 遅れて描画されるボタン用にもう一度だけ
    setTimeout(scan, 1200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.LGControls = { scan, upgradeSwitches, enhance };
})();
