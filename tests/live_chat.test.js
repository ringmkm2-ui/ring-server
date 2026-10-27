// ライブ配信: タイトル・コメント・視聴者名簿・コメントの許可/ミュート/削除・ブロック
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, sleep } = require('./helpers');

let S;
before(async () => { S = await startServer(); });
after(() => S && S.stop());

async function waitFor(c, pred, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const m = c.msgs.find(pred);
    if (m) return m;
    await sleep(40);
  }
  return null;
}
const last = (c, type) => [...c.msgs].reverse().find(m => m.type === type);

test('タイトル・fps付きで配信を始めると、一覧と視聴者に出る。名簿は入退室で更新される', async () => {
  const host = await S.user('Live H'); const v1 = await S.user('Viewer One'); const v2 = await S.user('Viewer Two');
  const gid = 'u:' + host.userId;
  const h = await S.connect(host);
  const a = await S.connect(v1); const b = await S.connect(v2);
  try {
    h.send({ type: 'live_start', groupId: gid, title: '  夜の\n雑談  ', comments: true, fps: 60 });
    assert.ok(await waitFor(h, m => m.type === 'live_ready'));
    const meta = await waitFor(h, m => m.type === 'live_meta');
    assert.equal(meta.title, '夜の 雑談');
    assert.equal(meta.comments, true);
    const list = (await v1.call('GET', '/api/live/active')).data.find(l => l.hostId === host.userId);
    assert.equal(list.title, '夜の 雑談');
    assert.equal(list.fps, 60);

    a.send({ type: 'live_join', groupId: gid });
    const vl = await waitFor(a, m => m.type === 'live_viewers' && m.viewers.length === 1);
    assert.equal(vl.host.name, 'Live H');
    assert.equal(vl.viewers[0].name, 'Viewer One');
    assert.equal((await waitFor(a, m => m.type === 'live_meta')).title, '夜の 雑談');
    b.send({ type: 'live_join', groupId: gid });
    await waitFor(h, m => m.type === 'live_viewers' && m.viewers.length === 2);
    b.send({ type: 'live_leave', groupId: gid });
    const after1 = await waitFor(h, m => m.type === 'live_viewers' && m.viewers.length === 1 && m !== vl);
    assert.ok(after1, '抜けたら名簿から消える');
    // 配信の途中でタイトルを変える
    h.send({ type: 'live_settings', groupId: gid, title: '朝の雑談' });
    assert.equal((await waitFor(a, m => m.type === 'live_meta' && m.title === '朝の雑談')).title, '朝の雑談');
  } finally { h.close(); a.close(); b.close(); }
});

