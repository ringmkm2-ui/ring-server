// routes/invites.js
// 友だち招待コード。
//  - 1人が複数のコードを作れる(同時に有効なのは10個まで)
//  - 1つのコードを複数人が使える(人数の上限と期限は作る時に選ぶ)
//  - コードを入れた人と、コードの持ち主は、承認待ちなしでお互いに友だちになる
//    (友だち関係は1行で双方向なので、持ち主の一覧にも相手が出る)
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { verifyToken: auth } = require('../utils/authMiddleware');
const { sendServerError } = require('../utils/errorResponse');
const { blockState } = require('../utils/relations');
const { withLock } = require('../utils/keyedLock');
const { INVALID, normalizeCode, loadInvite, claimInvite, releaseInvite, makeFriends, notifyFriendChange, clearRemoved, wasRemoved } = require('../utils/inviteCore');

const router = express.Router();

// 見間違えやすい 0/O/1/I は使わない。32種類なので乱数バイトの剰余に偏りが出ない。8文字=40bit
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
const MAX_ACTIVE_CODES = 10;
const MAX_USES_CHOICES = [1, 5, 10, null];      // null = 無制限
const EXPIRE_DAYS_CHOICES = [1, 7, 30, null];   // null = 期限なし
const DAY_MS = 24 * 60 * 60 * 1000;

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LEN);
  let c = '';
  for (let i = 0; i < CODE_LEN; i++) c += ALPHABET[bytes[i] % ALPHABET.length];
  return c;
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

// 1つのコードに表示する「使った人」は新しい順に5人まで(全員を返すと無制限コードで重くなる)
const WHO_MAX = 5;

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
    joined: [],
  };
}

// 自分のコード一覧(新しい順)
router.get('/', auth, async (req, res) => {
  try {
    const now = Date.now();
    const rows = await db.all('SELECT * FROM invite_codes WHERE owner_id = ? ORDER BY created_ms DESC LIMIT 100', [req.userId]);
    const codes = rows.map(r => toInvite(r, now));
    if (codes.length) {
      // 誰がこのコードで友だちになったか(退会済みの人は出さない)。コードごとに新しい順で WHO_MAX 人まで
      const ph = codes.map(() => '?').join(',');
      const who = await db.all(
        `SELECT r.code AS code, r.user_id AS user_id, r.redeemed_ms AS redeemed_ms, u.display_name AS display_name
           FROM invite_redemptions r JOIN users u ON u.id = r.user_id
          WHERE r.code IN (${ph}) AND substr(u.username, 1, 8) != 'deleted_'
          ORDER BY r.redeemed_ms DESC LIMIT 500`,
        codes.map(c => c.code)
      );
      const byCode = new Map(codes.map(c => [c.code, c]));
      for (const w of who) {
        const c = byCode.get(w.code);
        if (c && c.joined.length < WHO_MAX) c.joined.push({ userId: w.user_id, displayName: w.display_name, at: Number(w.redeemed_ms) });
      }
    }
    res.json({ codes });
  } catch (e) { sendServerError(res, e); }
});

// コードを作る
router.post('/', auth, (req, res) => withLock('invite-create:' + req.userId, () => createInvite(req, res)));
async function createInvite(req, res) {
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
}

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

    const found = await loadInvite(code);
    if (!found) return res.status(404).json(INVALID);
    const { inv, owner } = found;
    if (owner.id === me) return res.status(400).json({ error: '自分のコードは使えません' });

    // どちらかがブロックしている相手とは友だちにならない。理由は悟らせず「無効」と同じ返事にする
    const bs = await blockState(me, owner.id);
    if (bs.byMe || bs.byThem) return res.status(404).json(INVALID);

    const friend = { userId: owner.id, userIdCode: owner.user_id, displayName: owner.display_name, profilePic: owner.profile_pic };
    const [a, b] = [me, owner.id].sort();
    const existing = await db.get('SELECT status FROM friendships WHERE user_a_id = ? AND user_b_id = ?', [a, b]);
    if (existing && existing.status === 'accepted') return res.json({ ok: true, already: true, friend });

    // 持ち主に外された人は、どのコードでも戻れない。外されたことを悟らせないよう「無効」と同じ返事にする
    if (await wasRemoved(owner.id, me)) return res.status(404).json(INVALID);

    const got = await claimInvite(inv, me);
    if (!got) return res.status(404).json(INVALID);
    try {
      await makeFriends(me, owner.id);
    } catch (e) {
      if (got === 'claimed') await releaseInvite(code, me); // 友だちにできなかったなら、人数の消費も元に戻す
      throw e;
    }
    // 自分が前に外した相手のコードを自分で使ったのは、自分から戻したのと同じ
    await clearRemoved(me, owner.id);
    notifyFriendChange(me, owner.id);
    res.json({ ok: true, already: false, friend });
  } catch (e) { sendServerError(res, e); }
});

module.exports = router;
