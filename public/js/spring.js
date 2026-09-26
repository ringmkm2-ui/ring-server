// spring.js — Core Animation (CASpringAnimation) と同じ物理のスプリング。
//   mass / stiffness / damping で動きを決め、途中で掴み直されても速度を引き継ぐ(Fluid)。
//   全て transform / opacity だけを動かす前提。
// 設定の「文字サイズ」を全ページに反映(--bc-fs を倍率として使う)
(function () {
  const fs = parseFloat(localStorage.getItem('fontScale') || '1') || 1;
  document.documentElement.style.setProperty('--bc-fs', String(fs));
})();

(function () {
  const PRESETS = {
    bouncy: { stiffness: 300, damping: 18, mass: 1 },
    snappy: { stiffness: 520, damping: 34, mass: 1 },
    smooth: { stiffness: 220, damping: 28, mass: 1 },
    gentle: { stiffness: 140, damping: 17, mass: 1 },
  };
  const reduce = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 減衰振動の解析解。x = 目標からのずれ, v = 速度(単位/秒)。t秒後の {x, v} を返す
  function makeSolver(p, x0, v0) {
    const m = p.mass || 1, k = p.stiffness, c = p.damping;
    const w0 = Math.sqrt(k / m), z = c / (2 * Math.sqrt(k * m));
    let pos;
    if (z < 1) {
      const wd = w0 * Math.sqrt(1 - z * z), B = (v0 + z * w0 * x0) / wd;
      pos = t => Math.exp(-z * w0 * t) * (x0 * Math.cos(wd * t) + B * Math.sin(wd * t));
    } else if (Math.abs(z - 1) < 1e-6) {
      pos = t => (x0 + (v0 + w0 * x0) * t) * Math.exp(-w0 * t);
    } else {
      const s = Math.sqrt(z * z - 1), r1 = -w0 * (z - s), r2 = -w0 * (z + s);
      const C1 = (v0 - r2 * x0) / (r1 - r2), C2 = x0 - C1;
      pos = t => C1 * Math.exp(r1 * t) + C2 * Math.exp(r2 * t);
    }
    return t => ({ x: pos(t), v: (pos(t + 0.001) - pos(t)) / 0.001 });
  }

  /**
   * 値を from → to へスプリングで動かす。
   * velocity: 開始時の速度(単位/秒)。指で弾いた勢いをそのまま渡すと自然に続く。
   * 戻り値の stop() で止めると、その瞬間の値と速度を返す(掴み直しに使う)。
   */
  function animate(opts) {
    const p = typeof opts.spring === 'string' ? PRESETS[opts.spring] : (opts.spring || PRESETS.smooth);
    const from = opts.from, to = opts.to;
    if (reduce() || from === to) { opts.onUpdate && opts.onUpdate(to); opts.onComplete && opts.onComplete(); return { stop: () => ({ value: to, velocity: 0 }) }; }
    const solve = makeSolver(p, from - to, opts.velocity || 0);
    const start = performance.now();
    let raf = 0, last = { x: from - to, v: opts.velocity || 0 }, done = false;
    const eps = Math.max(Math.abs(from - to) * 0.001, 0.01);
    function frame(now) {
      const t = (now - start) / 1000;
      last = solve(t);
      if (Math.abs(last.x) < eps && Math.abs(last.v) < eps * 10) {
        done = true;
        opts.onUpdate && opts.onUpdate(to);
        opts.onComplete && opts.onComplete();
        return;
      }
      opts.onUpdate && opts.onUpdate(to + last.x, last.v);
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return {
      stop() { cancelAnimationFrame(raf); return { value: done ? to : to + last.x, velocity: done ? 0 : last.v }; },
    };
  }

  /** 指の動きから離した瞬間の速度(単位/秒)を出す */
  function velocityTracker() {
    const samples = [];
    return {
      add(v) { const t = performance.now(); samples.push({ v, t }); while (samples.length && t - samples[0].t > 100) samples.shift(); },
      get() {
        if (samples.length < 2) return 0;
        const a = samples[0], b = samples[samples.length - 1];
        const dt = (b.t - a.t) / 1000;
        return dt > 0 ? (b.v - a.v) / dt : 0;
      },
      reset() { samples.length = 0; },
    };
  }

  /**
   * Fluid Fusion: 要素を「元いた場所(fromRect)」から今の位置へ、形ごと溶け込むように移す(FLIP)。
   * 送信した吹き出しが入力欄から飛び出して所定の位置に収まる、などに使う。
   */
  function fuse(el, fromRect, opts = {}) {
    if (!el || !fromRect || reduce()) return;
    const to = el.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = fromRect.left - to.left, dy = fromRect.top - to.top;
    const sx = fromRect.width / to.width, sy = fromRect.height / to.height;
    const origin = el.style.transformOrigin;
    el.style.transformOrigin = '0 0';
    el.style.willChange = 'transform, opacity';
    animate({
      spring: opts.spring || 'smooth', from: 1, to: 0,
      onUpdate: k => {
        el.style.transform = `translate(${dx * k}px, ${dy * k}px) scale(${1 + (sx - 1) * k}, ${1 + (sy - 1) * k})`;
        if (opts.fade) el.style.opacity = String(Math.min(1, 1 - k * 0.6));
      },
      onComplete: () => {
        el.style.transform = ''; el.style.transformOrigin = origin; el.style.willChange = '';
        if (opts.fade) el.style.opacity = '';
        opts.onComplete && opts.onComplete();
      },
    });
  }

  /**
   * iOS 26: メニューが押したボタン/吹き出しの形から溶け出すように伸びて広がる(Liquid Glassのモーフ)。
   * clip-path で押した物の矩形から切り抜きを広げていく。レイアウトは動かさない。
   */
  function morphOpen(menu, fromRect, opts = {}) {
    if (!menu || !fromRect || reduce()) return;
    const to = menu.getBoundingClientRect();
    if (!to.width) return;
    const r0 = opts.radius0 != null ? opts.radius0 : Math.min(fromRect.height / 2, 22);
    const r1 = opts.radius1 != null ? opts.radius1 : 24;
    // メニュー座標系での開始矩形(はみ出しは0に丸める)
    const top0 = Math.max(0, fromRect.top - to.top), left0 = Math.max(0, fromRect.left - to.left);
    const right0 = Math.max(0, to.right - fromRect.right), bottom0 = Math.max(0, to.bottom - fromRect.bottom);
    menu.style.willChange = 'clip-path';
    animate({
      spring: opts.spring || 'smooth', from: 1, to: 0,
      onUpdate: k => {
        const kk = Math.max(0, k); // 行き過ぎ(負)で切り抜きが反転しないように
        menu.style.clipPath = `inset(${top0 * kk}px ${right0 * kk}px ${bottom0 * kk}px ${left0 * kk}px round ${r1 + (r0 - r1) * kk}px)`;
      },
      onComplete: () => { menu.style.clipPath = ''; menu.style.willChange = ''; },
    });
  }

  /**
   * iOS 26 Liquid Glass: 押したガラスの中で、指の位置から光がにじむ(指を動かすと光もついてくる)。
   * 光はボタンの形に合わせた別要素(pointer-events:none)なので当たり判定は変わらない。
   * ボタン自体の拡大/明るさは各ボタンのCSSのまま(全幅・通話ボタンは拡大しないルールもそのまま)。
   */
  const LIGHT_SEL = '.glass-interactive, .glass-icon-btn, .glass-plus-btn, .glass-send-btn, .plus-btn, .sibtn, .action-btn, .hbtn, .cbtn, .pbtn, .back-link, .back, .call-control-btn, .end-btn, .phone-btn, .call-assist-btn, .mm-close, .sbtn, .ctx-btn';
  function attachTouchLight() {
    document.addEventListener('pointerdown', e => {
      if (reduce()) return;
      const btn = e.target.closest && e.target.closest(LIGHT_SEL);
      if (!btn || btn.disabled) return;
      const cs = getComputedStyle(btn);
      const light = document.createElement('div');
      light.className = 'bc-touch-light';
      light.style.borderRadius = cs.borderRadius;
      document.body.appendChild(light);
      let px = e.clientX, py = e.clientY, alive = true;
      // ボタンがCSSで膨らんでも光がぴったり重なるよう、押している間は毎フレーム追従
      (function follow() {
        if (!alive) return;
        const r = btn.getBoundingClientRect();
        light.style.left = r.left + 'px'; light.style.top = r.top + 'px';
        light.style.width = r.width + 'px'; light.style.height = r.height + 'px';
        light.style.setProperty('--lx', (px - r.left) + 'px');
        light.style.setProperty('--ly', (py - r.top) + 'px');
        requestAnimationFrame(follow);
      })();
      requestAnimationFrame(() => { light.style.opacity = '1'; });
      const move = ev => { px = ev.clientX; py = ev.clientY; };
      const release = () => {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', release, true);
        document.removeEventListener('pointercancel', release, true);
        light.style.opacity = '0';
        setTimeout(() => { alive = false; light.remove(); }, 380);
      };
      document.addEventListener('pointermove', move, { capture: true, passive: true });
      document.addEventListener('pointerup', release, true);
      document.addEventListener('pointercancel', release, true);
    }, { passive: true, capture: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attachTouchLight);
  else attachTouchLight();

  window.BroSpring = { PRESETS, animate, velocityTracker, fuse, morphOpen };
})();
