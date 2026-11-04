// routes/invites.js
// 友だち招待コード。
//  - 1人が複数のコードを作れる(同時に有効なのは10個まで)
//  - 1つのコードを複数人が使える(人数の上限と期限は作る時に選ぶ)
//  - コードを入れた人と、コードの持ち主は、承認待ちなしでお互いに友だちになる
//    (友だち関係は1行で双方向なので、持ち主の一覧にも相手が出る)
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken: auth } = require('../utils/authMiddleware');
const { sendServerError } = require('../utils/errorResponse');
const { blockState } = require('../utils/relations');

const router = express.Router();

// 見間違えやすい 0/O/1/I は使わない。32種類なので乱数バイトの剰余に偏りが出ない。8文字=40bit
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const MAX_ACTIVE_CODES = 10;
const MAX_USES_CHOICES = [1, 5, 10, null];      // null = 無制限
const EXPIRE_DAYS_CHOICES = [1, 7, 30, null];   // null = 期限なし
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID = { error: '招待コードが無効か、期限切れです' };

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[bytes[i] % ALPHABET.length];
  return c;
}

// 入力のゆれ(小文字・ハイフン・空白)を吸収する
function normalizeCode(v) {
  if (typeof v !== 'string' || v.length > 40) return null;
  const c = v.toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{8}$/.test(c) ? c : null;
}

// 総当たり対策: コードを入れる試行は人ごとに15分で20回まで(ログイン前は来ないので必ずuserIdがある)
const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'u:' + req.userId,
  validate: { keyGeneratorIpFallback: false },
  message: { error: '試行が多すぎます。しばらくしてからお試しください' },
});

function toInvite(r, now) {
  const expiresAt = r.expires_ms == null ? null : Number(r.expires_ms);
  const maxUses = r.max_uses == null ? null : Number(r.max_uses);
  const uses = Number(r.uses) || 0;
  return {
    code: r.code,
    maxUses,
    uses,
    expiresAt,
    expired: expiresAt != null && expiresAt <= now,
    full: maxUses != null && uses >= maxUses,
    createdAt: Number(r.created_ms),
  };
}

// 友だちの関係が変わったことを両方の開いている画面に知らせる(friends.js と同じ)
function notifyFriendChange(a, b) {
  try {
    const ws = require('../ws/wsServer');
    if (ws.forgetPresenceContacts) { ws.forgetPresenceContacts(a); ws.forgetPresenceContacts(b); }
    ws.broadcastToUser(a, { type: 'friends_changed', kind: 'accepted' });
    ws.broadcastToUser(b, { type: 'friends_changed', kind: 'accepted' });
  } catch (_) {}
}

// 自分のコード一覧(新しい順)
router.get('/', auth, async (req, res) => {
  try {
    const now = Date.now();
    const rows = await db.all('SELECT * FROM invite_codes WHERE owner_id = ? ORDER BY created_ms DESC', [req.userId]);
    res.json({ codes: rows.map(r => toInvite(r, now)) });
  } catch (e) { sendServerError(res, e); }
});

// コードを作る
router.post('/', auth, async (req, res) => {
  try {
    const body = req.body || {};
    const maxUses = body.maxUses === undefined ? 10 : body.maxUses;
    const days = body.expiresInDays === undefined ? 7 : body.expiresInDays;
    if (!MAX_USES_CHOICES.includes(maxUses) || !EXPIRE_DAYS_CHOICES.includes(days)) {
      return res.status(400).json({ error: '人数または期限の指定が正しくありません' });
    }
    const now = Date.now();
    // 同時に有効なコードの数。期限切れ・使い切りは数えない(溜まった物は一覧から消せる)
    const cnt = await db.get(
      `SELECT COUNT(*) AS c FROM invite_codes
        WHERE owner_id = ? AND (expires_ms IS NULL OR expires_ms > ?) AND (max_uses IS NULL OR uses < max_uses)`,
      [req.userId, now]
    );
    if (Number(cnt && cnt.c) >= MAX_ACTIVE_CODES) {
      return res.status(400).json({ error: `有効なコードは${MAX_ACTIVE_CODES}個までです。使わないコードを削除してください` });
    }
    // 重複は主キーで弾かれる(40bitなのでほぼ起きない)。念のため数回だけ作り直す
    let code = null;
    for (let i = 0; i < 5 && !code; i++) {
      const c = generateCode();
      try {
        await db.run(
          'INSERT INTO invite_codes (code, owner_id, max_uses, uses, expires_ms, created_ms) VALUES (?, ?, ?, 0, ?, ?)',
          [c, req.userId, maxUses, days == null ? null : now + days * DAY_MS, now]
        );
        code = c;
      } catch (e) {
        if (!/unique|constraint|duplicate/i.test(String(e && e.message))) throw e;
      }
    }
    if (!code) return res.status(500).json({ error: 'コードを作れませんでした。もう一度お試しください' });
    const row = await db.get('SELECT * FROM invite_codes WHERE code = ?', [code]);
    res.json({ ok: true, invite: toInvite(row, now) });
  } catch (e) { sendServerError(res, e); }
});

