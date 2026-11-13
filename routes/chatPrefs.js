// routes/chatPrefs.js
// トークリストの操作(ピン留め・ミュート・非表示・自分だけトーク削除)。
// 一覧の並びや見え方に関わる設定を端末ではなくサーバーに持たせ、端末をまたいで同じにする。
//   GET  /api/chat-prefs        -> { prefs: [{ kind, peerId, pinnedAt, muted, hiddenAt, clearedAt }] }
//   PUT  /api/chat-prefs        body { kind, peerId, pinned?, muted?, hidden? } -> 変えた後の1件
//   POST /api/chat-prefs/clear  body { kind, peerId } -> 変えた後の1件(自分だけトークを消す)
const express = require('express');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { chatPrefsLimiter } = require('../utils/rateLimits');
const { withLock } = require('../utils/keyedLock');
const { areFriends } = require('../utils/relations');
const cp = require('../utils/chatPrefs');

const router = express.Router();

// 本文の { kind, peerId } を確かめる。だめなら応答まで返して null
function parseTarget(req, res) {
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    res.status(400).json({ error: 'リクエストの形式が正しくありません' });
    return null;
  }
  if (!cp.KINDS.includes(b.kind)) {
    res.status(400).json({ error: 'kind は dm か group を指定してください' });
    return null;
  }
  if (typeof b.peerId !== 'string' || !b.peerId || b.peerId.length > 64) {
    res.status(400).json({ error: 'peerId が正しくありません' });
    return null;
  }
  if (b.kind === 'dm' && b.peerId === req.user.userId) {
    res.status(400).json({ error: '自分自身は指定できません' });
    return null;
  }
  return { kind: b.kind, peerId: b.peerId };
}

// 操作してよい相手か(DM: 友だち、またはもうメッセージのやり取りがある相手 / グループ: 今入っている人)。
// 違えば応答まで返して false
async function checkTarget(me, { kind, peerId }, res) {
  if (kind === 'dm') {
    const other = await db.get('SELECT id FROM users WHERE id = ?', [peerId]);
    if (!other) { res.status(404).json({ error: 'ユーザーが見つかりません' }); return false; }
    if (await areFriends(me, peerId)) return true;
    const talked = await db.get(
      'SELECT 1 AS ok FROM messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?) LIMIT 1',
      [me, peerId, peerId, me]
    );
    if (talked) return true;
    res.status(403).json({ error: 'このユーザーとは友達ではありません' });
    return false;
  }
  const group = await db.get('SELECT id FROM groups WHERE id = ?', [peerId]);
  if (!group) { res.status(404).json({ error: 'グループが見つかりません' }); return false; }
  const mem = await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', [peerId, me]);
  if (!mem) { res.status(403).json({ error: 'このグループのメンバーではありません' }); return false; }
  return true;
}

// 行を書く。全部が初期値に戻った行は残さない(ピン留めの数・一覧の読み込みを軽くしておく)
async function savePref(me, p) {
  const empty = p.pinnedAt == null && !p.muted && p.hiddenAt == null && !(p.clearedAt > 0);
  if (empty) {
    await db.run('DELETE FROM chat_prefs WHERE user_id = ? AND kind = ? AND peer_id = ?', [me, p.kind, p.peerId]);
    return;
  }
  await db.run(
    `INSERT INTO chat_prefs (user_id, kind, peer_id, pinned_at, muted, hidden_at, cleared_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id, kind, peer_id) DO UPDATE SET
       pinned_at = excluded.pinned_at, muted = excluded.muted, hidden_at = excluded.hidden_at,
       cleared_at = excluded.cleared_at, updated_at = CURRENT_TIMESTAMP`,
    [me, p.kind, p.peerId, p.pinnedAt, !!p.muted, p.hiddenAt, p.clearedAt || 0]
  );
}

router.get('/', verifyToken, asyncHandler(async (req, res) => {
  const map = await cp.loadPrefs(req.user.userId);
  res.json({ prefs: [...map.values()] });
}));

router.put('/', chatPrefsLimiter, verifyToken, asyncHandler(async (req, res) => {
  const me = req.user.userId;
  const target = parseTarget(req, res);
  if (!target) return;
  const { pinned, muted, hidden } = req.body;
  for (const [name, v] of [['pinned', pinned], ['muted', muted], ['hidden', hidden]]) {
    if (v !== undefined && typeof v !== 'boolean') return res.status(400).json({ error: `${name} は true か false を指定してください` });
  }
  if (pinned === undefined && muted === undefined && hidden === undefined) {
    return res.status(400).json({ error: 'pinned / muted / hidden のどれかを指定してください' });
  }

  // 同じ人の操作は1つずつ。「ピン留めの数を数えてから足す」が同時に来ても上限を超えないように
  const out = await withLock('chatprefs:' + me, async () => {
    const cur = await cp.getPref(me, target.kind, target.peerId);
    const exists = cur.pinnedAt != null || cur.muted || cur.hiddenAt != null || cur.clearedAt > 0;
    // 外す方向だけの操作は、相手が友だちでなくなった・グループを抜けた後でも通す(外せないピンが残らないように)
    const onlyOff = pinned !== true && muted !== true && hidden !== true;
    if (!(exists && onlyOff) && !(await checkTarget(me, target, res))) return null;

    const next = { ...cur };
    if (pinned === true) {
      if (cur.pinnedAt == null) {
        const n = await db.get('SELECT COUNT(*) AS c FROM chat_prefs WHERE user_id = ? AND pinned_at IS NOT NULL', [me]);
        if (Number(n && n.c) >= cp.MAX_PINNED) {
          res.status(400).json({ error: `ピン留めできるのは${cp.MAX_PINNED}件までです`, code: 'pin_limit' });
          return null;
        }
        next.pinnedAt = Date.now();
      } // すでにピン留め済みなら時刻は変えない(並びが入れ替わらないように)
    } else if (pinned === false) {
      next.pinnedAt = null;
    }
    if (muted !== undefined) next.muted = muted;
    if (hidden === true) next.hiddenAt = Date.now();
    else if (hidden === false) next.hiddenAt = null;
    await savePref(me, next);
    return next;
  });
  if (out) res.json(out);
}));

// 「トークを削除」(自分だけ)。この時刻より前のメッセージが、この人にだけ見えなくなる。
// 相手・他のメンバーには何も起きず、あとから届いたメッセージは普通に表示される
router.post('/clear', chatPrefsLimiter, verifyToken, asyncHandler(async (req, res) => {
  const me = req.user.userId;
  const target = parseTarget(req, res);
  if (!target) return;
  const out = await withLock('chatprefs:' + me, async () => {
    if (!(await checkTarget(me, target, res))) return null;
    const cur = await cp.getPref(me, target.kind, target.peerId);
    const next = { ...cur, clearedAt: Date.now(), hiddenAt: null };
    await savePref(me, next);
    return next;
  });
  if (out) res.json(out);
}));

module.exports = router;
