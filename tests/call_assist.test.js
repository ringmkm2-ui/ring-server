const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

test('features に liveTranslate の真偽値が出る(キー自体は出さない)', async () => {
  const r = await fetch(S.base + '/api/auth/features');
  const j = await r.json();
  assert.equal(typeof j.liveTranslate, 'boolean');
  assert.ok(!JSON.stringify(j).includes('KEY'));
});

test('翻訳は入力検証が先に効く(text必須・長すぎ)', async () => {
  const a = await S.user('CaA');
  assert.equal((await a.call('POST', '/api/call-assist/translate', {})).status, 400);
  assert.equal((await a.call('POST', '/api/call-assist/translate', { text: 'x'.repeat(1001), targetLanguage: '英語' })).status, 413);
});

test('要約は callId/ログが不正なら400', async () => {
  const a = await S.user('CaB');
  assert.equal((await a.call('POST', '/api/call-assist/summarize', { callId: 1, transcriptLog: [{ speaker: 'a', text: 'b' }] })).status, 400);
  assert.equal((await a.call('POST', '/api/call-assist/summarize', { callId: 'c1', transcriptLog: [] })).status, 400);
});