// 自分のコードを消す(消したコードは、まだ使っていない人には使えなくなる。すでに友だちになった人はそのまま)
router.delete('/:code', auth, async (req, res) => {
  try {
    const code = normalizeCode(req.params.code);
    if (!code) return res.status(404).json({ error: 'not found' });
    const row = await db.get('SELECT owner_id FROM invite_codes WHERE code = ?', [code]);
    if (!row || row.owner_id !== req.userId) return res.status(404).json({ error: 'not found' });
    await db.run('DELETE FROM invite_redemptions WHERE code = ?', [code]);
    await db.run('DELETE FROM invite_codes WHERE code = ? AND owner_id = ?', [code, req.userId]);
    res.json({ ok: true });
  } catch (e) { sendServerError(res, e); }
});

// コードを入れて友だちになる
router.post('/redeem', auth, redeemLimiter, async (req, res) => {
  try {
    const me = req.userId;
    const code = normalizeCode(req.body && req.body.code);
    if (!code) return res.status(404).json(INVALID);

    const inv = await db.get('SELECT * FROM invite_codes WHERE code = ?', [code]);
    if (!inv) return res.status(404).json(INVALID);
    const owner = await db.get(
      "SELECT id, user_id, display_name, profile_pic FROM users WHERE id = ? AND substr(username, 1, 8) != 'deleted_'",
      [inv.owner_id]
    );
    if (!owner) return res.status(404).json(INVALID);
    if (owner.id === me) return res.status(400).json({ error: '自分のコードは使えません' });

    // どちらかがブロックしている相手とは友だちにならない。理由は悟らせず「無効」と同じ返事にする
    const bs = await blockState(me, owner.id);
    if (bs.byMe || bs.byThem) return res.status(404).json(INVALID);

    const friend = { userId: owner.id, userIdCode: owner.user_id, displayName: owner.display_name, profilePic: owner.profile_pic };
    const [a, b] = [me, owner.id].sort();
    const existing = await db.get('SELECT id, status FROM friendships WHERE user_a_id = ? AND user_b_id = ?', [a, b]);
    if (existing && existing.status === 'accepted') return res.json({ ok: true, already: true, friend });

    const now = Date.now();
    // 使用の記録を先に入れる(主キー=コード+人)。同じ人が同時に2回送っても、人数を消費するのは1回だけ。
    // 前に同じコードを使った人(友だちを削除したあとなど)は記録が残っているので、人数を消費せずにもう一度つながれる
    const ins = await db.run(
      'INSERT INTO invite_redemptions (code, user_id, redeemed_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
      [code, me, now]
    );
    const claimed = !!(ins && ins.changes);
    if (claimed) {
      // 人数の消費は1文で行う(同時に使われても上限を超えない)
      const r = await db.run(
        `UPDATE invite_codes SET uses = uses + 1
          WHERE code = ? AND (expires_ms IS NULL OR expires_ms > ?) AND (max_uses IS NULL OR uses < max_uses)`,
        [code, now]
      );
      if (!r || !r.changes) {
        await db.run('DELETE FROM invite_redemptions WHERE code = ? AND user_id = ?', [code, me]).catch(() => {});
        return res.status(404).json(INVALID);
      }
    } else if (inv.expires_ms != null && Number(inv.expires_ms) <= now) {
      return res.status(404).json(INVALID); // 使った事のあるコードでも、期限が切れていれば再利用できない
    }

    try {
      const iso = new Date().toISOString();
      // 「無ければ作る→申請の途中なら承認済みにする」を、同時に来ても落ちない形で行う。
      // (以前は先に存在確認してから INSERT していたので、同じ人の同時送信で一意制約に当たって500になり、使用記録も巻き戻っていた)
      // 持ち主から誘った形にする(requested_by = 持ち主)
      await db.run(
        "INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by, requested_at, accepted_at) VALUES (?, ?, ?, 'accepted', ?, ?, ?) ON CONFLICT DO NOTHING",
        [uuidv4(), a, b, owner.id, iso, iso]
      );
      await db.run(
        "UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE user_a_id = ? AND user_b_id = ? AND status <> 'accepted'",
        [iso, a, b]
      );
    } catch (e) {
      // 友だちにできなかったなら、人数の消費も元に戻す
      if (claimed) {
        await db.run('DELETE FROM invite_redemptions WHERE code = ? AND user_id = ?', [code, me]).catch(() => {});
        await db.run('UPDATE invite_codes SET uses = uses - 1 WHERE code = ? AND uses > 0', [code]).catch(() => {});
      }
      throw e;
    }

    notifyFriendChange(me, owner.id);
    res.json({ ok: true, already: false, friend });
  } catch (e) { sendServerError(res, e); }
});

module.exports = router;
