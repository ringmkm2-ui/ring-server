const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

const URL_OK = 'https://res.cloudinary.com/demo/raw/upload/brochat/dm/abc123';
const meta = { encrypted: 'AAAA', nonce: 'BBBB' };

test('ファイル(mediaType=file)をDMで送れて、一覧には「ファイルが送信されました」と出る', async () => {
  const a = await S.user('FiA'); const b = await S.user('FiB');
  await S.befriend(a, b);
  const r = await a.call('POST', '/api/messages/send', {
    recipientId: b.userId, content: '[ファイル]', mediaType: 'file',
    mediaUrl: URL_OK, encryptedMetadata: meta, chunkCount: 1, encrypted: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const talks = await b.call('GET', '/api/messages/talks');
  const t = (talks.data || []).find(x => x.lastKind === 'file');
  assert.ok(t, 'lastKind=file が一覧に出る: ' + JSON.stringify(talks.data).slice(0, 200));
  assert.equal(t.lastMessage, 'ファイルが送信されました');
});

test('ファイルでも許可外のURLは断る', async () => {
  const a = await S.user('FiC'); const b = await S.user('FiD');
  await S.befriend(a, b);
  const r = await a.call('POST', '/api/messages/send', {
    recipientId: b.userId, content: '[ファイル]', mediaType: 'file',
    mediaUrl: 'https://evil.example.com/x', encryptedMetadata: meta, chunkCount: 1, encrypted: true,
  });
  assert.equal(r.status, 400);
});
