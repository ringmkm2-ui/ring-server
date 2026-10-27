const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

async function manifest(cookie) {
  const r = await fetch(S.base + '/manifest.json', { headers: cookie ? { cookie } : {} });
  return { r, j: await r.json() };
}

test('manifest: クッキーが無ければ元のまま、bro_theme で枠と起動背景の色が変わる', async () => {
  const base = await manifest();
  assert.equal(base.r.status, 200);
  assert.ok(base.j.theme_color);
  for (const [c, col] of [['l', '#e0f2fe'], ['d', '#0e1014'], ['b', '#000000']]) {
    const { r, j } = await manifest('foo=1; bro_theme=' + c);
    assert.equal(j.theme_color, col);
    assert.equal(j.background_color, col);
    assert.equal(j.name, base.j.name, '色以外は同じ');
    assert.match(r.headers.get('cache-control'), /no-cache/);
    assert.match(r.headers.get('vary') || '', /cookie/i);
  }
  // 変な値は無視して元のまま
  assert.equal((await manifest('bro_theme=x')).j.theme_color, base.j.theme_color);
});
