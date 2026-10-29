// リンクのプレビュー: SSRF対策(内部IP・リダイレクト・DNS固定)と、取り出す値の安全性、設定・回数制限。
// 本物のサーバーは 127.0.0.1 を弾くので、テスト(NODE_ENV=test)の時だけ LINK_PREVIEW_TEST_ALLOW で免除する。
process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { startServer } = require('./helpers');
const lp = require('../utils/linkPreview');

let S, T, port, hits;
const BIG = '<html><head><title>Big page</title></head><body>' + 'x'.repeat(700 * 1024) + '</body></html>';

before(async () => {
  hits = [];
  T = http.createServer((req, res) => {
    hits.push({ url: req.url, host: req.headers.host });
    const html = (b, ct = 'text/html; charset=utf-8') => { res.writeHead(200, { 'content-type': ct }); res.end(b); };
    if (req.url === '/ok') return html(`<!doctype html><html><head>
      <title>fallback title</title>
      <meta property="og:title" content="Hello &amp; &lt;b&gt;World&lt;/b&gt;&#x1F600;">
      <meta property="og:description" content="  line1&#10;line2 <script>alert(1)</script> ">
      <meta property="og:image" content="https://cdn.example.com/a.png">
      <meta property="og:site_name" content="Example">
      </head><body><meta property="og:title" content="body one is ignored"></body></html>`);
    if (req.url === '/titleonly') return html('<html><head><title>  Just   a title </title></head></html>');
    if (req.url === '/badimg') return html('<html><head><title>t</title><meta property="og:image" content="http://insecure.example.com/a.png"></head></html>');
    if (req.url === '/jsimg') return html('<html><head><title>t</title><meta property="og:image" content="javascript:alert(1)"></head></html>');
    if (req.url === '/redir') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    if (req.url.startsWith('/hop')) { const n = Number(req.url.slice(4)); res.writeHead(302, { location: '/hop' + (n + 1) }); return res.end(); }
    if (req.url === '/hop3end') return html('<title>end</title>');
    if (req.url === '/to-meta') { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); return res.end(); }
    if (req.url === '/to-file') { res.writeHead(302, { location: 'file:///etc/passwd' }); return res.end(); }
    if (req.url === '/big') return html(BIG);
    if (req.url === '/plain') return html('<title>no</title>', 'text/plain');
    if (req.url === '/json') return html('{"a":1}', 'application/json');
    if (req.url === '/slow') return; // 応答しない
    res.writeHead(404); res.end();
  });
  await new Promise(r => T.listen(0, '127.0.0.1', r));
  port = T.address().port;
  S = await startServer({ LINK_PREVIEW_TEST_ALLOW: '127.0.0.1' });
});
after(async () => { if (S) await S.stop(); if (T) { T.closeAllConnections?.(); T.close(); } });

async function enabled(name) {
  const u = await S.user(name);
  assert.equal((await u.call('PUT', '/api/settings', { settings: { linkPreview: true } })).status, 200);
  return u;
}
const q = (u, url) => u.call('GET', '/api/link-preview?url=' + encodeURIComponent(url));
const L = p => `http://127.0.0.1:${port}${p}`;

test('設定: linkPreview の既定はオフで、オフなら403。認証なしは401', async () => {
  const u = await S.user('LpOff');
  const s = await u.call('GET', '/api/settings');
  assert.equal(s.data.settings.linkPreview, false);
  const r = await q(u, L('/ok'));
  assert.equal(r.status, 403);
  assert.ok(r.data.error);
  const anon = await S.req('GET', '/api/link-preview?url=' + encodeURIComponent(L('/ok')));
  assert.equal(anon.status, 401);
  assert.equal(hits.length, 0, 'オフの人のために外へは取りに行かない');
});

