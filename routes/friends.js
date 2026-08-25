// routes/friends.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendServerError } = require('../utils/errorResponse');
// 以前はここに `function auth(req,res,next){ jwt.verify... }` という
// 独自実装があり、auth.js/messages.js/push.jsにもほぼ同じものが個別に
// 存在していた(JWT_SECRETの重複ハードコードと同種の問題)。
// 認証ロジックを1箇所に統一し、トークン失効チェックも一律に効くようにする。
const { verifyToken: auth } = require('../utils/authMiddleware');

const router = express.Router();

// 自分のプロフィール取得
router.get('/me', auth, async (req, res) => {
  try {
    const user = await db.get('SELECT id, user_id, username, display_name, profile_pic, bio, public_key FROM users WHERE id = ?', [req.userId]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ userId: user.id, userIdCode: user.user_id, username: user.username, displayName: user.display_name, profilePic: user.profile_pic, bio: user.bio, publicKey: user.public_key });
  } catch (e) {
    sendServerError(res, e);
  }
});

// プロフィール画像として許可する形式: data:image/ URI (クライアント側で撮影・選択した画像を
// Base64化したもの) または https:// URL (Google等の外部プロフィール画像) のみ。
// 以前はここに検証が一切無く、任意の文字列をそのまま保存できた。
// クライアント側(talklist.html等)がこの値を `style="background-image:url(${profilePic})"`
// のようにHTML属性へ直接埋め込んでいる箇所があり、二重引用符(")や山括弧などを
// 含む文字列を送り込むとHTML/JS注入(XSS)が成立してしまう危険な組み合わせだった。
// 入り口(ここ)で形式を厳格に制限することで、出口側の描画コードにバグが
// 残っていても実害が出ないようにする(多層防御)。
function isValidProfilePic(value) {
  if (!value) return true; // 未設定/空文字は許可(削除扱い)
  if (typeof value !== 'string') return false;
  if (value.length > 3 * 1024 * 1024) return false; // 3MB相当を超えるBase64は拒否
  return /^data:image\/(png|jpe?g|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(value)
      || /^https:\/\/[a-zA-Z0-9.\-]+(\/[^\s"'<>]*)?$/.test(value);
}

// プロフィール更新
router.post('/me', auth, async (req, res) => {
  try {
    const { displayName, bio, profilePic, publicKey } = req.body;
    // 表示名・自己紹介は無制限だとUIレイアウト崩壊やDB肥大化の原因になるため上限を設ける
    if (displayName && displayName.length > 50) {
      return res.status(400).json({ error: '表示名は50文字以内にしてください' });
    }
    if (bio && bio.length > 500) {
      return res.status(400).json({ error: '自己紹介は500文字以内にしてください' });
    }
    if (profilePic !== undefined) {
      if (!isValidProfilePic(profilePic)) {
        return res.status(400).json({ error: 'プロフィール画像の形式が不正です' });
      }
      await db.run('UPDATE users SET display_name = ?, bio = ?, profile_pic = ? WHERE id = ?', [displayName || '', bio || '', profilePic, req.userId]);
    } else {
      await db.run('UPDATE users SET display_name = ?, bio = ? WHERE id = ?', [displayName || '', bio || '', req.userId]);
    }
    // publicKey が含まれていた場合もここで処理する（/api/friends/publickey と同等）
    if (publicKey) {
      await db.run('UPDATE users SET public_key = ? WHERE id = ?', [publicKey, req.userId]);
    }
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e);
  }
});

// E2E暗号化用の公開鍵を登録（初回ログイン時にクライアントが自動で呼ぶ）
router.post('/publickey', auth, async (req, res) => {
  try {
    const { publicKey } = req.body;
    if (!publicKey) return res.status(400).json({ error: 'publicKey required' });
    await db.run('UPDATE users SET public_key = ? WHERE id = ?', [publicKey, req.userId]);
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e);
  }
});

// 特定ユーザーの公開鍵を取得（メッセージ暗号化のため）
router.get('/publickey/:userId', auth, async (req, res) => {
  try {
    const user = await db.get('SELECT public_key FROM users WHERE id = ?', [req.params.userId]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    res.json({ publicKey: user.public_key });
  } catch (e) {
    sendServerError(res, e);
  }
});

// IDで検索
router.get('/search', auth, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const results = await db.all(
      'SELECT id, user_id, display_name, profile_pic FROM users WHERE (user_id LIKE ? OR display_name LIKE ?) AND id != ? LIMIT 10',
      [q + '%', '%' + q + '%', req.userId]
    );
    res.json(results.map(u => ({ userId: u.id, userIdCode: u.user_id, displayName: u.display_name, profilePic: u.profile_pic })));
  } catch (e) {
    sendServerError(res, e);
  }
});

