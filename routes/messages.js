// routes/messages.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const db = require('../db/db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'ring-dev-secret-CHANGE-IN-PRODUCTION';

function auth(req, res, next) {
  const token = (req.get('Authorization') || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'unauthorized' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'invalid token' });
  }
}

// メッセージ内容をトークリスト用のプレビューテキストに変換
function toPreviewText(content, encrypted) {
  if (!content) return '';
  if (encrypted) return '暗号化されたメッセージ';
  try {
    const parsed = JSON.parse(content);
    if (parsed && parsed.media && parsed.mediaType) {
      return parsed.mediaType === 'image' ? '画像が送信されました' : '動画が送信されました';
    }
  } catch (e) {}
  return content;
}

// メッセージ送信
// POST /api/messages/send
// body: { recipientId, content, mediaType?, mediaData?, encrypted? }
// mediaType: 'image' | 'video' | null（テキスト）
// mediaData: base64エンコードされたデータ
// encrypted: true の場合、content は暗号文（サーバーは復号化しない）
router.post('/send', auth, async (req, res) => {
  try {
    const { recipientId, content, mediaType, mediaData, encrypted } = req.body;
    if (!recipientId || !content) return res.status(400).json({ error: 'recipientId and content required' });

    const recipient = await db.get('SELECT id FROM users WHERE id = ?', [recipientId]);
    if (!recipient) return res.status(404).json({ error: 'recipient not found' });

    // メディアサイズチェック（Base64文字列の長さで概算。約25MB相当まで許可）
    if (mediaData && mediaData.length > 35 * 1024 * 1024) {
      return res.status(413).json({ error: 'ファイルサイズが大きすぎます' });
    }

    const msgId = uuidv4();
    const msgType = mediaType || 'text';
    let finalContent = content;
    
    // 画像・動画の場合、JSONで { text, media, mediaType } を保存
    // encrypted=true の場合、media は暗号化されたBase64
    if (mediaData) {
      finalContent = JSON.stringify({ text: content, media: mediaData, mediaType });
    }

    await db.run(
      'INSERT INTO messages (id, sender_id, recipient_id, content, msg_type, encrypted) VALUES (?, ?, ?, ?, ?, ?)',
      [msgId, req.userId, recipientId, finalContent, msgType, !!encrypted]
    );

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [msgId]);

    // WebSocket でリアルタイム通知
    const { broadcastToUser } = require('../ws/wsServer');
    const payload = {
      type: 'new_message',
      message: {
        id: msg.id,
        senderId: msg.sender_id,
        recipientId: msg.recipient_id,
        content: msg.content,
        msgType: msg.msg_type,
        encrypted: !!msg.encrypted,
        createdAt: msg.created_at,
      }
    };
    broadcastToUser(recipientId, payload);
    broadcastToUser(req.userId, payload); // 自分の他端末にも

    res.json({ ok: true, message: payload.message });
  } catch (e) {
    console.error('Error sending message:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 会話履歴取得
// GET /api/messages/history/:userId?before=<timestamp>&limit=50
router.get('/history/:userId', auth, async (req, res) => {
  try {
    const { userId: otherId } = req.params;
    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before;

    let sql = `
      SELECT * FROM messages
      WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
    `;
    const params = [req.userId, otherId, otherId, req.userId];

    if (before) {
      sql += ' AND created_at < ?';
      params.push(before);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(limit);

    const rows = await db.all(sql, params);

    const now = new Date().toISOString();
    await db.run(
      "UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
      [now, otherId, req.userId]
    );

    const result = [];
    for (const m of rows.reverse()) {
      const reactions = await db.all(
        'SELECT emoji, COUNT(*) as cnt FROM message_reactions WHERE message_id = ? GROUP BY emoji',
        [m.id]
      );
      result.push({
        id: m.id,
        senderId: m.sender_id,
        recipientId: m.recipient_id,
        content: m.deleted_at ? '' : m.content,
        encrypted: !!m.encrypted,
        createdAt: m.created_at,
        readAt: m.read_at,
        editedAt: m.edited_at,
        deletedAt: m.deleted_at,
        pinnedAt: m.pinned_at,
        reactions: reactions.map(r => ({ emoji: r.emoji, count: r.cnt })),
      });
    }

    res.json(result);
  } catch (e) {
    console.error('Error fetching history:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// トークリスト取得（最新メッセージ付き + メッセージなしの友達も含む）
// GET /api/messages/talks
router.get('/talks', auth, async (req, res) => {
  try {
    // メッセージがある会話
    const rows = await db.all(`
      SELECT
        CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END as other_id,
        content,
        created_at,
        sender_id,
        deleted_at,
        MAX(created_at) as last_time
      FROM messages
      WHERE sender_id = ? OR recipient_id = ?
      GROUP BY other_id
      ORDER BY last_time DESC
    `, [req.userId, req.userId, req.userId]);

    const result = [];
    const processedIds = new Set();

    for (const row of rows) {
      const user = await db.get('SELECT id, user_id, display_name, profile_pic FROM users WHERE id = ?', [row.other_id]);
      if (user) {
        const unread = await db.get(
          "SELECT COUNT(*) as cnt FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
          [row.other_id, req.userId]
        );
        result.push({
          userId: user.id,
          userIdCode: user.user_id,
          displayName: user.display_name,
          profilePic: user.profile_pic,
          lastMessage: row.deleted_at ? '（送信取り消し済み）' : toPreviewText(row.content),
          lastTime: row.last_time,
          unreadCount: unread ? unread.cnt : 0,
        });
        processedIds.add(user.id);
      }
    }

    // メッセージのない友達も含める
    const friends = await db.all(`
      SELECT
        CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as friend_id
      FROM friendships
      WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'accepted'
    `, [req.userId, req.userId, req.userId]);

    for (const f of friends) {
      if (!processedIds.has(f.friend_id)) {
        const user = await db.get('SELECT id, user_id, display_name, profile_pic FROM users WHERE id = ?', [f.friend_id]);
        if (user) {
          result.push({
            userId: user.id,
            userIdCode: user.user_id,
            displayName: user.display_name,
            profilePic: user.profile_pic,
            lastMessage: '',
            lastTime: new Date().toISOString(),
            unreadCount: 0,
          });
        }
      }
    }

    res.json(result);
  } catch (e) {
    console.error('Error fetching talks:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// メッセージ編集
// POST /api/messages/edit
// body: { messageId, content }
router.post('/edit', auth, async (req, res) => {
  try {
    const { messageId, content, encrypted } = req.body;
    if (!messageId || !content) return res.status(400).json({ error: 'messageId and content required' });

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (msg.sender_id !== req.userId) return res.status(403).json({ error: 'not authorized' });
    if (msg.deleted_at) return res.status(400).json({ error: 'message deleted' });

    const now = new Date().toISOString();
    await db.run("UPDATE messages SET content = ?, encrypted = ?, edited_at = ? WHERE id = ?", [content, !!encrypted, now, messageId]);
    const updated = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);

    const payload = {
      type: 'message_edited',
      messageId: updated.id,
      content: updated.content,
      encrypted: !!updated.encrypted,
      editedAt: updated.edited_at,
      senderId: updated.sender_id,
      recipientId: updated.recipient_id,
    };
    const { broadcastToUser } = require('../ws/wsServer');
    broadcastToUser(updated.recipient_id, payload);
    broadcastToUser(updated.sender_id, payload);

    res.json({ ok: true, message: payload });
  } catch (e) {
    console.error('Error editing message:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// メッセージ削除（送信取り消し）
// POST /api/messages/delete
// body: { messageId }
router.post('/delete', auth, async (req, res) => {
  try {
    const { messageId } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId required' });

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (msg.sender_id !== req.userId) return res.status(403).json({ error: 'not authorized' });

    const now = new Date().toISOString();
    await db.run("UPDATE messages SET deleted_at = ?, content = '' WHERE id = ?", [now, messageId]);

    const payload = {
      type: 'message_deleted',
      messageId: messageId,
      senderId: msg.sender_id,
      recipientId: msg.recipient_id,
    };
    const { broadcastToUser } = require('../ws/wsServer');
    broadcastToUser(msg.recipient_id, payload);
    broadcastToUser(msg.sender_id, payload);

    res.json({ ok: true });
  } catch (e) {
    console.error('Error deleting message:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// メッセージピン留め切り替え
// POST /api/messages/pin
// body: { messageId, pinned }
router.post('/pin', auth, async (req, res) => {
  try {
    const { messageId, pinned } = req.body;
    if (!messageId) return res.status(400).json({ error: 'messageId required' });

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'message not found' });

    // 参加者のみピン留め可能
    if (msg.sender_id !== req.userId && msg.recipient_id !== req.userId) {
      return res.status(403).json({ error: 'not authorized' });
    }

    const now = new Date().toISOString();
    if (pinned) {
      await db.run("UPDATE messages SET pinned_at = ? WHERE id = ?", [now, messageId]);
    } else {
      await db.run("UPDATE messages SET pinned_at = NULL WHERE id = ?", [messageId]);
    }

    const payload = {
      type: 'message_pinned',
      messageId: messageId,
      pinned: !!pinned,
      pinnedAt: pinned ? now : null,
      senderId: msg.sender_id,
      recipientId: msg.recipient_id,
    };
    const { broadcastToUser } = require('../ws/wsServer');
    broadcastToUser(msg.recipient_id, payload);
    broadcastToUser(msg.sender_id, payload);

    res.json({ ok: true });
  } catch (e) {
    console.error('Error pinning message:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// リアクション追加/削除（トグル）
// POST /api/messages/react
// body: { messageId, emoji }
router.post('/react', auth, async (req, res) => {
  try {
    const { messageId, emoji } = req.body;
    if (!messageId || !emoji) return res.status(400).json({ error: 'messageId and emoji required' });

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (msg.sender_id !== req.userId && msg.recipient_id !== req.userId) {
      return res.status(403).json({ error: 'not authorized' });
    }

    const existing = await db.get(
      'SELECT id FROM message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?',
      [messageId, req.userId, emoji]
    );

    let action;
    if (existing) {
      await db.run('DELETE FROM message_reactions WHERE id = ?', [existing.id]);
      action = 'removed';
    } else {
      await db.run(
        'INSERT INTO message_reactions (id, message_id, user_id, emoji) VALUES (?, ?, ?, ?)',
        [uuidv4(), messageId, req.userId, emoji]
      );
      action = 'added';
    }

    const reactions = await db.all(
      'SELECT emoji, COUNT(*) as cnt FROM message_reactions WHERE message_id = ? GROUP BY emoji',
      [messageId]
    );

    const payload = {
      type: 'message_reaction',
      messageId: messageId,
      reactions: reactions.map(r => ({ emoji: r.emoji, count: r.cnt })),
      senderId: msg.sender_id,
      recipientId: msg.recipient_id,
    };
    const { broadcastToUser } = require('../ws/wsServer');
    broadcastToUser(msg.recipient_id, payload);
    broadcastToUser(msg.sender_id, payload);

    res.json({ ok: true, action, reactions: payload.reactions });
  } catch (e) {
    console.error('Error reacting to message:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ピン留めメッセージ一覧取得
// GET /api/messages/pinned/:userId
router.get('/pinned/:userId', auth, async (req, res) => {
  try {
    const { userId: otherId } = req.params;
    const rows = await db.all(`
      SELECT * FROM messages
      WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
      AND pinned_at IS NOT NULL
      ORDER BY pinned_at DESC
    `, [req.userId, otherId, otherId, req.userId]);

    res.json(rows.map(m => ({
      id: m.id,
      senderId: m.sender_id,
      recipientId: m.recipient_id,
      content: m.deleted_at ? '' : m.content,
      createdAt: m.created_at,
      pinnedAt: m.pinned_at,
    })));
  } catch (e) {
    console.error('Error fetching pinned messages:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