test('新しい設定キーは検証されて保存される', async () => {
  const u = await S.user('LpSet');
  const r = await u.call('PUT', '/api/settings', { settings: { hideNotificationBody: true, saveDrafts: false, autoResend: false, privacyScreen: true, blockScreenshots: true, linkPreview: 'yes', bogus: 1 } });
  assert.equal(r.status, 200);
  const s = r.data.settings;
  assert.equal(s.hideNotificationBody, true); assert.equal(s.saveDrafts, false); assert.equal(s.autoResend, false);
  assert.equal(s.privacyScreen, true); assert.equal(s.blockScreenshots, true);
  assert.equal(s.linkPreview, false, '真偽値でない値は無視');
  assert.equal(s.bogus, undefined);
  const d = (await u.call('GET', '/api/settings')).data.defaults;
  assert.deepEqual([d.hideNotificationBody, d.linkPreview, d.saveDrafts, d.autoResend, d.privacyScreen, d.blockScreenshots], [false, false, true, true, false, false]);
});

test('取り出し: og を優先、タグは平文化、本文側の meta は無視、画像は https だけ', async () => {
  const u = await enabled('LpOk');
  const r = await q(u, L('/ok'));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.url, L('/ok'));
  assert.equal(r.data.title.startsWith('Hello & World'), true, r.data.title);
  assert.ok(!/[<>]/.test(r.data.title + r.data.description));
  assert.ok(!r.data.description.includes('<script>'));
  assert.equal(r.data.image, 'https://cdn.example.com/a.png');
  assert.equal(r.data.siteName, 'Example');
  const t = await q(u, L('/titleonly'));
  assert.deepEqual(t.data, { url: L('/titleonly'), title: 'Just a title' });
  assert.equal((await q(u, L('/badimg'))).data.image, undefined);
  assert.equal((await q(u, L('/jsimg'))).data.image, undefined);
});

test('リダイレクトは辿る(3回まで)。4回目は止める', async () => {
  const u = await enabled('LpRd');
  const ok = await q(u, L('/redir'));
  assert.equal(ok.status, 200);
  assert.equal(ok.data.siteName, 'Example');
  // /hop0 → hop1 → hop2 → hop3 の3回で着く。着いた先 /hop3 はこのテストサーバーに無いので404 = 422(取得できませんでした)
  const r0 = await q(u, L('/hop0'));
  assert.equal(r0.status, 422);
  assert.ok(hits.some(h => h.url === '/hop3'), '3回目のリダイレクト先までは取りに行った');
  const r = await q(u, L('/hop1'));
  assert.equal(r.status, 422, JSON.stringify(r.data)); // hop1→2→3→4 で4回目のリダイレクト
  assert.ok(!hits.some(h => h.url === '/hop5'));
  assert.ok(r.data.error.includes('リダイレクト'));
});

test('SSRF: リダイレクト先が内部(メタデータ)でも、file: でも、取りに行かない', async () => {
  const u = await enabled('LpSsrf');
  const a = await q(u, L('/to-meta'));
  assert.equal(a.status, 400, JSON.stringify(a.data));
  const b = await q(u, L('/to-file'));
  assert.equal(b.status, 400);
});

test('SSRF: 危険なURLの形は全て拒否(免除なし)', async () => {
  delete process.env.LINK_PREVIEW_TEST_ALLOW;
  for (const bad of ['http://169.254.169.254/', 'http://[::1]/', 'http://localhost/', 'http://10.0.0.1/', 'http://0x7f.1/', 'http://2130706433/', 'http://017700000001/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://foo.localhost/', 'http://printer.local/', 'ftp://example.com/', 'file:///etc/passwd',
    'javascript:alert(1)', 'http://user:pw@example.com/', 'http://example.com:22/', 'http://8.8.8.8:8080/', 'not a url']) {
    lp._clearCache();
    await assert.rejects(lp.getPreview(bad, async () => { throw new Error('名前解決まで進んではいけない'); }), e => e.status === 400, bad);
  }
});

test('本文は512KBまで。それでも先頭の title は読める。text/html 以外は断る', async () => {
  const u = await enabled('LpBig');
  const r = await q(u, L('/big'));
  assert.equal(r.status, 200);
  assert.equal(r.data.title, 'Big page');
  assert.equal((await q(u, L('/plain'))).status, 422);
  assert.equal((await q(u, L('/json'))).status, 422);
});

