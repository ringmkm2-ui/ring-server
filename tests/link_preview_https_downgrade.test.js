// 画像プロキシ: https の画像URLが http へリダイレクトしても、取りに行かないこと
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

test('https から http へのリダイレクトは画像プロキシで拒否する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-tls-'));
  const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });

  const saved = { env: process.env.NODE_ENV, allow: process.env.LINK_PREVIEW_TEST_ALLOW, tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED };
  process.env.NODE_ENV = 'test';
  process.env.LINK_PREVIEW_TEST_ALLOW = 'localhost';
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const { getImage, _clearCache } = require('../utils/linkPreview');
  _clearCache();

  let plainHits = 0;
  // 1x1 の PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const plain = http.createServer((req, res) => { plainHits++; res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(png); });
  await new Promise(r => plain.listen(0, '127.0.0.1', r));
  const plainPort = plain.address().port;
  const secure = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    if (req.url === '/ok.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
    if (req.url === '/to-https') { res.writeHead(302, { Location: '/ok.png' }); return res.end(); }
    res.writeHead(302, { Location: `http://localhost:${plainPort}/x.png` }); res.end();
  });
  await new Promise(r => secure.listen(0, '127.0.0.1', r));
  const base = `https://localhost:${secure.address().port}`;
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];

  try {
    await assert.rejects(getImage(`${base}/down`, resolver), /https の画像だけ/);
    assert.strictEqual(plainHits, 0, 'http 側に接続してはいけない');
    // https 同士のリダイレクトは今まで通り通る
    const ok = await getImage(`${base}/to-https`, resolver);
    assert.strictEqual(ok.contentType, 'image/png');
  } finally {
    await new Promise(r => plain.close(r));
    secure.closeAllConnections();
    await new Promise(r => secure.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [['NODE_ENV', saved.env], ['LINK_PREVIEW_TEST_ALLOW', saved.allow], ['NODE_TLS_REJECT_UNAUTHORIZED', saved.tls]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