test('コメント: 全員に届く・長さと間隔の制限・遅れて入った人に履歴・配信者の許可/ミュート/削除', async () => {
  const host = await S.user('Chat Host'); const v1 = await S.user('Chat V1'); const v2 = await S.user('Chat V2');
  const gid = 'u:' + host.userId;
  const h = await S.connect(host); const a = await S.connect(v1);
  let b;
  try {
    h.send({ type: 'live_start', groupId: gid });
    await waitFor(h, m => m.type === 'live_ready');
    a.send({ type: 'live_join', groupId: gid });
    await waitFor(a, m => m.type === 'live_viewers');
    a.send({ type: 'live_comment', groupId: gid, text: 'こんにちは' });
    const got = await waitFor(h, m => m.type === 'live_comment');
    assert.equal(got.comment.text, 'こんにちは');
    assert.equal(got.comment.name, 'Chat V1');
    assert.equal(got.comment.userId, v1.userId);
    assert.ok(await waitFor(a, m => m.type === 'live_comment'), '本人にも返る');
    // 連投は止まる
    a.send({ type: 'live_comment', groupId: gid, text: '連投' });
    assert.equal((await waitFor(a, m => m.type === 'live_comment_rejected')).reason, 'rate');
    await sleep(800);
    // 長すぎるコメントは切られ、空は無視される
    a.send({ type: 'live_comment', groupId: gid, text: 'x'.repeat(500) });
    const long = await waitFor(h, m => m.type === 'live_comment' && m.comment.text.startsWith('xxx'));
    assert.equal(long.comment.text.length, 200);
    // 見ていない人は書けない
    const outsider = await S.connect(v2);
    outsider.send({ type: 'live_comment', groupId: gid, text: 'こっそり' });
    await sleep(300);
    assert.ok(!h.msgs.some(m => m.type === 'live_comment' && m.comment.text === 'こっそり'));
    // 遅れて入った人は履歴が見える
    b = outsider;
    b.send({ type: 'live_join', groupId: gid });
    const hist = await waitFor(b, m => m.type === 'live_chat');
    assert.ok(hist.items.length >= 2);
    // ミュート → 書けない / 解除 → 書ける
    h.send({ type: 'live_mute', groupId: gid, userId: v1.userId, on: true });
    await waitFor(a, m => m.type === 'live_viewers' && m.viewers.some(x => x.id === v1.userId && x.muted));
    await sleep(800);
    a.msgs.length = 0;
    a.send({ type: 'live_comment', groupId: gid, text: 'だめ?' });
    assert.equal((await waitFor(a, m => m.type === 'live_comment_rejected')).reason, 'muted');
    h.send({ type: 'live_mute', groupId: gid, userId: v1.userId, on: false });
    await waitFor(a, m => m.type === 'live_viewers' && m.viewers.some(x => x.id === v1.userId && !x.muted));
    // 視聴者がミュートや設定変更をしても効かない
    a.send({ type: 'live_mute', groupId: gid, userId: v2.userId, on: true });
    a.send({ type: 'live_settings', groupId: gid, comments: false });
    await sleep(300);
    assert.ok(!b.msgs.some(m => m.type === 'live_meta' && m.comments === false));
    // コメントを止める → 視聴者は書けない
    h.send({ type: 'live_settings', groupId: gid, comments: false });
    await waitFor(a, m => m.type === 'live_meta' && m.comments === false);
    await sleep(800); a.msgs.length = 0;
    a.send({ type: 'live_comment', groupId: gid, text: '止まってる' });
    assert.equal((await waitFor(a, m => m.type === 'live_comment_rejected')).reason, 'off');
    // 削除
    const id = got.comment.id;
    h.send({ type: 'live_comment_delete', groupId: gid, id });
    assert.equal((await waitFor(b, m => m.type === 'live_comment_deleted')).id, id);
  } finally { h.close(); a.close(); if (b) b.close(); }
});

test('コメント: ブロックし合っている人には届かない / 禁止語は伏せて通し、本人は停止', async () => {
  const host = await S.user('Blk Host'); const v1 = await S.user('Blk V1'); const v2 = await S.user('Blk V2');
  assert.equal((await v2.call('POST', '/api/friends/block', { userId: v1.userId })).status, 200);
  const gid = 'u:' + host.userId;
  const h = await S.connect(host); const a = await S.connect(v1); const b = await S.connect(v2);
  try {
    h.send({ type: 'live_start', groupId: gid });
    await waitFor(h, m => m.type === 'live_ready');
    a.send({ type: 'live_join', groupId: gid }); b.send({ type: 'live_join', groupId: gid });
    await waitFor(h, m => m.type === 'live_viewers' && m.viewers.length === 2);
    a.send({ type: 'live_comment', groupId: gid, text: 'ブロック確認' });
    await waitFor(h, m => m.type === 'live_comment' && m.comment.text === 'ブロック確認');
    await sleep(300);
    assert.ok(!b.msgs.some(m => m.type === 'live_comment' && m.comment.text === 'ブロック確認'), 'ブロック相手のコメントは届かない');
    // 禁止語
    await sleep(800);
    a.send({ type: 'live_comment', groupId: gid, text: 'what the fuck' });
    const bad = await waitFor(h, m => m.type === 'live_comment' && /f\*\*\*/.test(m.comment.text));
    assert.ok(bad, '伏せ字で届く');
    assert.ok(!/fuck/.test(bad.comment.text));
    await sleep(500);
    const me = await v1.call('GET', '/api/friends/blocks');
    assert.equal(me.status, 403, '言った本人は停止になる');
    assert.equal(me.data.banned, true);
  } finally { h.close(); a.close(); b.close(); }
});