test('応答しない相手は5秒で打ち切る', async () => {
  const u = await enabled('LpSlow');
  const t0 = Date.now();
  const r = await q(u, L('/slow'));
  assert.equal(r.status, 504);
  assert.ok(Date.now() - t0 < 7000);
});

test('成功した結果は10分キャッシュされる(失敗は残さない)', async () => {
  const u = await enabled('LpCache');
  const n0 = hits.filter(h => h.url === '/titleonly').length;
  await q(u, L('/titleonly')); await q(u, L('/titleonly'));
  const n1 = hits.filter(h => h.url === '/titleonly').length;
  assert.ok(n1 - n0 <= 1, '2回呼んでも取りに行くのは多くて1回');
  const f0 = hits.filter(h => h.url === '/plain').length;
  await q(u, L('/plain')); await q(u, L('/plain'));
  assert.equal(hits.filter(h => h.url === '/plain').length - f0, 2, '失敗はキャッシュしない');
});

test('回数制限: 1人1分に30回まで', async () => {
  const u = await enabled('LpRate');
  let last;
  for (let i = 0; i < 31; i++) last = await q(u, L('/titleonly'));
  assert.equal(last.status, 429);
});

// ---- ここから、サーバーを介さない単体テスト ----

test('IP判定: 内部・予約・IPv4-mapped は拒否し、公開IPは通す', () => {
  const blocked = ['0.0.0.0', '10.1.2.3', '100.64.0.1', '100.127.255.255', '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.0.1', '198.18.0.1', '224.0.0.1', '240.0.0.1', '255.255.255.255',
    '::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1',
    '2001:db8::1', '2002:7f00:1::1', '2002:a00:1::', '2001:0:1::1', '::127.0.0.1', 'not-an-ip', ''];
  for (const ip of blocked) assert.equal(lp.isBlockedIp(ip), true, ip);
  const open = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '100.63.255.255', '172.15.0.1', '172.32.0.1', '192.169.0.1', '198.20.0.1',
    '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '2002:808:808::1'];
  for (const ip of open) assert.equal(lp.isBlockedIp(ip), false, ip);
});

test('名前解決はこちらで行い、検証したIPに固定して接続する(DNS rebinding対策)', async () => {
  process.env.LINK_PREVIEW_TEST_ALLOW = 'pinned.test';
  const base = hits.length;
  let calls = 0;
  // 1回目だけ 127.0.0.1(テスト用に免除したホスト)。もし接続時にもう一度システムDNSを引けば pinned.test は引けず失敗する
  const resolver = async () => { calls++; return [{ address: '127.0.0.1', family: 4 }]; };
  lp._clearCache();
  const r = await lp.getPreview(`http://pinned.test:${port}/titleonly`, resolver);
  assert.equal(r.title, 'Just a title');
  assert.equal(calls, 1);
  assert.equal(hits[base].host, `pinned.test:${port}`, 'Hostヘッダは元の名前のまま');
  delete process.env.LINK_PREVIEW_TEST_ALLOW;
});

test('複数のアドレスのうち1つでも内部なら拒否する', async () => {
  lp._clearCache();
  const resolver = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  await assert.rejects(lp.getPreview('http://mixed.example.com/', resolver), e => e.status === 400);
});

test('テスト用の免除は NODE_ENV が test 以外では効かない', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  process.env.LINK_PREVIEW_TEST_ALLOW = '127.0.0.1';
  try {
    lp._clearCache();
    await assert.rejects(lp.getPreview(L('/ok')), e => e.status === 400);
  } finally {
    process.env.NODE_ENV = prev;
    delete process.env.LINK_PREVIEW_TEST_ALLOW;
  }
});

test('免除の環境変数が無ければ、テスト環境でも 127.0.0.1 は拒否', async () => {
  delete process.env.LINK_PREVIEW_TEST_ALLOW;
  lp._clearCache();
  await assert.rejects(lp.getPreview(L('/ok')), e => e.status === 400);
});
