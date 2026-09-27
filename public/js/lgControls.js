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
// 数値・見た目はデモ(Liquid Glass v2.2.0 artifact)と同じにしてある。
// 屈折は普段から付けっぱなし(デモと同じ)。バッテリーセーバー時のアニメーション軽減が
// オンのときだけ、屈折と動きを切って軽くする。
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
    const N = 160, T0 = Hh * 0.2, prof = new Float32Array(N + 1);
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
  // 変位マップ(重い計算)は同じ(幅,高さ,角丸,断面)なら使い回す。
  // フィルタ要素はボタンごとに1個(押したボタンだけ屈折を強めるため)
  const mapCache = new Map();
  let fid = 0;
  function getFilter(w, h, rad, kind) {
    const key = w + 'x' + h + 'r' + rad + kind;
    let map = mapCache.get(key);
    if (!map) { map = buildMap(w, h, rad, kind); mapCache.set(key, map); }
    const id = 'lgc-f' + (fid++);
    const f = mk('filter', { id, x: 0, y: 0, width: w, height: h, filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse', 'color-interpolation-filters': 'sRGB' }, ensureDefs());
    const fi = mk('feImage', { x: 0, y: 0, width: w, height: h, result: 'map', preserveAspectRatio: 'none' }, f);
    fi.setAttribute('href', map.url);
    const dms = [];
    if (kind === 'lip') {
      // ノブは中央が外側を映すので、色を分けると端でサンプルが外に出て色ズレの点が出る。単色で曲げる
      dms.push(mk('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: 'out' }, f));
    } else {
      ['r', 'g', 'b'].forEach((c, i) => {
        dms.push(mk('feDisplacementMap', { in: 'SourceGraphic', in2: 'map', scale: 0, xChannelSelector: 'R', yChannelSelector: 'G', result: 'd' + c }, f));
        mk('feColorMatrix', { in: 'd' + c, type: 'matrix', values: CH[i], result: c }, f);
      });
      mk('feBlend', { in: 'r', in2: 'g', mode: 'screen', result: 'rg' }, f);
      mk('feBlend', { in: 'rg', in2: 'b', mode: 'screen', result: 'out' }, f);
    }
    // 端で範囲外を拾って抜けた所は、曲げる前の背景で埋める
    mk('feComposite', { in: 'out', in2: 'SourceGraphic', operator: 'over', result: 'filled' }, f);
    mk('feGaussianBlur', { in: 'filled', stdDeviation: 0.7 }, f);
    return { id, dms, max: map.max, last: -1, node: f };
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
  // 光源: 端末の傾きで縁の光が回る(デモと同じ。PCはマウスの方向)
  // ============================================================
  let lightAng = 315, lastLa = -1, laRaf = 0, askedMotion = false;
  function setLight(a) {
    lightAng = a;
    if (laRaf) return;
    laRaf = requestAnimationFrame(() => {
      laRaf = 0;
      if (Math.abs(lightAng - lastLa) > 0.5) { lastLa = lightAng; document.documentElement.style.setProperty('--la', lightAng.toFixed(1) + 'deg'); }
    });
  }
  function listenMotion() {
    addEventListener('deviceorientation', e => {
      if (e.gamma == null || calm()) return;
      const lx = -(e.gamma || 0) / 40, ly = ((e.beta || 0) - 55) / 40;
      const a = (Math.atan2(lx, -ly) * 180 / Math.PI + 360) % 360;
      const d = ((a - lightAng + 540) % 360) - 180;
      setLight((lightAng + d * 0.15 + 360) % 360);
    });
  }
  function askMotion() {
    if (askedMotion) return; askedMotion = true;
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') D.requestPermission().then(r => { if (r === 'granted') listenMotion(); }).catch(() => {});
  }
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission !== 'function') listenMotion();

  // ============================================================
  // 丸いボタン
  // ============================================================
  const CAND = 'button,[role="button"],a[href],[onclick],.hbtn,.pbtn,.back-btn,.back-link';
  // 通話系は膨張させない(learnings: scaleでtouchendが別要素で発火してonclickが効かなくなる)
  const NOSCALE = '.phone-btn,.end-btn,.call-control-btn,.call-assist-btn,.accept-btn-glass,.decline-btn-glass,.lg-no-scale';
  const GAIN = 1.8;
  const rejected = new WeakSet();
  const states = new WeakMap();
  const rounds = new Set();
  const t0 = performance.now();

  // 除外: 入力欄の＋と送信(従来の見た目のまま)、アバター(ボタンではなく写真)
  const EXCLUDE = '.ts-wrap,.lg-sw,.input-bar-container,.input-floating-bar,.ibc,.ibar,.plus-btn,.glass-send-btn,.glass-btn,.lg-no-lens';
  const AVATAR = /(^|\s)[a-z-]*(av|avatar)(\s|$)/i;
  function roundSize(e) {
    if (e.closest(EXCLUDE) || AVATAR.test(e.className || '')) { rejected.add(e); return 0; }
    const w = e.offsetWidth, h = e.offsetHeight;
    if (!w || !h) return 0;
    if (w < 22 || h < 22 || w > 120 || h > 120 || Math.abs(w - h) > 2) { rejected.add(e); return 0; }
    const cs = getComputedStyle(e);
    let br = cs.borderTopLeftRadius || '0';
    br = br.endsWith('%') ? parseFloat(br) * w / 100 : parseFloat(br);
    if (br < w / 2 - 1.5 || cs.visibility === 'hidden' || (cs.backgroundImage || '').indexOf('url(') >= 0) { rejected.add(e); return 0; }
    return w;
  }
  // 親がすでにbackdrop-filterを持っていると入れ子になってチカチカする(learnings)。その場合は屈折を付けない
  function nestedBackdrop(e) {
    for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
      const b = getComputedStyle(p).backdropFilter || getComputedStyle(p).webkitBackdropFilter;
      if (b && b !== 'none') return true;
    }
    return false;
  }
  function parseRGB(str) {
    const m = str && str.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+%?))?/);
    if (!m) return null;
    let a = m[4] == null ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]));
    return { r: +m[1], g: +m[2], b: +m[3], a };
  }
  // 元のボタンの色から、デモと同じ「色付きガラス(α.62)」か「透明ガラス」かを決める
  function material(e, cs) {
    const img = cs.backgroundImage || 'none';
    if (img.indexOf('url(') >= 0) return { photo: true };
    let c = parseRGB(cs.backgroundColor);
    if ((!c || c.a < 0.35) && img.indexOf('gradient') >= 0) c = parseRGB(img);
    if (c && c.a >= 0.35) {
      const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
      if (mx - mn > 40) return { tint: `rgba(${c.r},${c.g},${c.b},.62)` };
    }
    return { clear: true };
  }

  function enhance(e, materialize) {
    if (e.classList.contains('lg-round')) return states.get(e);
    const cs = getComputedStyle(e);
    if (cs.position === 'static') e.style.position = 'relative';
    const base = cs.transform && cs.transform !== 'none' ? cs.transform : '';
    e.style.setProperty('--lg-base', base || 'none');
    e.dataset.lgBase = base;
    const mat = material(e, cs);
    if (mat.photo) e.classList.add('lg-photo');
    else if (mat.tint) { e.classList.add('lg-tinted'); e.style.setProperty('--lg-tint', mat.tint); }
    else e.classList.add('lg-clear');
    e.classList.add('lg-round');

    const fx = document.createElement('span');
    fx.className = 'lg-fx';
    fx.setAttribute('aria-hidden', 'true');
    fx.innerHTML = '<span class="lg-fxclip"><span class="lg-glow"></span><span class="lg-nglow"></span></span><span class="lg-bloom"></span><span class="lg-spec"></span><span class="lg-rim"></span>';
    e.appendChild(fx);

    const w = e.offsetWidth, h = e.offsetHeight;
    const s = {
      e, w, h, noScale: e.matches(NOSCALE),
      ox: 0, oy: 0, vox: 0, voy: 0, dx: 0, dy: 0, sc: 1, vs: 0, ts: 1,
      gE: 0, gR: 0.1, gx: w / 2, gy: h / 2, pressed: false, pid: null, moved: 0,
      glow: fx.querySelector('.lg-glow'), nglow: fx.querySelector('.lg-nglow'),
      filter: null, mat: 1, born: 0, started: true, nb: [], lit: false,
    };
    s.step = () => stepRound(s);
    states.set(e, s); rounds.add(s);
    if (CAN_REFRACT && !mat.photo && !calm() && !nestedBackdrop(e)) {
      s.filter = getFilter(w, h, Math.round(Math.min(w, h) / 2), 'convex');
      e.style.setProperty('backdrop-filter', `url(#${s.filter.id}) saturate(1.5) brightness(1.05)`, 'important');
      e.style.setProperty('-webkit-backdrop-filter', `url(#${s.filter.id}) saturate(1.5) brightness(1.05)`, 'important');
    }
    // 出現: フェードではなく、屈折を強めながら膨らんで「現れる」(デモと同じ)
    if (materialize && !calm()) {
      s.born = performance.now(); s.mat = 0; s.sc = 0.6; s.ts = 0.6; s.started = false;
      e.style.opacity = '0';
      kick(s);
    } else {
      s.mat = 1;
      if (s.filter) setDisp(s.filter, 2 * s.filter.max * GAIN);
    }
    return s;
  }
  function scan(materialize) {
    document.querySelectorAll(CAND).forEach(e => {
      if (e.classList.contains('lg-round') || rejected.has(e)) return;
      if (roundSize(e)) enhance(e, materialize);
    });
  }
  let scanT = 0;
  function scanSoon(ms) { clearTimeout(scanT); scanT = setTimeout(() => scan(true), ms || 350); }

  function pressRound(s, ev) {
    const e = s.e;
    askMotion();
    s.pressed = true; s.pid = ev.pointerId; s.moved = 0;
    s.p0x = ev.clientX; s.p0y = ev.clientY; s.dx = s.dy = 0;
    s.ts = (s.noScale || calm()) ? 1 : 1.22;
    s.gR = 0.08;
    const r = e.getBoundingClientRect();
    s.gx = Math.max(0, Math.min(s.w, (ev.clientX - r.left) * s.w / (r.width || s.w)));
    s.gy = Math.max(0, Math.min(s.h, (ev.clientY - r.top) * s.h / (r.height || s.h)));
    // 押した光が映る近くの丸ボタン(デモと同じく中心距離で減衰)
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2, S = Math.max(s.w, s.h);
    s.nb = [];
    rounds.forEach(o => {
      if (o === s || !o.e.isConnected) return;
      const q = o.e.getBoundingClientRect();
      if (!q.width) return;
      const ox = q.left + q.width / 2, oy = q.top + q.height / 2, d = Math.hypot(ox - cx, oy - cy);
      if (d > S * 4.2) return;
      // oから見た「押されたボタン側」の縁の位置
      s.nb.push({ o, d, px: o.w / 2 + (cx - ox) / d * o.w * 0.5, py: o.h / 2 + (cy - oy) / d * o.h * 0.5 });
    });
    if (!s.zSet) { s.prevZ = e.style.zIndex; e.style.zIndex = '60'; s.zSet = true; }
    e.classList.add('lg-live');
    kick(s);
  }

  function stepRound(s) {
    const e = s.e, S = Math.max(s.w, s.h), now = performance.now();
    if (!s.started) {
      s.mat = Math.max(0, Math.min(1, (now - s.born - 200) / 700));
      if (s.mat > 0) { s.started = true; e.style.opacity = ''; if (!s.pressed) s.ts = 1; }
    }
    const me = 1 - Math.pow(1 - s.mat, 3);
    if (calm()) { s.ox = s.oy = 0; s.sc = s.ts > 1 ? 1 : s.ts; s.vox = s.voy = s.vs = 0; }
    else {
      s.vox += (s.dx - s.ox) * 0.09; s.vox *= 0.8; s.ox += s.vox;
      s.voy += (s.dy - s.oy) * 0.09; s.voy *= 0.8; s.oy += s.voy;
      s.vs += (s.ts - s.sc) * 0.09; s.vs *= 0.8; s.sc += s.vs;
    }
    s.gE += ((s.pressed ? 1 : 0) - s.gE) * (s.pressed ? 0.16 : 0.05);
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
    } else if (s.noScale) { a = c = 1; }
    const base = e.dataset.lgBase || '';
    e.style.setProperty('transform', `${base} translate(${tx.toFixed(2)}px,${ty.toFixed(2)}px) rotate(${th.toFixed(2)}deg) scale(${a.toFixed(4)},${c.toFixed(4)}) rotate(${(-th).toFixed(2)}deg)`, 'important');

    // 大きく・長く伸びるほど厚いガラス扱い: 屈折と影を強める
    const grow = Math.max(0, s.sc - 1) + r * 0.35;
    if (s.filter) setDisp(s.filter, 2 * s.filter.max * GAIN * (1 + grow * 2.6) * me);
    e.style.setProperty('--sh', (0.25 + grow * 1.1).toFixed(3));

    if (s.gE > 0.002) {
      const g = s.gE;
      s.glow.style.background = `radial-gradient(circle at ${s.gx.toFixed(1)}px ${s.gy.toFixed(1)}px,rgba(255,255,255,${fx3(0.5 * g)}) 0,rgba(255,255,255,${fx3(0.16 * g)}) ${(s.gR * 45).toFixed(1)}%,rgba(255,255,255,0) ${(s.gR * 100).toFixed(1)}%)`;
      s.nb.forEach(n => {
        const w = Math.max(0, 1 - (n.d - S) / (S * 3)) * g * 0.42;
        n.o.nglow.style.background = w > 0.004 ? `radial-gradient(circle at ${n.px.toFixed(1)}px ${n.py.toFixed(1)}px,rgba(255,255,255,${fx3(w)}),rgba(255,255,255,0) 70%)` : '';
      });
    } else if (s.glow.style.background) {
      s.glow.style.background = '';
      s.nb.forEach(n => { n.o.nglow.style.background = ''; });
    }

    const settled = s.started && s.mat >= 1 && !s.pressed && Math.abs(s.sc - 1) < 0.002 && Math.abs(s.vs) < 0.001 &&
      Math.hypot(s.ox, s.oy) < 0.3 && Math.hypot(s.vox, s.voy) < 0.05 && s.gE < 0.004;
    if (settled) {
      e.style.removeProperty('transform');
      e.style.removeProperty('--sh');
      if (s.filter) setDisp(s.filter, 2 * s.filter.max * GAIN);
      if (s.zSet) { e.style.zIndex = s.prevZ || ''; s.zSet = false; }
      s.glow.style.background = '';
      s.nb.forEach(n => { n.o.nglow.style.background = ''; }); s.nb = [];
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
    let s = states.get(e);
    if (!s) {
      if (rejected.has(e) || !roundSize(e)) return;
      s = enhance(e, false);
    }
    pressRound(s, ev);
  }, { capture: true, passive: true });

  document.addEventListener('pointermove', ev => {
    active.forEach(s => {
      if (!s.e || !s.pressed || s.pid !== ev.pointerId) return;
      s.dx = ev.clientX - s.p0x; s.dy = ev.clientY - s.p0y;
      s.moved = Math.max(s.moved, Math.hypot(s.dx, s.dy));
    });
  }, { passive: true });
  // 大きく引っぱってから離したらタップ扱いにしない(デモ・iOSと同じ)
  let suppress = null;
  const release = ev => {
    active.forEach(s => {
      if (!s.e || !s.pressed || s.pid !== ev.pointerId) return;
      s.pressed = false; s.ts = 1; s.dx = s.dy = 0;
      if (s.moved >= Math.max(s.w, s.h) * 0.6) { suppress = s.e; setTimeout(() => { if (suppress === s.e) suppress = null; }, 400); }
    });
  };
  document.addEventListener('pointerup', release, { passive: true });
  document.addEventListener('pointercancel', release, { passive: true });
  window.addEventListener('click', ev => {
    if (suppress && ev.target && suppress.contains(ev.target)) {
      ev.stopImmediatePropagation(); ev.preventDefault(); suppress = null;
    }
  }, true);
  document.addEventListener('click', () => scanSoon(380), { passive: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scanSoon(200); });
  addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    // PC: 画面中央から見たマウスの方向を光源にする
    setLight((Math.atan2(e.clientX - innerWidth / 2, -(e.clientY - innerHeight / 2)) * 180 / Math.PI + 360) % 360);
  }, { passive: true });

  // ============================================================
  // スイッチ (.ts-wrap の中の checkbox をそのまま使う)
  // iOS 26: 横長トラック + 白いピル。触るとノブが透明なガラスになって
  // トラックより大きく膨らみ、ガラス越しに下のトラックが見える。
  // ============================================================
  const TW = 79, TH = 35, KW0 = 49, KH0 = 30, KS = 1.45;
  const KW = Math.round(KW0 * KS), KH = Math.round(KH0 * KS), INS = (TH - KH0) / 2;
  const OFFX = INS + KW0 / 2, ONX = TW - INS - KW0 / 2;
  const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
  const nativeChecked = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');

  function upgradeSwitch(wrap) {
    if (wrap.dataset.lgSw) return;
    const input = wrap.matches('input') ? wrap : wrap.querySelector('input[type="checkbox"]');
    if (!input) return;
    if (input !== wrap) wrap.querySelectorAll('.ts-track').forEach(n => n.remove());
    else { wrap = input.parentElement; input.style.display = 'none'; }
    wrap.dataset.lgSw = '1';

    const root = document.createElement('div');
    root.className = 'lg-sw';
    root.setAttribute('role', 'switch');
    root.tabIndex = 0;
    const row = wrap.closest('.sgrow');
    const label = row ? row.querySelector('.sgtitle') : wrap.querySelector('span');
    if (label) root.setAttribute('aria-label', label.textContent.trim());
    root.innerHTML = '<div class="lg-sw-track"><i></i></div>' +
      '<div class="lg-sw-knob"><span class="lg-sw-tint"></span><span class="lg-bloom"></span><span class="lg-spec"></span><span class="lg-rim"></span><span class="lg-sw-fill"></span></div>';
    wrap.insertBefore(root, input);
    const trackOn = root.querySelector('.lg-sw-track i');
    const knob = root.querySelector('.lg-sw-knob');
    const fill = root.querySelector('.lg-sw-fill');
    knob.style.width = KW + 'px'; knob.style.height = KH + 'px';
    knob.style.top = ((TH - KH) / 2) + 'px';

    const on0 = nativeChecked.get.call(input);
    // 出現はボタンと同じタイミング
    const born = performance.now();
    const me = () => { const m = Math.max(0, Math.min(1, (performance.now() - born - 200) / 700)); return calm() ? 1 : 1 - Math.pow(1 - m, 3); };
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
      knob.style.setProperty('--so', fx3(s.g));
      knob.style.setProperty('--sh', (0.18 + s.g * 0.16).toFixed(3));
      if (s.filter) setDisp(s.filter, 2 * s.filter.max * 1.2 * s.g * me());
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
    input.addEventListener('change', () => { const v = nativeChecked.get.call(input); if (v !== s.on) { s.on = v; root.setAttribute('aria-checked', v ? 'true' : 'false'); kick(s); } });

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
      askMotion();
      try { root.setPointerCapture(ev.pointerId); } catch (e) { }
      s.pressed = true; s.moved = 0; s.p0 = ev.clientX;
      s.start = s.on ? ONX : OFFX; s.drag = s.start; s.ts = 1;
      if (CAN_REFRACT && !s.applied && !calm()) {
        if (!s.filter) s.filter = getFilter(KW, KH, KH / 2, 'lip');
        knob.style.setProperty('backdrop-filter', `url(#${s.filter.id}) saturate(1.4) brightness(1.04)`);
        knob.style.setProperty('-webkit-backdrop-filter', `url(#${s.filter.id}) saturate(1.4) brightness(1.04)`);
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
    root.addEventListener('click', ev => { ev.stopPropagation(); ev.preventDefault(); });
    root.addEventListener('keydown', ev => {
      if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); setOn(!s.on, true); }
    });

    root.setAttribute('aria-checked', s.on ? 'true' : 'false');
    render();
  }
  function upgradeSwitches() { document.querySelectorAll('.ts-wrap, input.ios-switch').forEach(upgradeSwitch); }

  function init() {
    upgradeSwitches();
    scan(true);
    // 遅れて描画されるボタン用にもう一度だけ
    setTimeout(() => scan(true), 1200);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.LGControls = { scan, upgradeSwitches, enhance };
})();
