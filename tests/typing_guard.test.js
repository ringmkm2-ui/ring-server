// 自動更新(pushSubscribe.js)が「入力中」を正しく判定するか。
// 入力中に更新のリロードが走ると、キーボードが閉じて画面も消える。
// pushSubscribe.js は読み込むだけで通知登録などの副作用が走るので、isTyping の関数だけ取り出して動かす。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'pushSubscribe.js'), 'utf8');
const start = src.indexOf('function isTyping() {');
const end = src.indexOf('\n  }\n', start) + 4;
assert.ok(start > 0 && end > start, 'isTyping が見つからない');

function isTypingWith({ active, wizard = false }) {
  const document = { activeElement: active || null, getElementById: (id) => (id === 'kbw' && wizard ? {} : null) };
  const ctx = vm.createContext({ document });
  return vm.runInContext('(' + src.slice(start, end).replace(/^function isTyping/, 'function') + ')()', ctx);
}
const input = (type, value = '', extra = {}) => ({ tagName: 'INPUT', type, value, ...extra });

test('入力欄に焦点がある間は、空でも「入力中」(キーボードが出ている)', () => {
  assert.equal(isTypingWith({ active: input('text', '') }), true);
  assert.equal(isTypingWith({ active: input('password', '') }), true);
  assert.equal(isTypingWith({ active: { tagName: 'TEXTAREA', value: '' } }), true);
  assert.equal(isTypingWith({ active: { tagName: 'DIV', isContentEditable: true, textContent: '' } }), true);
});

test('中身がある入力欄も、もちろん「入力中」', () => {
  assert.equal(isTypingWith({ active: input('text', 'こんにちは') }), true);
  assert.equal(isTypingWith({ active: { tagName: 'TEXTAREA', value: 'abc' } }), true);
});

test('文字を打たない部品・読み取り専用・無効の欄は「入力中」ではない', () => {
  for (const t of ['checkbox', 'radio', 'button', 'submit', 'range', 'file']) assert.equal(isTypingWith({ active: input(t) }), false, t);
  assert.equal(isTypingWith({ active: input('text', 'x', { readOnly: true }) }), false);
  assert.equal(isTypingWith({ active: input('text', 'x', { disabled: true }) }), false);
  assert.equal(isTypingWith({ active: { tagName: 'BUTTON' } }), false);
  assert.equal(isTypingWith({ active: { tagName: 'BODY' } }), false);
  assert.equal(isTypingWith({ active: null }), false);
});

test('暗号鍵のセットアップ画面が開いている間は、焦点が無くても更新を止める', () => {
  assert.equal(isTypingWith({ active: { tagName: 'BODY' }, wizard: true }), true);
  assert.equal(isTypingWith({ active: null, wizard: true }), true);
});
