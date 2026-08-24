// routes/messages.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendServerError } = require('../utils/errorResponse');
const { verifyToken: auth } = require('../utils/authMiddleware');

const router = express.Router();

// 相手が今オンラインかどうかを確認する。
// ws/wsServer.js は起動時に initWebSocketServer() が呼ばれて初めて isUserOnline が
// 使えるようになるため、循環require回避も兼ねて呼び出し時に require する。
router.get('/presence/:userId', auth, (req, res) => {
  try {
    const { isUserOnline } = require('../ws/wsServer');
    res.json({ userId: req.params.userId, online: isUserOnline(req.params.userId) });
  } catch (err) {
    res.json({ userId: req.params.userId, online: false });
  }
});

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
// body: { recipientId, content, mediaType?, mediaData?, mediaUrl?, mediaPublicId?, encryptedMetadata?, chunkCount?, encrypted?, repliedToId? }
// mediaType: 'image' | 'video' | null（テキスト）
// mediaData: base64エンコードされたデータ（旧方式）
// mediaUrl: Cloudinary上のURL（新方式、暗号化済みバイナリ）
// encrypted: true の場合、content は暗号文（サーバーは復号化しない）
// repliedToId: リプライ対象のメッセージID
router.post('/send', auth, async (req, res) => {
  try {
    const {
      recipientId, content, mediaType, mediaData,
      mediaUrl, mediaPublicId, encryptedMetadata, chunkCount,
      encrypted, repliedToId,
    } = req.body;
    if (!recipientId || !content) return res.status(400).json({ error: 'recipientId and content required' });

    const recipient = await db.get('SELECT id FROM users WHERE id = ?', [recipientId]);
    if (!recipient) return res.status(404).json({ error: 'recipient not found' });

    // 友達関係チェック: UI(talklist.html)は友達承認後の相手にしかチャット導線を
    // 出さない設計だが、以前はAPIレベルでこれを強制しておらず、有効なJWTと
    // recipientIdさえあれば友達申請すらしていない任意のユーザーへメッセージを
    // 送信できてしまっていた(意図した信頼モデルとサーバー実装の不一致)。
    const [userA, userB] = [req.userId, recipientId].sort();
    const friendship = await db.get(
      "SELECT status FROM friendships WHERE user_a_id = ? AND user_b_id = ? AND status = 'accepted'",
      [userA, userB]
    );
    if (!friendship) {
      return res.status(403).json({ error: 'このユーザーとは友達ではありません' });
    }

    // メディアサイズチェック（Base64直送り方式のみ対象。約25MB相当まで許可。
    // Cloudinary方式(mediaUrl)はURLのみ保存するためサイズチェック不要）
    if (mediaData && mediaData.length > 35 * 1024 * 1024) {
      return res.status(413).json({ error: 'ファイルサイズが大きすぎます' });
    }

    // repliedToId の存在確認（指定されている場合）
    if (repliedToId) {
      const replied = await db.get('SELECT id FROM messages WHERE id = ?', [repliedToId]);
      if (!replied) return res.status(404).json({ error: 'replied message not found' });
    }

    const msgId = uuidv4();
    const msgType = mediaType || 'text';
    let finalContent = content;

    // 画像・動画の場合、JSONで保存する。Cloudinary方式(mediaUrl)とBase64直送り方式(mediaData)の
    // 両方に対応する。
    if (mediaUrl) {
      finalContent = JSON.stringify({
        text: content,
        mediaType,
        mediaUrl,
        mediaPublicId: mediaPublicId || null,
        encryptedMetadata: encryptedMetadata || null,
        chunkCount: chunkCount || null,
      });
    } else if (mediaData) {
      finalContent = JSON.stringify({ text: content, media: mediaData, mediaType });
    }

    await db.run(
      'INSERT INTO messages (id, sender_id, recipient_id, content, msg_type, encrypted, replied_to_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [msgId, req.userId, recipientId, finalContent, msgType, !!encrypted, repliedToId || null]
    );

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [msgId]);

    // WebSocket でリアルタイム通知
    const { broadcastToUser, isUserOnline } = require('../ws/wsServer');
    const payload = {
      type: 'new_message',
      message: {
        id: msg.id,
        senderId: msg.sender_id,
        recipientId: msg.recipient_id,
        content: msg.content,
        msgType: msg.msg_type,
        encrypted: !!msg.encrypted,
        repliedToId: msg.replied_to_id || null,
        createdAt: msg.created_at,
      }
    };
    broadcastToUser(recipientId, payload);
    broadcastToUser(req.userId, payload); // 自分の他端末にも

    // 相手がオフライン(WebSocket未接続)の場合のみPush通知を送る。
    // オンラインならWS経由で既にリアルタイム表示されるため、二重通知を避ける。
    // NOTE: E2E暗号化のためcontentは復号できない。通知本文には出さず、
    // 「メッセージが届いた」ことと送信者名だけを載せる(プライバシー配慮)。
    if (!isUserOnline(recipientId)) {
      const sender = await db.get('SELECT display_name FROM users WHERE id = ?', [req.userId]);
      const { sendPushToUser } = require('../utils/webPush');
      sendPushToUser(recipientId, {
        type: 'new_message',
        senderId: req.userId,
        senderName: sender?.display_name || 'ユーザー',
        preview: mediaType ? `[${mediaType === 'image' ? '画像' : '動画'}]` : 'メッセージが届きました',
      }).catch(err => console.error('[push] new_message send failed:', err.message));
    }

    res.json({ ok: true, message: payload.message });
  } catch (e) {
    console.error('Error sending message:', e.message);
    sendServerError(res, e);
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
    // 未読だったメッセージのIDを先に取得しておく(既読化SQL実行前)。
    // WebSocket通知で「どのメッセージが既読になったか」を相手に伝えるために必要。
    const newlyRead = await db.all(
      "SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
      [otherId, req.userId]
    );
    await db.run(
      "UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL",
      [now, otherId, req.userId]
    );

    // 履歴を開いただけ(WS経由のread_receiptイベントを個別に送っていないケース)でも
    // 相手の画面にリアルタイムで既読マークが反映されるよう、まとめて通知する。
    // (以前はDB上は既読になるのに相手には何も届かず、相手が再読み込みするまで
    //  既読マークが付かないバグがあった)
    if (newlyRead.length > 0) {
      const { broadcastToUser } = require('../ws/wsServer');
      broadcastToUser(otherId, {
        type: 'read_receipt_bulk',
        readerId: req.userId,
        messageIds: newlyRead.map(m => m.id),
        readAt: now,
      });
    }

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
        repliedToId: m.replied_to_id || null,
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
    sendServerError(res, e);
  }
});

