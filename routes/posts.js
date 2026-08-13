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

const router = express.Router();

// メディアはメッセージの画像送信と同様、Base64データURIをそのまま保存する
// シンプルな方式。動画も含めるため、上限をやや大きめの30MBにしておく
// (express.jsonのlimitは index.js で 50mb に設定済み)。
const MAX_MEDIA_BASE64_LENGTH = 30 * 1024 * 1024 * 1.4; // Base64は元データの約1.37倍になる

function isValidMediaDataUri(value) {
  if (!value) return true;
  if (typeof value !== 'string') return false;
  if (value.length > MAX_MEDIA_BASE64_LENGTH) return false;
  return /^data:(image\/(png|jpe?g|gif|webp)|video\/(mp4|webm|quicktime));base64,[A-Za-z0-9+/=]+$/.test(value);
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
    };
  });
}

// --- 投稿一覧取得(タイムライン、新しい順) ---
// query: ?before=<ISO日時> でページング(その日時より古い投稿を取得)
router.get('/', verifyToken, asyncHandler(async (req, res) => {
  const before = req.query.before;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

  let rows;
  if (before) {
    rows = await db.all(
      'SELECT * FROM posts WHERE deleted_at IS NULL AND created_at < ? ORDER BY created_at DESC LIMIT ?',
      [before, limit]
    );
  } else {
    rows = await db.all(
      'SELECT * FROM posts WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
      [limit]
    );
  }

  const posts = await attachAuthorAndStats(rows, req.user.userId);
  res.json(posts);
}));

// --- 投稿作成 ---
router.post('/', verifyToken, asyncHandler(async (req, res) => {
  const { text, mediaUrl, mediaType } = req.body;

  if (!text && !mediaUrl) {
    return res.status(400).json({ error: 'テキストまたはメディアが必要です' });
  }
  if (text && text.length > 2000) {
    return res.status(400).json({ error: '投稿は2000文字以内にしてください' });
  }
  if (mediaUrl && !isValidMediaDataUri(mediaUrl)) {
    return res.status(400).json({ error: 'メディアの形式が不正です' });
  }
  if (mediaUrl && !['image', 'video'].includes(mediaType)) {
    return res.status(400).json({ error: 'mediaTypeが不正です' });
  }

  const id = uuidv4();
  await db.run(
    'INSERT INTO posts (id, author_id, text, media_url, media_type) VALUES (?, ?, ?, ?, ?)',
    [id, req.user.userId, text || null, mediaUrl || null, mediaUrl ? mediaType : null]
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
  const rows = await db.all(
    'SELECT * FROM post_comments WHERE post_id = ? AND deleted_at IS NULL ORDER BY created_at ASC',
    [req.params.postId]
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
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'コメントを入力してください' });
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

module.exports = router;
