// routes/groups.js
// グループ作成・招待・削除 + キー・ラチェット(鍵更新)のトリガー
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('./auth');
const { broadcastToUser } = require('../ws/wsServer');

const router = express.Router();

// --- グループ作成 ---
router.post('/create', verifyToken, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'グループ名が必要です' });

  const groupId = uuidv4();
  await db.run('INSERT INTO groups (id, name, owner_id, key_version) VALUES (?, ?, ?, 1)', [groupId, name, req.user.userId]);
  await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, req.user.userId]);

  res.json({ groupId, name, keyVersion: 1 });
});

// --- メンバー招待 ---
// クライアント側が新グループ鍵を生成し、暗号化した鍵を全メンバー分アップロードする想定。
// body: { groupId, targetUsername, encryptedKeysForMembers: [{userId, encryptedGroupKey}] }
router.post('/invite', verifyToken, async (req, res) => {
  const { groupId, targetUsername, encryptedKeysForMembers } = req.body;

  const targetUser = await db.get('SELECT id FROM users WHERE username = ?', [targetUsername]);
  if (!targetUser) return res.status(404).json({ error: 'そのユーザーは見つかりません' });

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });

  const already = await db.get('SELECT * FROM group_members WHERE group_id=? AND user_id=? AND left_at IS NULL', [groupId, targetUser.id]);
  if (already) return res.status(409).json({ error: 'すでにメンバーです' });

  // 鍵ラチェット: バージョンを上げる (前方秘匿性 - 新メンバーは過去メッセージを読めない)
  const newVersion = group.key_version + 1;
  await db.run('UPDATE groups SET key_version = ? WHERE id = ?', [newVersion, groupId]);
  await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, targetUser.id]);

  // クライアントが生成した「メンバーごとに暗号化した新グループ鍵」を保存・配布
  if (Array.isArray(encryptedKeysForMembers)) {
    for (const entry of encryptedKeysForMembers) {
      await db.run(
        'INSERT INTO group_key_distributions (id, group_id, user_id, key_version, encrypted_group_key) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), groupId, entry.userId, newVersion, entry.encryptedGroupKey]
      );
      broadcastToUser(entry.userId, {
        type: 'group_key_rotated',
        groupId,
        keyVersion: newVersion,
        reason: 'member_joined',
      });
    }
  }

  res.json({ ok: true, groupId, keyVersion: newVersion, invitedUserId: targetUser.id });
});

// --- メンバー削除・脱退 ---
// 脱退が確定した瞬間に鍵を更新 (後方秘匿性 - 抜けた人は以後のメッセージを読めない)
// body: { groupId, removeUserId, encryptedKeysForRemainingMembers: [{userId, encryptedGroupKey}] }
router.post('/remove-member', verifyToken, async (req, res) => {
  const { groupId, removeUserId, encryptedKeysForRemainingMembers } = req.body;

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });

  await db.run(
    'UPDATE group_members SET left_at = CURRENT_TIMESTAMP WHERE group_id = ? AND user_id = ?',
    [groupId, removeUserId]
  );

  const newVersion = group.key_version + 1;
  await db.run('UPDATE groups SET key_version = ? WHERE id = ?', [newVersion, groupId]);

  if (Array.isArray(encryptedKeysForRemainingMembers)) {
    for (const entry of encryptedKeysForRemainingMembers) {
      await db.run(
        'INSERT INTO group_key_distributions (id, group_id, user_id, key_version, encrypted_group_key) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), groupId, entry.userId, newVersion, entry.encryptedGroupKey]
      );
      broadcastToUser(entry.userId, {
        type: 'group_key_rotated',
        groupId,
        keyVersion: newVersion,
        reason: 'member_left',
      });
    }
  }

  broadcastToUser(removeUserId, { type: 'removed_from_group', groupId });

  res.json({ ok: true, groupId, keyVersion: newVersion });
});

// --- 自分宛の最新グループ鍵を取得 ---
router.get('/:groupId/my-key', verifyToken, async (req, res) => {
  const row = await db.get(
    `SELECT * FROM group_key_distributions WHERE group_id=? AND user_id=? ORDER BY key_version DESC LIMIT 1`,
    [req.params.groupId, req.user.userId]
  );
  if (!row) return res.status(404).json({ error: '鍵が見つかりません' });
  res.json({ keyVersion: row.key_version, encryptedGroupKey: row.encrypted_group_key });
});

// --- メンバー一覧 ---
router.get('/:groupId/members', verifyToken, async (req, res) => {
  const rows = await db.all(
    `SELECT u.id, u.username, u.display_name FROM group_members gm
     JOIN users u ON u.id = gm.user_id
     WHERE gm.group_id = ? AND gm.left_at IS NULL`,
    [req.params.groupId]
  );
  res.json({ members: rows });
});

module.exports = router;
