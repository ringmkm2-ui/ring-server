// トークを開いた直後に別の所へ行った時、220ms後の遷移が取り消されるか。
// 取り消されないと、出ていったはずのトークに引き戻される(v1.28.236で pointerdown だけ直したが、
// 端末の「戻る」は pointerdown を起こさないので素通りしていた)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function el(extra = {}) {
  const listeners = {};
  return {
    style: {}, className: '', textContent: '',
    dataset: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    getBoundingClientRect: () => ({ top: 10, left: 10, width: 40, height: 40 }),
    appendChild() {}, remove() {}, removeChild() {}, insertBefore() {},
    querySelector: () => null, querySelectorAll: () => [],
    closest: () => null,
    addEventListener: (t, f) => { (listeners[t] = listeners[t] || []).push(f); },
    removeEventListener: (t, f) => { if (listeners[t]) listeners[t] = listeners[t].filter(x => x !== f); },
    __listeners: listeners,
    ...extra,
  };
}

function load() {
  const docL = {}, winL = {};
  const store = {};
  const doc = Object.assign(el(), {
    hidden: false,
    documentElement: Object.assign(el(), { style: { setProperty() {} } }),
    body: el(),
    createElement: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, f) => { (docL[t] = docL[t] || []).push(f); },
    removeEventListener: (t, f) => { if (docL[t]) docL[t] = docL[t].filter(x => x !== f); },
    readyState: 'complete',
  });
  const win = {
    addEventListener: (t, f) => { (winL[t] = winL[t] || []).push(f); },
    removeEventListener: (t, f) => { if (winL[t]) winL[t] = winL[t].filter(x => x !== f); },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => ({ fontSize: '15px', backgroundColor: '#fff', getPropertyValue: () => '0' }),
    requestAnimationFrame: fn => { fn(); return 1; },
    stop() {},
    innerWidth: 390, innerHeight: 844,
    location: { href: '' },
    navigator: { userAgent: 'test' },
  };
  const timers = [];
  const ctx = {
    window: win, document: doc, navigator: win.navigator,
    getComputedStyle: win.getComputedStyle,
    requestAnimationFrame: win.requestAnimationFrame,
    matchMedia: win.matchMedia,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: id => { if (timers[id - 1]) timers[id - 1].cancelled = true; },
    setInterval: () => 0, clearInterval() {},
    sessionStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    console,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/liquidGlass.js'), 'utf8'), ctx);
  // 220msの遷移タイマーだけを進める
  const runFlightTimer = () => {
    const t = timers.find(x => x.ms === 220 && !x.cancelled && !x.done);
    if (!t) return false;
    t.done = true; t.fn();
    return true;
  };
  const fire = (target, type, ev = {}) => {
    const bag = target === 'win' ? winL : docL;
    (bag[type] || []).slice().forEach(f => f(ev));
  };
  return { ctx, win, doc, fire, runFlightTimer, store };
}

test('何もしなければ220ms後に遷移する', () => {
  const { ctx, fire, runFlightTimer } = load();
  let went = 0;
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => went++);
  assert.equal(went, 0, 'すぐには遷移しない');
  runFlightTimer();
  assert.equal(went, 1, '220ms後に遷移する');
});

test('端末の「戻る」(popstate)で出ていったら遷移しない', () => {
  const { ctx, fire, runFlightTimer } = load();
  let went = 0;
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => went++);
  fire('win', 'popstate', {});
  runFlightTimer();
  assert.equal(went, 0, '戻ったのに引き戻された');
});

test('アプリを裏に回したら遷移しない', () => {
  const { ctx, doc, fire, runFlightTimer } = load();
  let went = 0;
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => went++);
  doc.hidden = true;
  fire('doc', 'visibilitychange', {});
  runFlightTimer();
  assert.equal(went, 0, '裏に回したのに遷移した');
});

test('Escapeで取り消せる', () => {
  const { ctx, fire, runFlightTimer } = load();
  let went = 0;
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => went++);
  fire('doc', 'keydown', { key: 'Escape' });
  runFlightTimer();
  assert.equal(went, 0);
});

test('別の所を触ったら遷移しない(v1.28.236で直した分が壊れていないこと)', () => {
  const { ctx, fire, runFlightTimer } = load();
  let went = 0;
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => went++);
  fire('doc', 'pointerdown', { target: el() });
  runFlightTimer();
  assert.equal(went, 0);
});

test('取り消した後は着地アニメーションの印が残らない', () => {
  const { ctx, fire, runFlightTimer, store } = load();
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => {});
  assert.ok(Object.keys(store).length > 0, '飛ぶ時に印が付く');
  fire('win', 'popstate', {});
  runFlightTimer();
  assert.equal(Object.values(store).filter(v => v === '1').length, 0, '印が残っている');
});

test('取り消した後はもう一度開ける(flightBusyが解けている)', () => {
  const { ctx, fire, runFlightTimer } = load();
  let went = 0;
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => went++);
  fire('win', 'popstate', {});
  ctx.window.LiquidGlass.flyAvatarTo(el(), () => went++);
  runFlightTimer();
  assert.equal(went, 1, '取り消し後に開けなくなっている');
});