// トークリスト取得（最新メッセージ付き + メッセージなしの友達も含む）
// GET /api/messages/talks
router.get('/talks', auth, async (req, res) => {
  try {
    // メッセージがある会話（自分自身へのメッセージは除外）
    // NOTE: PostgreSQLはGROUP BYに含まれない列をSELECTできない(SQLiteは黙って許容する)。
    // SQLite/PostgreSQL両対応のため、まず相手ごとの最新時刻だけをGROUP BYで取得し、
    // その後1件ずつ実際のメッセージ内容を引く（トーク数は通常少ないため許容範囲）。
    const latestTimes = await db.all(`
      SELECT
        CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END as other_id,
        MAX(created_at) as last_time
      FROM messages
      WHERE (sender_id = ? OR recipient_id = ?) AND sender_id != recipient_id
      GROUP BY other_id
      ORDER BY last_time DESC
    `, [req.userId, req.userId, req.userId]);

    const rows = [];
    for (const lt of latestTimes) {
      const msg = await db.get(`
        SELECT
          CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END as other_id,
          content, created_at, sender_id, deleted_at
        FROM messages
        WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
          AND created_at = ?
        ORDER BY id DESC
        LIMIT 1
      `, [req.userId, req.userId, lt.other_id, lt.other_id, req.userId, lt.last_time]);
      if (msg) {
        rows.push({ ...msg, last_time: lt.last_time });
      }
    }

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
    sendServerError(res, e);
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
    sendServerError(res, e);
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
    sendServerError(res, e);
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
    sendServerError(res, e);
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
    sendServerError(res, e);
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
    sendServerError(res, e);
  }
});

module.exports = router;
