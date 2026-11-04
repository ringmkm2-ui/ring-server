process.env.NODE_ENV = 'test';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const zlib = require('zlib');
const { startServer } = require('./helpers');
const lp = require('../utils/linkPreview');

let S, T, RAW, port, rawPort, sockets;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const html = (res, b, ct = 'text/html; charset=utf-8') => { res.writeHead(200, { 'content-type': ct }); res.end(b); };

before(async () => {
  sockets = [];
  T = http.createServer((req, res) => {
    const u = req.url;
    if (u === '/comment') return html(res, '<html><head><!-- <meta property="og:title" content="OLD COMMENTED"> --><title>T</title><meta property="og:title" content="NEW"></head></html>');
    if (u === '/script-meta') return html(res, '<html><head><script>var s=\'<meta property="og:title" content="FROM SCRIPT">\';</script><meta property="og:title" content="REAL"></head></html>');
    if (u === '/attrs1') return html(res, `<html><head><meta content='X "q" &amp; Y' property=og:title></head></html>`);
    if (u === '/attrs2') return html(res, `<html><head><META\n  PROPERTY="OG:TITLE"\n  CONTENT="Upper"\n/></head></html>`);
    if (u === '/attrs3') return html(res, `<html><head><meta name="description" content="has > gt and <b>tag</b>"><meta property="og:title" content=Unquoted></head></html>`);
    if (u === '/emoji-trunc') return html(res, `<html><head><title>${'a'.repeat(198)}😀😀</title></head></html>`);
    if (u === '/bom') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<html><head><title>bom ok 日本語</title></head></html>')])); }
    if (u === '/utf16') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('<html><head><title>utf16 ok</title></head></html>', 'utf16le')])); }
    if (u === '/badcharset') {
      const bytes = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf8mb4' });
      return res.end(Buffer.concat([Buffer.from('<html><head><meta charset="shift_jis"><title>'), bytes, Buffer.from('</title></head></html>')]));
    }
    if (u === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
    if (u === '/rel-redirect') { res.writeHead(301, { location: 'titleonly' }); return res.end(); }
    if (u === '/titleonly') return html(res, '<html><head><title>just title</title></head></html>');
    if (u === '/to-b') { res.writeHead(302, { location: `http://b.test:${port}/titleonly` }); return res.end(); }
    if (u === '/to-evil') { res.writeHead(302, { location: `http://evil.test:${port}/titleonly` }); return res.end(); }
    if (u === '/chunked-split') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'transfer-encoding': 'chunked' });
      const full = Buffer.from('<html><head><title>日本語タイトル</title><meta property="og:description" content="d"></head><body>' + 'x'.repeat(1000) + '</body></html>');
      // 1バイトずつ(日本語の途中・</head> の途中でも切れる)
      let i = 0; const t = setInterval(() => { if (i >= full.length) { clearInterval(t); return res.end(); } res.write(full.subarray(i, i + 1)); i++; }, 0);
      return;
    }
    if (u === '/img.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.from('89504e470d0a1a0a', 'hex')); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => T.listen(0, '127.0.0.1', r));
  port = T.address().port;

  // 生のTCPで変な応答を返す
  RAW = net.createServer(sock => {
    sockets.push(sock);
    sock.on('error', () => {});
    let buf = '';
    sock.on('data', d => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      const m = /^GET (\S+)/.exec(buf); const url = m && m[1]; buf = '';
      const head = (extra) => sock.write('HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\n' + extra + '\r\n');
      if (url === '/gzip-garbage-hold') {          // 壊れたgzipを送って接続を握ったままにする
        head('Content-Encoding: gzip\r\nContent-Length: 100000\r\n');
        sock.write(Buffer.from('this is not gzip data at all, hold the line'));
        return;
      }
      if (url === '/gzip-trailing') {              // 正しいgzip + ゴミ
        const gz = zlib.gzipSync(Buffer.from('<html><head><title>gz trailing</title></head></html>'));
        head('Content-Encoding: gzip\r\nContent-Length: ' + (gz.length + 7) + '\r\nConnection: close\r\n');
        sock.end(Buffer.concat([gz, Buffer.from('garbage')]));
        return;
      }
      if (url === '/lying-long') {                 // Content-Length が実際より大きい
        const b = '<html><head><title>lying long</title></head>';
        head('Content-Length: 1000000\r\nConnection: close\r\n'); sock.end(b); return;
      }
      if (url === '/drip') {                       // title を先に送って、あとは遅く1バイトずつ(</head>は来ない)
        head('Transfer-Encoding: chunked\r\n');
        const first = '<html><head><title>drip title</title>';
        sock.write(first.length.toString(16) + '\r\n' + first + '\r\n');
        const t = setInterval(() => { if (sock.destroyed) return clearInterval(t); try { sock.write('1\r\nx\r\n'); } catch (_) {} }, 300);
        sock.on('close', () => clearInterval(t));
        return;
      }
      sock.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
    });
  });
  await new Promise(r => RAW.listen(0, '127.0.0.1', r));
  rawPort = RAW.address().port;
  S = await startServer({ LINK_PREVIEW_TEST_ALLOW: '127.0.0.1,b.test,a.test' });
});
after(async () => { if (S) await S.stop(); sockets.forEach(s => s.destroy()); if (T) { T.closeAllConnections?.(); T.close(); } if (RAW) RAW.close(); });

