// routes/groups.js
// グループ作成・招待・削除 + キー・ラチェット(鍵更新)のトリガー
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { broadcastToUser } = require('../ws/wsServer');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();

// 指定ユーザーがそのグループの現メンバーかどうかを確認する共通ヘルパー。
// これが無いと、groupIdとmsgIdさえ知っていれば部外者でも
// メッセージの閲覧・送信・既読・ピン留めができてしまう重大な権限バグになる。
async function isGroupMember(groupId, userId) {
  const row = await db.get(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
    [groupId, userId]
  );
  return !!row;
}

// --- 自分が所属するグループ一覧を取得 ---
router.get('/list', verifyToken, asyncHandler(async (req, res) => {
  const rows = await db.all(
    `SELECT g.id, g.name, g.owner_id, g.key_version, g.created_at
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ? AND gm.left_at IS NULL
     ORDER BY g.created_at DESC`,
    [req.user.userId]
  );
  const groups = [];
  for (const g of rows) {
    const members = await db.all(
      `SELECT u.id as user_id, u.display_name, u.profile_pic
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ? AND gm.left_at IS NULL`,
      [g.id]
    );
    const lastMsg = await db.get(
      `SELECT content, created_at, encrypted FROM group_messages
       WHERE group_id = ? AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
      [g.id]
    );
    groups.push({
      groupId: g.id,
      name: g.name,
      ownerId: g.owner_id,
      isOwner: g.owner_id === req.user.userId,
      keyVersion: g.key_version,
      members: members.map(m => ({ userId: m.user_id, displayName: m.display_name, profilePic: m.profile_pic })),
      lastMessage: lastMsg ? { content: lastMsg.content, createdAt: lastMsg.created_at, encrypted: !!lastMsg.encrypted } : null,
    });
  }
  res.json({ groups });
}));

// --- グループ作成 ---
// body: { name, memberIds: [userId, ...] } (memberIdsは作成者以外の初期メンバー)
router.post('/create', verifyToken, asyncHandler(async (req, res) => {
  const { name, memberIds } = req.body;
  if (!name) return res.status(400).json({ error: 'グループ名が必要です' });
  // 表示崩壊・DB肥大化防止のため上限を設ける(display_nameと同基準)
  if (name.length > 50) return res.status(400).json({ error: 'グループ名は50文字以内にしてください' });

  const groupId = uuidv4();
  await db.run('INSERT INTO groups (id, name, owner_id, key_version) VALUES (?, ?, ?, 1)', [groupId, name, req.user.userId]);
  await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, req.user.userId]);

  const addedMembers = [req.user.userId];
  if (Array.isArray(memberIds)) {
    for (const uid of memberIds) {
      if (uid === req.user.userId) continue; // 作成者は既に追加済み
      const user = await db.get('SELECT id FROM users WHERE id = ?', [uid]);
      if (!user) continue; // 存在しないユーザーIDは無視
      const already = await db.get('SELECT * FROM group_members WHERE group_id=? AND user_id=?', [groupId, uid]);
      if (already) continue;
      await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, uid]);
      addedMembers.push(uid);
      broadcastToUser(uid, { type: 'added_to_group', groupId, name });
    }
  }

  res.json({ groupId, name, keyVersion: 1, members: addedMembers });
}));

// --- メンバー招待 ---
// クライアント側が新グループ鍵を生成し、暗号化した鍵を全メンバー分アップロードする想定。
// body: { groupId, targetUsername, encryptedKeysForMembers: [{userId, encryptedGroupKey}] }
router.post('/invite', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, targetUsername, encryptedKeysForMembers } = req.body;

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });

  // 呼び出し元がこのグループの現メンバーかどうかのチェック。
  // これが無いと、groupIdさえ知っていれば部外者でも勝手に他人をグループへ
  // 追加でき、しかも鍵ローテーション(key_version更新)まで引き起こせてしまう
  // 重大な権限バグになる。
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const targetUser = await db.get('SELECT id FROM users WHERE username = ?', [targetUsername]);
  if (!targetUser) return res.status(404).json({ error: 'そのユーザーは見つかりません' });

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
}));

// --- メンバー削除・脱退 ---
// 脱退が確定した瞬間に鍵を更新 (後方秘匿性 - 抜けた人は以後のメッセージを読めない)
// body: { groupId, removeUserId, encryptedKeysForRemainingMembers: [{userId, encryptedGroupKey}] }
router.post('/remove-member', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, removeUserId, encryptedKeysForRemainingMembers } = req.body;

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });

  // 権限チェック: オーナー本人による削除、または本人による自主脱退のみ許可する。
  // (このチェックが無いと、メンバーであれば誰でも他人を削除できてしまう
  //  重大な権限バグになるため必須)
  const isOwner = group.owner_id === req.user.userId;
  const isSelfLeaving = removeUserId === req.user.userId;
  if (!isOwner && !isSelfLeaving) {
    return res.status(403).json({ error: 'メンバーを削除する権限がありません' });
  }
  // オーナー自身の脱退は、グループが空になり誰も管理できなくなるため禁止
  if (isSelfLeaving && group.owner_id === removeUserId) {
    return res.status(400).json({ error: 'オーナーはグループから脱退できません。グループを削除するか、オーナー権限を譲渡してください' });
  }

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
}));

// --- 自分宛の最新グループ鍵を取得 ---
router.get('/:groupId/my-key', verifyToken, asyncHandler(async (req, res) => {
  const row = await db.get(
    `SELECT * FROM group_key_distributions WHERE group_id=? AND user_id=? ORDER BY key_version DESC LIMIT 1`,
    [req.params.groupId, req.user.userId]
  );
  if (!row) return res.status(404).json({ error: '鍵が見つかりません' });
  res.json({ keyVersion: row.key_version, encryptedGroupKey: row.encrypted_group_key });
}));

// --- グループメッセージ送信 ---
// body: { content, mediaType?, mediaData?, encrypted? }
// mediaType: 'image' | 'video' | null（テキスト）
// mediaData: base64エンコードされたデータ
router.post('/:groupId/messages/send', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { content, mediaType, mediaData, encrypted } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  // 個人チャットと同様、ファイルサイズの上限チェック
  if (mediaData && mediaData.length > 35 * 1024 * 1024) {
    return res.status(413).json({ error: 'ファイルが大きすぎます' });
  }

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const msgType = mediaType || 'text';
  // 画像・動画の場合、個人チャットと同じ形式でJSONとして保存する
  // { text, media, mediaType }
  let finalContent = content;
  if (mediaData) {
    finalContent = JSON.stringify({ text: content, media: mediaData, mediaType });
  }

  const msgId = uuidv4();
  await db.run(
    'INSERT INTO group_messages (id, group_id, sender_id, content, msg_type, encrypted, key_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [msgId, groupId, req.user.userId, finalContent, msgType, !!encrypted, group.key_version]
  );

  const msg = await db.get('SELECT * FROM group_messages WHERE id = ?', [msgId]);

  // グループメンバー全員にWebSocket通知
  const members = await db.all(
    'SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL',
    [groupId]
  );
  const { broadcastToUser } = require('../ws/wsServer');
  members.forEach(m => {
    broadcastToUser(m.user_id, {
      type: 'group_message',
      groupId,
      message: {
        id: msg.id,
        groupId: msg.group_id,
        senderId: msg.sender_id,
        content: msg.content,
        msgType: msg.msg_type,
        encrypted: !!msg.encrypted,
        keyVersion: msg.key_version,
        createdAt: msg.created_at,
      }
    });
  });

  res.json({ ok: true, message: msg });
}));

// --- グループメッセージ履歴取得 ---
router.get('/:groupId/messages', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const messages = await db.all(
    `SELECT gm.*, u.display_name FROM group_messages gm
     LEFT JOIN users u ON u.id = gm.sender_id
     WHERE gm.group_id = ? AND gm.deleted_at IS NULL
     ORDER BY gm.created_at DESC LIMIT 100`,
    [groupId]
  );

  res.json(messages.reverse());
}));

// --- グループメッセージ既読マーク ---
// body: { messageIds: [id, ...] } (まとめて既読にする)
router.post('/:groupId/messages/read', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds required' });
  }
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);

  for (const msgId of messageIds) {
    const msg = await db.get('SELECT sender_id FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
    if (!msg) continue;
    if (msg.sender_id === req.user.userId) continue; // 自分の送信メッセージは既読対象外
    const already = await db.get('SELECT * FROM group_message_reads WHERE message_id = ? AND user_id = ?', [msgId, req.user.userId]);
    if (already) continue;
    await db.run('INSERT INTO group_message_reads (message_id, user_id) VALUES (?, ?)', [msgId, req.user.userId]);

    // 何人が既読したかをメンバー全員に通知(自分のアイコンを表示するのではなく人数ベースで良い)
    const readCount = await db.get('SELECT COUNT(*) as cnt FROM group_message_reads WHERE message_id = ?', [msgId]);
    members.forEach(m => {
      broadcastToUser(m.user_id, {
        type: 'group_message_read',
        groupId,
        messageId: msgId,
        readerUserId: req.user.userId,
        readCount: readCount.cnt,
        totalMembers: members.length,
      });
    });
  }

  res.json({ ok: true });
}));

// --- グループメッセージの既読者一覧取得 ---
router.get('/:groupId/messages/:msgId/reads', verifyToken, asyncHandler(async (req, res) => {
  if (!(await isGroupMember(req.params.groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  const reads = await db.all(
    `SELECT gmr.user_id, gmr.read_at, u.display_name FROM group_message_reads gmr
     JOIN users u ON u.id = gmr.user_id
     WHERE gmr.message_id = ?`,
    [req.params.msgId]
  );
  res.json({ reads: reads.map(r => ({ userId: r.user_id, displayName: r.display_name, readAt: r.read_at })) });
}));

// --- グループメッセージ編集 ---
router.post('/:groupId/messages/:msgId/edit', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, msgId } = req.params;
  const { content, encrypted } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const msg = await db.get('SELECT * FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
  if (!msg) return res.status(404).json({ error: 'メッセージが見つかりません' });
  if (msg.sender_id !== req.user.userId) return res.status(403).json({ error: '権限がありません' });

  const now = new Date().toISOString();
  await db.run('UPDATE group_messages SET content = ?, encrypted = ?, edited_at = ? WHERE id = ?', [content, !!encrypted, now, msgId]);

  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => {
    broadcastToUser(m.user_id, {
      type: 'group_message_edited',
      groupId,
      messageId: msgId,
      content,
      encrypted: !!encrypted,
      editedAt: now,
    });
  });

  res.json({ ok: true });
}));

// --- グループメッセージのピン留め切り替え ---
router.post('/:groupId/messages/:msgId/pin', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, msgId } = req.params;
  const { pinned } = req.body;
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const msg = await db.get('SELECT * FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
  if (!msg) return res.status(404).json({ error: 'メッセージが見つかりません' });

  const now = pinned ? new Date().toISOString() : null;
  await db.run('UPDATE group_messages SET pinned_at = ? WHERE id = ?', [now, msgId]);

  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => {
    broadcastToUser(m.user_id, { type: 'group_message_pinned', groupId, messageId: msgId, pinned: !!pinned });
  });

  res.json({ ok: true, pinned: !!pinned });
}));

// --- グループのピン留めメッセージ一覧取得 ---
router.get('/:groupId/pinned', verifyToken, asyncHandler(async (req, res) => {
  if (!(await isGroupMember(req.params.groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  const rows = await db.all(
    `SELECT gm.*, u.display_name FROM group_messages gm
     LEFT JOIN users u ON u.id = gm.sender_id
     WHERE gm.group_id = ? AND gm.pinned_at IS NOT NULL AND gm.deleted_at IS NULL
     ORDER BY gm.pinned_at DESC`,
    [req.params.groupId]
  );
  res.json(rows);
}));

// --- グループメッセージ削除 ---
router.post('/:groupId/messages/:msgId/delete', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, msgId } = req.params;
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  const msg = await db.get('SELECT * FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
  if (!msg) return res.status(404).json({ error: 'メッセージが見つかりません' });
  if (msg.sender_id !== req.user.userId) return res.status(403).json({ error: '権限がありません' });

  const now = new Date().toISOString();
  await db.run('UPDATE group_messages SET deleted_at = ? WHERE id = ?', [now, msgId]);

  // グループメンバーに通知
  const { broadcastToUser } = require('../ws/wsServer');
  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => {
    broadcastToUser(m.user_id, {
      type: 'group_message_deleted',
      groupId,
      messageId: msgId,
    });
  });

  res.json({ ok: true });
}));

module.exports = router;
