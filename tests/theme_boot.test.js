// themeBoot.js の判定ロジック(システム/ライト/ダーク/時間指定/旧設定)を、DOMなしで確認する
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function load({ store = {}, osDark = false, now = new Date(2026, 9, 26, 12, 0) } = {}) {
  const cls = new Set();
  const doc = {
    documentElement: { classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: c => cls.has(c) } },
    querySelector: () => null, addEventListener() {}, hidden: false,
  };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { if (a.length) super(...a); else super(now.getTime()); } static now() { return now.getTime(); } }
  const win = {
    matchMedia: () => ({ matches: osDark, addEventListener() {} }),
    addEventListener() {}, dispatchEvent() {},
  };
  const ctx = {
    window: win, document: doc, Date: FakeDate, CustomEvent: function () {}, Event: function () {},
    setTimeout: () => 0, clearTimeout() {}, matchMedia: win.matchMedia,
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/themeBoot.js'), 'utf8'), ctx);
  return { T: win.BroTheme, cls, store };
}

test('themeMode が無ければ旧 darkMode を読む。どちらも無ければ端末に従う', () => {
  assert.strictEqual(load({ store: { darkMode: '1' } }).T.mode(), 'dark');
  assert.strictEqual(load({ store: { darkMode: '0' }, osDark: true }).T.isDark(), false);
  assert.strictEqual(load({ osDark: true }).T.isDark(), true);
  assert.strictEqual(load({ osDark: false }).T.isDark(), false);
});

test('システム/ライト/ダークと真っ黒のクラスが付く', () => {
  let r = load({ store: { themeMode: 'dark' } });
  assert.ok(r.cls.has('dark-mode') && !r.cls.has('dark-black'));
  r = load({ store: { themeMode: 'dark', darkBlack: '1' } });
  assert.ok(r.cls.has('dark-mode') && r.cls.has('dark-black'));
  // ライトの時は真っ黒の設定が残っていてもクラスは付かない
  r = load({ store: { themeMode: 'light', darkBlack: '1' }, osDark: true });
  assert.ok(!r.cls.has('dark-mode') && !r.cls.has('dark-black'));
});

test('時間指定: 日をまたぐ範囲(20:00-07:00)と同じ時刻', () => {
  const at = (h, m = 0, extra = {}) => load({ store: { themeMode: 'schedule', ...extra }, now: new Date(2026, 9, 26, h, m) }).T.isDark();
  assert.strictEqual(at(21), true);
  assert.strictEqual(at(3), true);
  assert.strictEqual(at(6, 59), true);
  assert.strictEqual(at(7, 0), false);
  assert.strictEqual(at(12), false);
  assert.strictEqual(at(19, 59), false);
  assert.strictEqual(at(20, 0), true);
  // 日をまたがない範囲 (13:00-15:00)
  assert.strictEqual(at(14, 0, { darkSchedFrom: '13:00', darkSchedTo: '15:00' }), true);
  assert.strictEqual(at(16, 0, { darkSchedFrom: '13:00', darkSchedTo: '15:00' }), false);
  // 開始=終了はダークにしない(0時間)
  assert.strictEqual(at(10, 0, { darkSchedFrom: '08:00', darkSchedTo: '08:00' }), false);
  // 壊れた値は既定(20:00-07:00)に戻る
  assert.strictEqual(at(22, 0, { darkSchedFrom: 'abc', darkSchedTo: '' }), true);
});

test('set() は保存して、旧 darkMode も意味を合わせて書き戻す', () => {
  const r = load();
  r.T.set({ mode: 'dark', black: true });
  assert.strictEqual(r.store.themeMode, 'dark');
  assert.strictEqual(r.store.darkMode, '1');
  assert.strictEqual(r.store.darkBlack, '1');
  assert.ok(r.cls.has('dark-black'));
  r.T.set({ mode: 'light' });
  assert.strictEqual(r.store.darkMode, '0');
  r.T.set({ mode: 'schedule', from: '21:30', to: '06:00' });
  assert.ok(!('darkMode' in r.store));
  const sc = r.T.schedule();
  assert.strictEqual(sc.from, '21:30');
  assert.strictEqual(sc.to, '06:00');
  r.T.set({ black: false });
  assert.ok(!('darkBlack' in r.store));
});