// 友達リクエスト送信
router.post('/request', auth, async (req, res) => {
  try {
    const { targetUserIdCode } = req.body;
    if (!targetUserIdCode) return res.status(400).json({ error: 'targetUserIdCode required' });

    const targetUser = await db.get('SELECT id FROM users WHERE user_id = ?', [targetUserIdCode]);
    if (!targetUser) return res.status(404).json({ error: 'user not found' });
    if (targetUser.id === req.userId) return res.status(400).json({ error: 'cannot add yourself' });

    const [userA, userB] = [req.userId, targetUser.id].sort();
    const existing = await db.get('SELECT id, status FROM friendships WHERE user_a_id = ? AND user_b_id = ?', [userA, userB]);
    if (existing) return res.status(400).json({ error: existing.status === 'accepted' ? 'already friends' : 'request already sent' });

    const friendshipId = uuidv4();
    await db.run('INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by) VALUES (?, ?, ?, ?, ?)', [friendshipId, userA, userB, 'pending', req.userId]);
    res.json({ ok: true, friendshipId });
  } catch (e) {
    sendServerError(res, e);
  }
});

// 友達リクエスト承認
router.post('/accept', auth, async (req, res) => {
  try {
    const { friendshipId } = req.body;
    const friendship = await db.get('SELECT * FROM friendships WHERE id = ?', [friendshipId]);
    if (!friendship) return res.status(404).json({ error: 'not found' });
    if (friendship.status !== 'pending') return res.status(400).json({ error: 'not pending' });
    // 当事者チェック: この友達リクエストの送信者・受信者いずれかでなければ拒否する。
    // 以前はこのチェックが無く、「requested_by !== req.userId」という条件は
    // 「送信者自身による自己承認」しか防げていなかった。つまりfriendshipIdさえ
    // 知っていれば、無関係な第三者でも他人同士の友達リクエストを勝手に承認
    // できてしまう認可漏れがあった。
    if (friendship.user_a_id !== req.userId && friendship.user_b_id !== req.userId) {
      return res.status(403).json({ error: 'not authorized' });
    }
    if (friendship.requested_by === req.userId) return res.status(403).json({ error: 'not authorized' });

    const now = new Date().toISOString();
    await db.run("UPDATE friendships SET status = 'accepted', accepted_at = ? WHERE id = ?", [now, friendshipId]);
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e);
  }
});

// 友達リスト
router.get('/list', auth, async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as friend_id FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'accepted'",
      [req.userId, req.userId, req.userId]
    );
    if (!rows.length) return res.json([]);
    const ids = rows.map(r => r.friend_id);
    const placeholders = ids.map(() => '?').join(',');
    const friends = await db.all(`SELECT id, user_id, display_name, profile_pic, public_key FROM users WHERE id IN (${placeholders})`, ids);
    res.json(friends.map(u => ({ userId: u.id, userIdCode: u.user_id, displayName: u.display_name, profilePic: u.profile_pic, publicKey: u.public_key })));
  } catch (e) {
    sendServerError(res, e);
  }
});

// ペンディングリクエスト
router.get('/pending', auth, async (req, res) => {
  try {
    const rows = await db.all(
      "SELECT id, user_a_id, user_b_id, requested_by FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'pending'",
      [req.userId, req.userId]
    );
    if (!rows.length) return res.json([]);
    const result = [];
    for (const r of rows) {
      const otherId = r.user_a_id === req.userId ? r.user_b_id : r.user_a_id;
      const other = await db.get('SELECT id, user_id, display_name, profile_pic FROM users WHERE id = ?', [otherId]);
      if (other) result.push({ friendshipId: r.id, userId: other.id, userIdCode: other.user_id, displayName: other.display_name, profilePic: other.profile_pic, isSentByMe: r.requested_by === req.userId });
    }
    res.json(result);
  } catch (e) {
    sendServerError(res, e);
  }
});

module.exports = router;
