// routes/communities.js
// コミュニティ機能 — Discordライクなサーバー/チャンネル構造
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { sendServerError } = require('../utils/errorResponse');

const router = express.Router();

// 招待コード生成(6文字英数字)
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// --- コミュニティ作成 ---
router.post('/', verifyToken, asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'コミュニティ名は必須です' });
  }
  if (name.length > 50) {
    return res.status(400).json({ error: 'コミュニティ名は50文字以内にしてください' });
  }

  const id = uuidv4();
  const inviteCode = generateInviteCode();
  await db.run(
    'INSERT INTO communities (id, name, description, owner_id, invite_code) VALUES (?, ?, ?, ?, ?)',
    [id, name.trim(), description || null, req.user.userId, inviteCode]
  );

  // オーナーを admin ロールで追加
  await db.run(
    'INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, ?)',
    [id, req.user.userId, 'admin']
  );

  // デフォルトチャンネル「一般」を作成
  const channelId = uuidv4();
  await db.run(
    'INSERT INTO community_channels (id, community_id, name, sort_order) VALUES (?, ?, ?, 0)',
    [channelId, id, '一般']
  );

  res.json({ ok: true, community: { id, name: name.trim(), description, inviteCode, channelId } });
}));

// --- 自分が参加しているコミュニティ一覧 ---
router.get('/list', verifyToken, asyncHandler(async (req, res) => {
  const communities = await db.all(
    `SELECT c.id, c.name, c.description, c.icon_url, c.owner_id, c.invite_code, cm.role,
            (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) as member_count
     FROM communities c
     JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ?
     ORDER BY cm.joined_at DESC`,
    [req.user.userId]
  );
  res.json({ ok: true, communities });
}));

// --- 招待コードでコミュニティに参加 ---
router.post('/join', verifyToken, asyncHandler(async (req, res) => {
  const { inviteCode } = req.body;
  if (!inviteCode) return res.status(400).json({ error: '招待コードが必要です' });

  const community = await db.get('SELECT * FROM communities WHERE invite_code = ?', [inviteCode]);
  if (!community) return res.status(404).json({ error: '招待コードが無効です' });

  const existing = await db.get(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?',
    [community.id, req.user.userId]
  );
  if (existing) return res.json({ ok: true, already: true, communityId: community.id, name: community.name });

  await db.run(
    'INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, ?)',
    [community.id, req.user.userId, 'member']
  );

  res.json({ ok: true, communityId: community.id, name: community.name });
}));

// --- コミュニティ詳細(チャンネル一覧含む) ---
router.get('/:id', verifyToken, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'このコミュニティのメンバーではありません' });

  const community = await db.get('SELECT * FROM communities WHERE id = ?', [req.params.id]);
  if (!community) return res.status(404).json({ error: 'コミュニティが見つかりません' });

  const channels = await db.all(
    'SELECT id, name, sort_order FROM community_channels WHERE community_id = ? ORDER BY sort_order',
    [req.params.id]
  );

  const members = await db.all(
    `SELECT u.id, u.display_name, u.profile_pic, cm.role, cm.joined_at
     FROM community_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.community_id = ?
     ORDER BY cm.role DESC, cm.joined_at`,
    [req.params.id]
  );

  res.json({
    ok: true,
    community: {
      id: community.id,
      name: community.name,
      description: community.description,
      iconUrl: community.icon_url,
      ownerId: community.owner_id,
      inviteCode: community.invite_code,
      myRole: member.role,
    },
    channels,
    members,
  });
}));

// --- チャンネルのメッセージ履歴 ---
router.get('/:id/channels/:channelId/messages', verifyToken, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'メンバーではありません' });

  const before = req.query.before;
  let query = `SELECT m.*, u.display_name as sender_name, u.profile_pic as sender_pic
               FROM community_messages m
               JOIN users u ON u.id = m.sender_id
               WHERE m.channel_id = ? AND m.deleted_at IS NULL`;
  const params = [req.params.channelId];

  if (before) {
    query += ' AND m.created_at < ?';
    params.push(before);
  }
  query += ' ORDER BY m.created_at DESC LIMIT 50';

  const messages = await db.all(query, params);
  res.json({ ok: true, messages: messages.reverse() });
}));

// --- チャンネルにメッセージ送信 ---
router.post('/:id/channels/:channelId/messages', verifyToken, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'メンバーではありません' });

  const { content, mediaUrl, mediaType } = req.body;
  if (!content && !mediaUrl) return res.status(400).json({ error: 'メッセージが必要です' });

  const id = uuidv4();
  await db.run(
    'INSERT INTO community_messages (id, channel_id, sender_id, content, media_url, media_type) VALUES (?, ?, ?, ?, ?, ?)',
    [id, req.params.channelId, req.user.userId, content || '', mediaUrl || null, mediaType || null]
  );

  const msg = await db.get(
    `SELECT m.*, u.display_name as sender_name, u.profile_pic as sender_pic
     FROM community_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
    [id]
  );
  res.json({ ok: true, message: msg });
}));

// --- チャンネル追加(admin/ownerのみ) ---
router.post('/:id/channels', verifyToken, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member || member.role !== 'admin') return res.status(403).json({ error: '管理者のみチャンネルを作成できます' });

  const { name } = req.body;
  if (!name || name.length > 30) return res.status(400).json({ error: 'チャンネル名は1-30文字で入力してください' });

  const maxSort = await db.get(
    'SELECT MAX(sort_order) as mx FROM community_channels WHERE community_id = ?',
    [req.params.id]
  );
  const id = uuidv4();
  await db.run(
    'INSERT INTO community_channels (id, community_id, name, sort_order) VALUES (?, ?, ?, ?)',
    [id, req.params.id, name.trim(), (maxSort?.mx || 0) + 1]
  );

  res.json({ ok: true, channel: { id, name: name.trim() } });
}));

// --- コミュニティ退出 ---
router.post('/:id/leave', verifyToken, asyncHandler(async (req, res) => {
  const community = await db.get('SELECT owner_id FROM communities WHERE id = ?', [req.params.id]);
  if (!community) return res.status(404).json({ error: 'コミュニティが見つかりません' });
  if (community.owner_id === req.user.userId) {
    return res.status(400).json({ error: 'オーナーは退出できません。コミュニティを削除してください' });
  }

  await db.run(
    'DELETE FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  res.json({ ok: true });
}));

module.exports = router;
