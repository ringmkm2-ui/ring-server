// LINEの「トーク履歴を送信」の .txt を読む
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../public/js/lineImport.js');
const { parse, decode } = globalThis.BroLineImport;

const ANDROID = `[LINE] 田中とのトーク履歴
保存日時：2026/11/05 23:00

2026/11/04(水)
09:05\t田中\tおはよう
09:06\tRing\t[スタンプ]
09:07\t田中\t"1行目
2行目 "引用"
3行目"
13:40\t田中さんが退出しました
2026/11/05(木)
00:01\tRing\thttp://example.com/?a=1\tタブ入り
`.replace(/\n/g, '\r\n');
const IOS = `﻿[LINE] 田中とのトーク履歴
保存日時：2026.11.05 23:00

2026.11.04 水曜日
午前9:05\t田中\tおはよう
午後1:40\tRing\t[写真]
午前12:00\tRing\t深夜
午後12:00\tRing\t正午
`;
const EN = `[LINE] Chat history with Tanaka
Saved on: 11/5/2026, 23:00

Wed, 11/4/2026
9:05 AM\tTanaka\tMorning
1:40 PM\tRing\t[Photo]
`;
const OLD_IOS = `[LINE] 田中とのトーク履歴

2026/11/04
09:05 田中 おはよう 元気
改行された続き
`;

test('Android版: 日付、複数行、スタンプ、お知らせ、CRLF', () => {
  const r = parse(ANDROID);
  assert.equal(r.title, '田中');
  assert.equal(r.items.length, 5);
  assert.equal(r.items[0].b, 'おはよう');
  assert.equal(new Date(r.items[0].t).getFullYear(), 2026);
  assert.equal(new Date(r.items[0].t).getHours(), 9);
  assert.equal(r.items[1].k, 'media');
  assert.equal(r.items[2].b, '1行目\n2行目 "引用"\n3行目');
  assert.equal(r.items[3].k, 'system');
  assert.equal(r.items[3].n, null);
  assert.equal(new Date(r.items[4].t).getDate(), 5);
  assert.equal(r.items[4].b, 'http://example.com/?a=1\tタブ入り');
  assert.deepEqual(r.names, { 田中: 2, Ring: 2 });
});
test('iPhone版: BOM、午前午後、12時の扱い', () => {
  const r = parse(IOS);
  assert.equal(r.title, '田中');
  const h = r.items.map(x => new Date(x.t).getHours());
  assert.deepEqual(h, [9, 13, 0, 12]);
  assert.equal(r.items[1].k, 'media');
});
test('英語版', () => {
  const r = parse(EN);
  assert.equal(r.title, 'Tanaka');
  assert.equal(new Date(r.items[0].t).getMonth(), 10);
  assert.equal(new Date(r.items[1].t).getHours(), 13);
  assert.equal(r.items[1].k, 'media');
});
test('タブの無い古い形式と、引用符なしの改行', () => {
  const r = parse(OLD_IOS);
  assert.equal(r.items[0].n, '田中');
  assert.equal(r.items[0].b, 'おはよう 元気\n改行された続き');
});
test('LINEのファイルでなければ読まない', () => {
  assert.equal(parse('ただのメモです\n買い物リスト\n'), null);
  assert.equal(parse(''), null);
  assert.equal(parse('12:00 これは 時刻だけのメモ'), null);
});
test('HTMLや引用符の崩れでも落ちず、文字のまま持つ', () => {
  const r = parse('[LINE] Xとのトーク履歴\n2026/01/01(木)\n10:00\tX\t<img src=x onerror=alert(1)>\n10:01\tX\t"閉じない引用\n続き\n');
  assert.equal(r.items[0].b, '<img src=x onerror=alert(1)>');
  assert.equal(r.items[1].b, '閉じない引用\n続き\n');
});
test('Shift_JIS のファイルも読める', () => {
  const sjis = Buffer.from('5b4c494e455d2083658358836782c682cc8367815b834e9a9f97f0', 'hex');
  assert.ok(decode(new Uint8Array(sjis)).includes('トーク'));
});
