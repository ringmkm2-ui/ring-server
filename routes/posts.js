// routes/posts.js
// -----------------------------------------------------------------------
// 投稿(タイムライン)機能。友達関係を問わず、アプリ内の全ユーザーが
// 投稿・閲覧・いいね・コメントできる。E2E暗号化は行わない
// (最初から全員に公開される前提のコンテンツのため、メッセージの
// ような相手を限定した暗号化の必要性がない)。
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { sendServerError } = require('../utils/errorResponse');
const { asyncHandler } = require('../utils/asyncHandler');
const { rejectIfProfane, censorBodyAndBanAfter } = require('../utils/moderation');
const { isBlockedEither } = require('../utils/relations');

const router = express.Router();

// メディアはメッセージの画像送信と同様、Base64データURIをそのまま保存する
// シンプルな方式。動画も含めるため、上限をやや大きめの30MBにしておく
// (express.jsonのlimitは index.js で 50mb に設定済み)。

function isValidMediaUrl(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  // 投稿メディアはCloudinaryに直接アップロードされたURLだけ。
  // 以前は Base64 の data: URI (最大約40MB)も受け付けていて、数件投稿するだけで
  // タイムラインを開いた人ごとにサーバーのメモリを使い切れた
  if (value.length > 500) return false;
  if (/^https:\/\/res\.cloudinary\.com\/[a-zA-Z0-9_-]+\/[A-Za-z0-9_\-./%]+$/.test(value)) return true;
  // 100MBを超える動画はGoogleドライブ(このサーバーの /m/p/<id>)に置く
  return !!driveIdOf(value);
}
const SELF_HOSTS = new Set(['ring-server-50sy.onrender.com', ...String(process.env.PUBLIC_BASE_URL || '').replace(/^https?:\/\//, '').split(/[\/,]/).filter(Boolean)]);
function driveIdOf(url) {
  const m = /^https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/m\/p\/([A-Za-z0-9_-]{10,100})$/.exec(url || '');
  if (!m) return null;
  const okHost = SELF_HOSTS.has(m[1]) && url.startsWith('https:') || process.env.NODE_ENV !== 'production' && /^localhost(:\d+)?$/.test(m[1]);
  return okHost ? m[2] : null;
}

// 投稿者情報を付与して返すための共通SELECT。JOINで都度取得すると
// N+1になるため、一覧取得時は一括JOINする。
async function attachAuthorAndStats(posts, myUserId) {
  if (posts.length === 0) return [];
  const ids = posts.map(p => p.id);
  const placeholders = ids.map(() => '?').join(',');

  const authors = await db.all(
    `SELECT id, display_name, profile_pic FROM users WHERE id IN (${[...new Set(posts.map(p => p.author_id))].map(() => '?').join(',')})`,
    [...new Set(posts.map(p => p.author_id))]
  );
  const authorMap = new Map(authors.map(a => [a.id, a]));

  const likeCounts = await db.all(
    `SELECT post_id, COUNT(*) as cnt FROM post_likes WHERE post_id IN (${placeholders}) GROUP BY post_id`,
    ids
  );
  const likeCountMap = new Map(likeCounts.map(l => [l.post_id, l.cnt]));

  const myLikes = await db.all(
    `SELECT post_id FROM post_likes WHERE post_id IN (${placeholders}) AND user_id = ?`,
    [...ids, myUserId]
  );
  const myLikeSet = new Set(myLikes.map(l => l.post_id));

  const commentCounts = await db.all(
    `SELECT post_id, COUNT(*) as cnt FROM post_comments WHERE post_id IN (${placeholders}) AND deleted_at IS NULL GROUP BY post_id`,
    ids
  );
  const commentCountMap = new Map(commentCounts.map(c => [c.post_id, c.cnt]));

  // チャンネル(=投稿者)の登録者数と、自分が登録しているか。YouTubeの「登録者」「登録済み」表示用。
  const authorIds = [...new Set(posts.map(p => p.author_id))];
  const subCounts = await db.all(
    `SELECT channel_id, COUNT(*) as cnt FROM user_subscriptions WHERE channel_id IN (${authorIds.map(() => '?').join(',')}) GROUP BY channel_id`,
    authorIds
  );
  const subCountMap = new Map(subCounts.map(s => [s.channel_id, s.cnt]));
  const mySubs = await db.all(
    `SELECT channel_id FROM user_subscriptions WHERE subscriber_id = ? AND channel_id IN (${authorIds.map(() => '?').join(',')})`,
    [myUserId, ...authorIds]
  );
  const mySubSet = new Set(mySubs.map(s => s.channel_id));

  return posts.map(p => {
    const author = authorMap.get(p.author_id);
    return {
      id: p.id,
      authorId: p.author_id,
      authorName: author?.display_name || '不明なユーザー',
      authorPic: author?.profile_pic || null,
      text: p.text,
      mediaUrl: p.media_url,
      mediaType: p.media_type,
      createdAt: p.created_at,
      editedAt: p.edited_at,
      likeCount: Number(likeCountMap.get(p.id) || 0),
      likedByMe: myLikeSet.has(p.id),
      commentCount: Number(commentCountMap.get(p.id) || 0),
      viewCount: Number(p.view_count || 0),
      durationSec: p.duration_sec != null ? Number(p.duration_sec) : null,
      subscriberCount: Number(subCountMap.get(p.author_id) || 0),
      subscribedByMe: mySubSet.has(p.author_id),
    };
  });
}

// --- 投稿一覧取得(タイムライン、新しい順) ---
// query: ?before=<ISO日時> でページング(その日時より古い投稿を取得)
router.get('/', verifyToken, asyncHandler(async (req, res) => {
  // 日時として読めない値(配列や変な文字列)はDBでエラー(500)になるので無視する
  const before = typeof req.query.before === 'string' && req.query.before.length < 40 && !isNaN(Date.parse(req.query.before)) ? req.query.before : null;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

  // ブロックしている/されている相手の投稿は出さない(以前はタイムラインにそのまま出ていた)
  const me = req.user.userId;
  // ?channel=<userId> で特定チャンネル(投稿者)だけ。?filter=subscribed で登録中のチャンネルだけ。
  const channel = typeof req.query.channel === 'string' && req.query.channel.length < 60 ? req.query.channel : null;
  const subscribedOnly = req.query.filter === 'subscribed';

  const where = ['deleted_at IS NULL',
    'author_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)',
    'author_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = ?)'];
  const args = [me, me];
  if (before) { where.push('created_at < ?'); args.push(before); }
  if (channel) { where.push('author_id = ?'); args.push(channel); }
  if (subscribedOnly) { where.push('author_id IN (SELECT channel_id FROM user_subscriptions WHERE subscriber_id = ?)'); args.push(me); }
  args.push(limit);

  const rows = await db.all(
    `SELECT * FROM posts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
    args
  );

  const posts = await attachAuthorAndStats(rows, req.user.userId);
  res.json(posts);
}));

// --- 自分がいいねした投稿(アカウント > いいね) ---
// いいねした順(新しい順)。ブロック関係の投稿・消した投稿は出さない
router.get('/liked', verifyToken, asyncHandler(async (req, res) => {
  const me = req.user.userId;
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 50);
  const before = typeof req.query.before === 'string' && req.query.before.length < 40 && !isNaN(Date.parse(req.query.before)) ? req.query.before : null;
  const args = [me, me, me];
  let cond = '';
  if (before) { cond = ' AND l.created_at < ?'; args.push(before); }
  args.push(limit);
  const rows = await db.all(
    `SELECT p.*, l.created_at AS liked_at FROM post_likes l JOIN posts p ON p.id = l.post_id
      WHERE l.user_id = ? AND p.deleted_at IS NULL
        AND p.author_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
        AND p.author_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = ?)${cond}
      ORDER BY l.created_at DESC LIMIT ?`, args);
  const posts = await attachAuthorAndStats(rows, me);
  const likedAt = new Map(rows.map(r => [r.id, r.liked_at]));
  res.json(posts.map(p => ({ ...p, likedAt: likedAt.get(p.id) || null })));
}));

// --- 自分が登録しているチャンネル(アカウント > 登録チャンネル) ---
router.get('/subscriptions', verifyToken, asyncHandler(async (req, res) => {
  const me = req.user.userId;
  const rows = await db.all(
    `SELECT u.id, u.display_name, u.profile_pic, s.created_at AS since
       FROM user_subscriptions s JOIN users u ON u.id = s.channel_id
      WHERE s.subscriber_id = ?
        AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
        AND u.id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = ?)
      ORDER BY s.created_at DESC LIMIT 500`, [me, me, me]);
  if (!rows.length) return res.json([]);
  const ids = rows.map(r => r.id);
  const ph = ids.map(() => '?').join(',');
  const counts = await db.all(`SELECT channel_id, COUNT(*) AS cnt FROM user_subscriptions WHERE channel_id IN (${ph}) GROUP BY channel_id`, ids);
  const cm = new Map(counts.map(c => [c.channel_id, Number(c.cnt)]));
  res.json(rows.map(r => ({ id: r.id, name: r.display_name || '不明なユーザー', pic: r.profile_pic || null, since: r.since, subscriberCount: cm.get(r.id) || 0 })));
}));

// --- 自分のチャンネルの登録者(誰が登録したか)。本人だけが見られる ---
router.get('/channel/:channelId/subscribers', verifyToken, asyncHandler(async (req, res) => {
  const me = req.user.userId;
  if (req.params.channelId !== me) return res.status(403).json({ error: '自分のチャンネルの登録者だけ見られます' });
  const rows = await db.all(
    `SELECT u.id, u.display_name, u.profile_pic, s.created_at AS since
       FROM user_subscriptions s JOIN users u ON u.id = s.subscriber_id
      WHERE s.channel_id = ?
        AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
        AND u.id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = ?)
      ORDER BY s.created_at DESC LIMIT 500`, [me, me, me]);
  res.json(rows.map(r => ({ id: r.id, name: r.display_name || '不明なユーザー', pic: r.profile_pic || null, since: r.since })));
}));

// --- 投稿にいいねした人(誰がいいねしたか)。投稿者本人だけが見られる ---
router.get('/:postId/likes', verifyToken, asyncHandler(async (req, res) => {
  const me = req.user.userId;
  const post = await db.get('SELECT author_id FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.postId]);
  if (!post) return res.status(404).json({ error: '投稿が見つかりません' });
  if (post.author_id !== me) return res.status(403).json({ error: '自分の投稿のいいねだけ見られます' });
  const rows = await db.all(
    `SELECT u.id, u.display_name, u.profile_pic, l.created_at AS at
       FROM post_likes l JOIN users u ON u.id = l.user_id
      WHERE l.post_id = ?
        AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
        AND u.id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = ?)
      ORDER BY l.created_at DESC LIMIT 500`, [req.params.postId, me, me]);
  res.json(rows.map(r => ({ id: r.id, name: r.display_name || '不明なユーザー', pic: r.profile_pic || null, at: r.at })));
}));

// --- 投稿作成 ---
router.post('/', verifyToken, asyncHandler(async (req, res) => {
  censorBodyAndBanAfter(req, res, ['text']); // 禁止語は f*** にして投稿、本人は3日間停止
  const { text, mediaUrl, mediaType } = req.body;

  if ((text != null && typeof text !== 'string') || (mediaUrl != null && typeof mediaUrl !== 'string')) {
    return res.status(400).json({ error: '入力の形式が正しくありません' });
  }
  if (!text && !mediaUrl) {
    return res.status(400).json({ error: 'テキストまたはメディアが必要です' });
  }
  if (text && text.length > 2000) {
    return res.status(400).json({ error: '投稿は2000文字以内にしてください' });
  }
  if (mediaUrl && !isValidMediaUrl(mediaUrl)) {
    return res.status(400).json({ error: 'メディアの形式が不正です' });
  }
  if (mediaUrl && !['image', 'video'].includes(mediaType)) {
    return res.status(400).json({ error: 'mediaTypeが不正です' });
  }
  // 動画の再生時間(秒)。クライアントがアップロード時に測った値。0〜24時間の整数だけ受け付ける。
  let durationSec = null;
  if (mediaUrl && mediaType === 'video') {
    const d = Math.round(Number(req.body.durationSec));
    if (Number.isFinite(d) && d > 0 && d <= 86400) durationSec = d;
  }

  const id = uuidv4();
  await db.run(
    'INSERT INTO posts (id, author_id, text, media_url, media_type, duration_sec) VALUES (?, ?, ?, ?, ?, ?)',
    [id, req.user.userId, text || null, mediaUrl || null, mediaUrl ? mediaType : null, durationSec]
  );

  const row = await db.get('SELECT * FROM posts WHERE id = ?', [id]);
  const [post] = await attachAuthorAndStats([row], req.user.userId);
  res.json({ ok: true, post });
}));

// --- 投稿削除(投稿者本人のみ) ---
router.delete('/:postId', verifyToken, asyncHandler(async (req, res) => {
  const post = await db.get('SELECT * FROM posts WHERE id = ?', [req.params.postId]);
  if (!post) return res.status(404).json({ error: '投稿が見つかりません' });
  if (post.author_id !== req.user.userId) {
    return res.status(403).json({ error: '自分の投稿のみ削除できます' });
  }
  await db.run('UPDATE posts SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.postId]);
  // ドライブに置いた動画は、投稿を消したら一緒に消す(容量を空ける)
  const did = driveIdOf(post.media_url);
  if (did) require('./drive').removeOwned(req.user.userId, did).catch(e => console.warn('[posts] drive remove failed:', e.message));
  res.json({ ok: true });
}));

// --- いいねのトグル ---
router.post('/:postId/like', verifyToken, asyncHandler(async (req, res) => {
  const post = await db.get('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.postId]);
  if (!post) return res.status(404).json({ error: '投稿が見つかりません' });

  const existing = await db.get(
    'SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?',
    [req.params.postId, req.user.userId]
  );

  if (existing) {
    await db.run('DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [req.params.postId, req.user.userId]);
    res.json({ ok: true, liked: false });
  } else {
    await db.run('INSERT INTO post_likes (post_id, user_id) VALUES (?, ?)', [req.params.postId, req.user.userId]);
    res.json({ ok: true, liked: true });
  }
}));

// --- コメント一覧取得 ---
router.get('/:postId/comments', verifyToken, asyncHandler(async (req, res) => {
  // 消された投稿のコメントは見せない。ブロック関係の人のコメントも出さない
  const rows = await db.all(
    `SELECT * FROM post_comments WHERE post_id = ? AND deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM posts p WHERE p.id = post_comments.post_id AND p.deleted_at IS NULL)
       AND author_id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?) AND author_id NOT IN (SELECT blocker_id FROM user_blocks WHERE blocked_id = ?)
     ORDER BY created_at ASC`,
    [req.params.postId, req.user.userId, req.user.userId]
  );
  if (rows.length === 0) return res.json([]);

  const authorIds = [...new Set(rows.map(r => r.author_id))];
  const authors = await db.all(
    `SELECT id, display_name, profile_pic FROM users WHERE id IN (${authorIds.map(() => '?').join(',')})`,
    authorIds
  );
  const authorMap = new Map(authors.map(a => [a.id, a]));

  res.json(rows.map(c => {
    const author = authorMap.get(c.author_id);
    return {
      id: c.id,
      postId: c.post_id,
      authorId: c.author_id,
      authorName: author?.display_name || '不明なユーザー',
      authorPic: author?.profile_pic || null,
      text: c.text,
      createdAt: c.created_at,
    };
  }));
}));

// --- コメント作成 ---
router.post('/:postId/comments', verifyToken, asyncHandler(async (req, res) => {
  censorBodyAndBanAfter(req, res, ['text']);
  const { text } = req.body;
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'コメントを入力してください' });
  if (text.length > 500) return res.status(400).json({ error: 'コメントは500文字以内にしてください' });

  const post = await db.get('SELECT id FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.postId]);
  if (!post) return res.status(404).json({ error: '投稿が見つかりません' });

  const id = uuidv4();
  await db.run(
    'INSERT INTO post_comments (id, post_id, author_id, text) VALUES (?, ?, ?, ?)',
    [id, req.params.postId, req.user.userId, text.trim()]
  );

  const me = await db.get('SELECT display_name, profile_pic FROM users WHERE id = ?', [req.user.userId]);
  res.json({
    ok: true,
    comment: {
      id,
      postId: req.params.postId,
      authorId: req.user.userId,
      authorName: me?.display_name || '不明なユーザー',
      authorPic: me?.profile_pic || null,
      text: text.trim(),
      createdAt: new Date().toISOString(),
    },
  });
}));

// --- コメント削除(コメント投稿者本人のみ) ---
router.delete('/comments/:commentId', verifyToken, asyncHandler(async (req, res) => {
  const comment = await db.get('SELECT * FROM post_comments WHERE id = ?', [req.params.commentId]);
  if (!comment) return res.status(404).json({ error: 'コメントが見つかりません' });
  if (comment.author_id !== req.user.userId) {
    return res.status(403).json({ error: '自分のコメントのみ削除できます' });
  }
  await db.run('UPDATE post_comments SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [req.params.commentId]);
  res.json({ ok: true });
}));

// --- 再生回数を数える(1ユーザー1回まで) ---
// YouTubeの「再生回数」。同じ人が何度開いても1回。視聴者本人の投稿でも数える(YouTube同様)。
router.post('/:postId/view', verifyToken, asyncHandler(async (req, res) => {
  const post = await db.get('SELECT view_count FROM posts WHERE id = ? AND deleted_at IS NULL', [req.params.postId]);
  if (!post) return res.status(404).json({ error: '投稿が見つかりません' });
  const seen = await db.get('SELECT 1 AS x FROM post_views WHERE post_id = ? AND user_id = ?', [req.params.postId, req.user.userId]);
  if (!seen) {
    try {
      await db.run('INSERT INTO post_views (post_id, user_id) VALUES (?, ?)', [req.params.postId, req.user.userId]);
      await db.run('UPDATE posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?', [req.params.postId]);
    } catch (_) { /* 同時に二重で来たらPK重複で弾かれる。二重カウントを防ぐのが目的なので無視 */ }
  }
  const row = await db.get('SELECT view_count FROM posts WHERE id = ?', [req.params.postId]);
  res.json({ ok: true, viewCount: Number(row?.view_count || 0) });
}));

// --- チャンネル(=投稿者)登録のトグル ---
router.post('/channel/:channelId/subscribe', verifyToken, asyncHandler(async (req, res) => {
  const channelId = req.params.channelId;
  if (channelId === req.user.userId) return res.status(400).json({ error: '自分のチャンネルには登録できません' });
  const ch = await db.get('SELECT id FROM users WHERE id = ?', [channelId]);
  if (!ch) return res.status(404).json({ error: 'チャンネルが見つかりません' });
  const existing = await db.get('SELECT 1 AS x FROM user_subscriptions WHERE subscriber_id = ? AND channel_id = ?', [req.user.userId, channelId]);
  let subscribed;
  if (existing) {
    await db.run('DELETE FROM user_subscriptions WHERE subscriber_id = ? AND channel_id = ?', [req.user.userId, channelId]);
    subscribed = false;
  } else {
    try { await db.run('INSERT INTO user_subscriptions (subscriber_id, channel_id) VALUES (?, ?)', [req.user.userId, channelId]); } catch (_) {}
    subscribed = true;
  }
  const c = await db.get('SELECT COUNT(*) AS cnt FROM user_subscriptions WHERE channel_id = ?', [channelId]);
  res.json({ ok: true, subscribed, subscriberCount: Number(c?.cnt || 0) });
}));

// --- チャンネル情報(ヘッダー表示用) ---
router.get('/channel/:channelId', verifyToken, asyncHandler(async (req, res) => {
  const channelId = req.params.channelId;
  const me = req.user.userId;
  const u = await db.get('SELECT id, display_name, profile_pic, bio, created_at FROM users WHERE id = ?', [channelId]);
  if (!u) return res.status(404).json({ error: 'チャンネルが見つかりません' });
  // ブロック関係の相手のチャンネルは存在しないのと同じ扱い(フィードと同じ)
  if (channelId !== me && await isBlockedEither(me, channelId)) return res.status(404).json({ error: 'チャンネルが見つかりません' });
  const c = await db.get('SELECT COUNT(*) AS cnt FROM user_subscriptions WHERE channel_id = ?', [channelId]);
  const mine = await db.get('SELECT 1 AS x FROM user_subscriptions WHERE subscriber_id = ? AND channel_id = ?', [me, channelId]);
  const pc = await db.get(
    `SELECT COUNT(*) AS cnt, COALESCE(SUM(view_count), 0) AS views,
            SUM(CASE WHEN media_type = 'video' THEN 1 ELSE 0 END) AS videos,
            SUM(CASE WHEN media_type = 'image' THEN 1 ELSE 0 END) AS images
       FROM posts WHERE author_id = ? AND deleted_at IS NULL`, [channelId]);
  res.json({
    id: u.id,
    name: u.display_name || '不明なユーザー',
    pic: u.profile_pic || null,
    bio: typeof u.bio === 'string' ? u.bio.slice(0, 500) : '',
    joinedAt: u.created_at || null,
    subscriberCount: Number(c?.cnt || 0),
    subscribedByMe: !!mine,
    postCount: Number(pc?.cnt || 0),
    videoCount: Number(pc?.videos || 0),
    imageCount: Number(pc?.images || 0),
    totalViews: Number(pc?.views || 0),
  });
}));

router.isValidMediaUrl = isValidMediaUrl;
module.exports = router;
