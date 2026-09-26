// spring.js — Core Animation (CASpringAnimation) と同じ物理のスプリング。
//   mass / stiffness / damping で動きを決め、途中で掴み直されても速度を引き継ぐ(Fluid)。
//   全て transform / opacity だけを動かす前提。
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

  window.BroSpring = { PRESETS, animate, velocityTracker, fuse };
})();
