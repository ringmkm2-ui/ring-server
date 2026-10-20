// try/catchの無いasyncルートが失敗しても、500を返してサーバーは落ちない
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
require('../utils/asyncErrors');

test('asyncルートの例外は500になり、プロセスは生きている', async () => {
  const app = express();
  app.get('/boom', async () => { throw new Error('db down'); });
  app.get('/rej', async (req, res) => { await Promise.reject(new Error('rejected')); res.send('x'); });
  app.get('/ok', async (req, res) => { res.json({ ok: true }); });
  app.use((err, req, res, next) => { res.status(500).json({ error: 'server' }); });
  const srv = http.createServer(app);
  await new Promise(r => srv.listen(0, r));
  const base = 'http://127.0.0.1:' + srv.address().port;
  let rejections = 0;
  const onRej = () => { rejections++; };
  process.on('unhandledRejection', onRej);
  try {
    assert.equal((await fetch(base + '/boom')).status, 500);
    assert.equal((await fetch(base + '/rej')).status, 500);
    assert.equal((await fetch(base + '/ok')).status, 200);
    await new Promise(r => setTimeout(r, 100));
    assert.equal(rejections, 0, '未処理のrejectionが出ていない');
  } finally {
    process.off('unhandledRejection', onRej);
    srv.close();
  }
});