async function enabled(name) {
  const u = await S.user(name);
  assert.equal((await u.call('PUT', '/api/settings', { settings: { linkPreview: true } })).status, 200);
  return u;
}
const q = (u, url) => u.call('GET', '/api/link-preview?url=' + encodeURIComponent(url));
const L = p => `http://127.0.0.1:${port}${p}`;
const R = p => `http://127.0.0.1:${rawPort}${p}`;

test('QL1: コメントアウトされた meta が本物より優先される', async () => {
  const u = await enabled('L1');
  assert.equal((await q(u, L('/comment'))).data.title, 'NEW');
});
test('QL2: script の文字列の中の meta が本物より優先される', async () => {
  const u = await enabled('L2');
  assert.equal((await q(u, L('/script-meta'))).data.title, 'REAL');
});
test('QL3: 属性の順序・引用符・大文字・改行', async () => {
  const u = await enabled('L3');
  assert.equal((await q(u, L('/attrs1'))).data.title, 'X "q" & Y');
  assert.equal((await q(u, L('/attrs2'))).data.title, 'Upper');
  const r = await q(u, L('/attrs3'));
  assert.equal(r.data.title, 'Unquoted');
  assert.equal(r.data.description, 'has gt and tag'); // < > は仕様どおり落とす
});
test('QL4: 相対・プロトコル相対の og:image', () => {
  const base = new URL('https://example.com/a/b/page.html');
  const mk = (c) => lp.extractMeta(`<head><meta property="og:image" content="${c}"></head>`, base).image;
  assert.equal(mk('//cdn.x.com/i.png'), 'https://cdn.x.com/i.png');
  assert.equal(mk('../i.png'), 'https://example.com/a/i.png');
  assert.equal(mk('/i.png'), 'https://example.com/i.png');
  assert.equal(mk('i.png'), 'https://example.com/a/b/i.png');
  assert.equal(mk(' https://x.com/a&amp;b.png '), 'https://x.com/a&b.png');
  assert.equal(mk('http://x.com/i.png'), '');
  assert.equal(mk('data:image/png;base64,AAAA'), '');
});
test('QL5: 絵文字・4バイト文字の途中で切って壊れた文字(孤立サロゲート)を返す', async () => {
  const u = await enabled('L5');
  const r = await q(u, L('/emoji-trunc'));
  const t = r.data.title;
  assert.equal(r.status, 200);
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(t);
  assert.ok(!lone, '孤立サロゲートあり: ' + JSON.stringify(t.slice(-4)));
});
test('QL6: BOM・UTF-16', async () => {
  const u = await enabled('L6');
  assert.equal((await q(u, L('/bom'))).data.title, 'bom ok 日本語');
  assert.equal((await q(u, L('/utf16'))).data.title, 'utf16 ok');
});
test('QL7: Content-Type の charset が知らない名前なら meta の宣言を使う', async () => {
  const u = await enabled('L7');
  assert.equal((await q(u, L('/badcharset'))).data.title, '日本語');
});
test('QL8: リダイレクトのループは422、相対リダイレクトは辿る', async () => {
  const u = await enabled('L8');
  assert.equal((await q(u, L('/loop'))).status, 422);
  assert.equal((await q(u, L('/rel-redirect'))).data.title, 'just title');
});
test('QL9: 別ホストへのリダイレクトは名前解決をやり直し、内部に向く名前は止める', async () => {
  lp._clearCache();
  const asked = [];
  const resolver = async (h) => { asked.push(h); if (h === 'evil.test') return [{ address: '10.0.0.1', family: 4 }]; return [{ address: '127.0.0.1', family: 4 }]; };
  process.env.LINK_PREVIEW_TEST_ALLOW = '127.0.0.1,a.test,b.test';   // evil.test は免除しない
  const r = await lp.getPreview(`http://a.test:${port}/to-b`, resolver);
  assert.equal(r.title, 'just title');
  assert.deepEqual(asked, ['a.test', 'b.test']);
  lp._clearCache();
  await assert.rejects(lp.getPreview(`http://a.test:${port}/to-evil`, resolver), e => e.status === 400);
});
test('QL10: 1バイトずつのチャンク応答(日本語・</head>の途中で切れる)', async () => {
  const u = await enabled('L10');
  const r = await q(u, L('/chunked-split'));
  assert.equal(r.data.title, '日本語タイトル');
  assert.equal(r.data.description, 'd');
});
test('QL12: Content-Length が実際より大きくても、読めた分でプレビューを作る', async () => {
  const u = await enabled('L12');
  const r = await q(u, R('/lying-long'));
  assert.equal(r.data.title, 'lying long');
});
test('QL13: 壊れたgzipを返して接続を握り続ける相手との接続が、取得終了後も開いたまま残る(ソケット漏れ)', async () => {
  const u = await enabled('L13');
  const before = sockets.length;
  const r = await q(u, R('/gzip-garbage-hold'));
  assert.ok([200, 422].includes(r.status), String(r.status));
  await sleep(1500);
  const mine = sockets.slice(before);
  assert.ok(mine.length >= 1);
  assert.ok(mine.every(s => s.destroyed || s.readableEnded || s.closed), 'プレビューが終わっても相手とのTCP接続が閉じられていない');
});
test('QL14: 先に title を送って、あとは遅く送り続ける相手: 5秒で打ち切り、読めた title を返す', async () => {
  const u = await enabled('L14');
  const t0 = Date.now();
  const r = await q(u, R('/drip'));
  assert.ok(Date.now() - t0 < 6500, 'time ' + (Date.now() - t0));
  assert.equal(r.status, 200, '時間切れで読めた分を捨てて ' + r.status);
  assert.equal(r.data.title, 'drip title');
});
test('QL15: 名前解決が遅いと「全体5秒」を守れない', async () => {
  lp._clearCache();
  const resolver = () => new Promise(r => setTimeout(() => r([{ address: '127.0.0.1', family: 4 }]), 8000));
  process.env.LINK_PREVIEW_TEST_ALLOW = '127.0.0.1,slowdns.test';
  const t0 = Date.now();
  await lp.getPreview(`http://slowdns.test:${port}/titleonly`, resolver).catch(() => {});
  const dt = Date.now() - t0;
  assert.ok(dt < 6000, `5秒の上限のはずが ${dt}ms かかった`);
});
test('QL16: 先頭のアドレスにつながらなくても、次のアドレスを試す', async () => {
  lp._clearCache();
  process.env.LINK_PREVIEW_TEST_ALLOW = '127.0.0.1,dual.test,::1';
  const resolver = async () => [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }];
  // ::1 では待ち受けていない(IPv6が無い環境でも同じく失敗する)
  const r = await lp.getPreview(`http://dual.test:${port}/titleonly`, resolver);
  assert.equal(r.title, 'just title');
});
test('QL17: IP判定の穴探し', () => {
  const must = ['64:ff9b::7f00:1', '::7f00:1', '::FFFF:7F00:1', '0:0:0:0:0:ffff:7f00:1', 'fe80::1', 'fd00::1', 'fc00::1',
    '2001:db8::1', '2002:7f00:1::', '2002:a9fe:a9fe::', '[::1]', '::', '::ffff:169.254.169.254', '100.64.0.1', '192.0.0.8', '198.18.0.1', '255.255.255.255', '0.0.0.0', '169.254.169.254', '172.31.255.255', '192.168.1.1',
    '2001::1', 'ff02::1', '::ffff:10.0.0.1', '64:ff9b:1::1', 'fec0::1'];
  const bad = must.filter(ip => !lp.isBlockedIp(ip));
  assert.deepEqual(bad, [], '内部なのに通る: ' + bad.join(' '));
  const pub = ['8.8.8.8', '172.32.0.1', '100.128.0.1', '11.0.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '2001:4860:4860::8888'];
  const wrong = pub.filter(ip => lp.isBlockedIp(ip));
  assert.deepEqual(wrong, [], '公開なのに弾く: ' + wrong.join(' '));
});
test('QL18: URLの形(ポート・IDN・全角ドット・末尾ドット・長さ)', async () => {
  delete process.env.LINK_PREVIEW_TEST_ALLOW; // 前のテストが免除を残している
  let called = false;
  const never = async () => { called = true; throw new Error('RESOLVER'); };
  const reached = async (u) => { called = false; lp._clearCache(); const st = await lp.getPreview(u, never).then(() => 'ok', e => 'status' + e.status); return called ? 'resolver' : st; };
  assert.equal(await reached('http://example.com:0080/'), 'resolver');
  assert.equal(await reached('https://example.com:443/'), 'resolver');
  assert.equal(await reached('http://example.com:443/'), 'resolver');
  assert.equal(await reached('http://example.com:8443/'), 'status400');
  assert.equal(await reached('http://münchen.de/'), 'resolver');
  assert.equal(await reached('http://127。0。0。1/'), 'status400');
  lp._clearCache();
  await assert.rejects(lp.getPreview('http://localhost./', async () => [{ address: '127.0.0.1', family: 4 }]), e => e.status === 400, '末尾ドットのlocalhostも、解決後のIPで止まる');
  assert.equal(await reached('http://[::1]:80/'), 'status400');
  assert.equal(await reached('http://[fe80::1%25eth0]/'), 'status400');
  assert.equal(new URL('http://münchen.de/').hostname, 'xn--mnchen-3ya.de');
});
test('QL19: 長いURL・配列/オブジェクトのurlパラメータ', async () => {
  const u = await enabled('L19');
  assert.equal((await u.call('GET', '/api/link-preview?url=' + encodeURIComponent('http://a.test/' + 'a'.repeat(2100)))).status, 400);
  assert.equal((await u.call('GET', '/api/link-preview?url=a&url=b')).status, 400);
  assert.equal((await u.call('GET', '/api/link-preview?url[a]=b')).status, 400);
  assert.equal((await u.call('GET', '/api/link-preview')).status, 400);
  assert.equal((await u.call('GET', '/api/link-preview/image?url=' + encodeURIComponent('https://' + 'a'.repeat(300) + '.com/'))).status, 422 );
  assert.equal((await S.req('GET', '/api/link-preview?url=x')).status, 401);
  assert.equal((await u.call('POST', '/api/link-preview?url=x')).status, 404);
  const tr = await u.call('GET', '/api/link-preview/?url=' + encodeURIComponent(L('/titleonly')));
  assert.equal(tr.status, 200);
});

test('QL20: 閉じないコメント・scriptが大量にあっても、解析が2乗の時間にならない', () => {
  const base = new URL('https://example.com/');
  for (const unit of ['<!--', '<script>', '<style>', '<meta ', '<title>', '<meta content="']) {
    const html = '<html><head>' + unit.repeat(Math.floor(1.5 * 1024 * 1024 / unit.length));
    const t0 = Date.now();
    lp.extractMeta(html, base);
    const dt = Date.now() - t0;
    assert.ok(dt < 1500, `${JSON.stringify(unit)} x N で ${dt}ms`);
  }
});
