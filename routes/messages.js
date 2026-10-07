// routes/messages.js
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendServerError } = require('../utils/errorResponse');
const { verifyToken: auth } = require('../utils/authMiddleware');
const { rejectIfProfane, censorBodyAndBanAfter } = require('../utils/moderation');
const { messageSendLimiter } = require('../utils/rateLimits');

// メッセージcontentの最大文字数。E2E暗号化後のBase64も含むため大きめだが
// 上限なしだと50MB JSONで1リクエストでDB/メモリを食いつぶせる。
const { validateMessageInput } = require('../utils/messageContent');
const MAX_HISTORY_LIMIT = 100;

const router = express.Router();

// 相手が今オンラインかどうかを確認する。
// ws/wsServer.js は起動時に initWebSocketServer() が呼ばれて初めて isUserOnline が
// 使えるようになるため、循環require回避も兼ねて呼び出し時に require する。
// 友だち・同じグループの相手以外は常にオフライン扱い(知らない相手の在席を覗けないように)
router.get('/presence/:userId', auth, async (req, res) => {
  try {
    const { isUserOnline } = require('../ws/wsServer');
    const { canInteract } = require('../utils/relations');
    const { getSettings } = require('../utils/userSettings');
    const visible = await canInteract(req.userId, req.params.userId);
    // 「オンライン状態を見せない」設定の人は常にオフライン扱い
    const shown = visible && (await getSettings(req.params.userId)).showOnlineStatus;
    res.json({ userId: req.params.userId, online: shown ? isUserOnline(req.params.userId) : false });
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
      return parsed.mediaType === 'image' ? '画像が送信されました' : parsed.mediaType === 'audio' ? '留守番電話が届きました' : '動画が送信されました';
    }
    if (parsed && parsed.__call__) {
      return '通話';
    }
    if (parsed && parsed.__notice__ && parsed.__notice__.kind === 'ban') {
      return `${String(parsed.__notice__.name || 'ユーザー').slice(0, 40)}がFワードを言ったためBanしました。`;
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
router.post('/send', messageSendLimiter, auth, async (req, res) => {
  try {
    // 平文で届いた時だけサーバーで調べられる(暗号文は送る側の端末が調べる)
    if (!req.body?.encrypted) censorBodyAndBanAfter(req, res, ['content'], () => ({ peerId: req.body.recipientId }));
    const {
      recipientId, content, mediaType, mediaData,
      mediaUrl, mediaPublicId, encryptedMetadata, chunkCount,
      encrypted, repliedToId,
    } = req.body;
    if (!recipientId || typeof recipientId !== 'string' || !content) {
      return res.status(400).json({ error: 'recipientId and content required' });
    }
    // 本文の形・長さ、メディアの種類とURLをまとめて確認する("通知"はサーバー専用なので作れない、
    // mediaUrlはCloudinaryのみ = 相手の端末を他所へ取りに行かせない)
    const badInput = validateMessageInput(req.body);
    if (badInput) return res.status(badInput === 'メッセージが長すぎます' ? 413 : 400).json({ error: badInput });

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

    // ブロック: 自分がブロックしている相手には送れない(解除すれば送れる)。
    // 相手にブロックされている時は、送った側には普通に送れたように見せ、相手には一切届けない
    // (LINEと同じ。ブロックされたことを気づかせない)
    const { blockState } = require('../utils/relations');
    const bs = await blockState(req.userId, recipientId);
    if (bs.byMe) return res.status(403).json({ error: 'ブロック中のため送れません。解除すると送れます', blockedByMe: true });
    const hiddenForRecipient = bs.byThem;

    // 返信先は、この2人の会話の中のメッセージに限る。
    // 以前はIDの存在だけを見ていたので、当てずっぽうのIDで「そのIDのメッセージが
    // 存在するかどうか」を外から確かめられた。
    if (repliedToId) {
      const replied = await db.get(
        `SELECT id FROM messages
          WHERE id = ? AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))`,
        [repliedToId, req.userId, recipientId, recipientId, req.userId]
      );
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
      'INSERT INTO messages (id, sender_id, recipient_id, content, msg_type, encrypted, replied_to_id, hidden_for_recipient) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [msgId, req.userId, recipientId, finalContent, msgType, !!encrypted, repliedToId || null, hiddenForRecipient]
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
    if (!hiddenForRecipient) broadcastToUser(recipientId, payload);
    broadcastToUser(req.userId, payload); // 自分の他端末にも
    if (hiddenForRecipient) return res.json({ ok: true, message: payload.message });

    // 相手がオフライン(WebSocket未接続)の場合のみPush通知を送る。
    // オンラインならWS経由で既にリアルタイム表示されるため、二重通知を避ける。
    // NOTE: E2E暗号化のためcontentは復号できない。通知本文には出さず、
    // 「メッセージが届いた」ことと送信者名だけを載せる(プライバシー配慮)。
    // APK(FCM)には常に送る。アプリが裏にいてもWebSocketが一時的に生きていることがあり、
    // 「オンラインなら送らない」だと通知が来なかった。開いているトークなら端末側で出さない。
    if (!req.body.noPush) {
      db.get('SELECT display_name, public_key FROM users WHERE id = ?', [req.userId]).then(sender => {
        const preview = mediaType ? `[${mediaType === 'image' ? '画像' : '動画'}]` : 'メッセージ';
        // 本文は暗号文のまま載せ、相手の端末の中でだけ復号して通知に出す(サーバーは読めないまま)。
        // FCMの上限4KBに収まる文字メッセージだけ。
        const cipher = (!mediaType && encrypted && typeof content === 'string' && content.length <= 3000) ? content : '';
        require('../utils/fcm').sendMessageNotification(recipientId, sender?.display_name || 'ユーザー', preview, 'dm',
          { senderId: req.userId, cipher, senderPub: cipher ? (sender?.public_key || '') : '' })
          .catch(err => console.error('[fcm] new_message failed:', err.message));
      }).catch(() => {});
    }
    if (!isUserOnline(recipientId) && !req.body.noPush) {
      const sender = await db.get('SELECT display_name FROM users WHERE id = ?', [req.userId]);
      const { sendPushToUser } = require('../utils/webPush');
      const wpCipher = (!mediaType && encrypted && typeof content === 'string' && content.length <= 2800) ? content : undefined;
      let senderPub;
      if (wpCipher) { try { senderPub = (await db.get('SELECT public_key FROM users WHERE id = ?', [req.userId]))?.public_key || undefined; } catch (e) {} }
      sendPushToUser(recipientId, {
        type: 'new_message',
        senderId: req.userId,
        senderName: sender?.display_name || 'ユーザー',
        preview: mediaType ? `[${mediaType === 'image' ? '画像' : '動画'}]` : 'メッセージ',
        // 本文は暗号文のまま。受け取った端末のService Workerの中でだけ復号して表示する
        cipher: wpCipher,
        senderPub,
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
    const limit = Math.min(parseInt(req.query.limit) || 50, MAX_HISTORY_LIMIT);
    const before = req.query.before;

    // 外側のカッコが無かったため、下の before(もっと前を読む)が相手のメッセージにしか効いていなかった。
    // ブロックした相手から届いた分(hidden_for_recipient)は自分には見せない
    let sql = `
      SELECT * FROM messages
      WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ? AND COALESCE(hidden_for_recipient, false) = false))
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
      "SELECT id FROM messages WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL AND COALESCE(hidden_for_recipient, false) = false",
      [otherId, req.userId]
    );
    await db.run(
      "UPDATE messages SET read_at = ? WHERE sender_id = ? AND recipient_id = ? AND read_at IS NULL AND COALESCE(hidden_for_recipient, false) = false",
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
        msgType: m.msg_type || 'text',
        encrypted: !!m.encrypted,
        repliedToId: m.replied_to_id || null,
        createdAt: m.created_at,
        readAt: m.read_at,
        editedAt: m.edited_at,
        deletedAt: m.deleted_at,
        pinnedAt: m.pinned_at,
        reactions: reactions.map(r => ({ emoji: r.emoji, count: Number(r.cnt) })),
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
    const me = req.userId;
    // 会話の数に関係なく、問い合わせは4回だけにする(以前は会話ごとに3〜4回引いていて、
    // 友達が増えるほどトークを開くのが遅くなっていた)。SQLite/PostgreSQL両対応のSQLにしている。

    // 1) 相手ごとの最新メッセージ(自分自身へのメッセージは除外)
    const latest = await db.all(`
      SELECT m.sender_id, m.recipient_id, m.content, m.encrypted, m.created_at, m.deleted_at
      FROM messages m
      WHERE m.id IN (
        SELECT (
          SELECT x.id FROM messages x
          WHERE (x.sender_id = p.other_id AND x.recipient_id = ? AND COALESCE(x.hidden_for_recipient, false) = false)
             OR (x.sender_id = ? AND x.recipient_id = p.other_id)
          ORDER BY x.created_at DESC, x.id DESC LIMIT 1
        )
        FROM (
          SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS other_id
          FROM messages
          WHERE (sender_id = ? OR (recipient_id = ? AND COALESCE(hidden_for_recipient, false) = false)) AND sender_id != recipient_id
        ) p
      )
    `, [me, me, me, me, me]);

    // 2) 相手ごとの未読数
    const unreadRows = await db.all(
      'SELECT sender_id, COUNT(*) AS cnt FROM messages WHERE recipient_id = ? AND read_at IS NULL AND COALESCE(hidden_for_recipient, false) = false GROUP BY sender_id',
      [me]
    );
    const unreadBy = new Map(unreadRows.map(r => [r.sender_id, Number(r.cnt)]));

    // 3) メッセージのない友達
    const friendRows = await db.all(`
      SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END AS friend_id
      FROM friendships
      WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'accepted'
    `, [me, me, me]);

    // 自分がブロックした相手はトーク一覧に出さない(設定のブロックリストから解除できる)
    const myBlocks = new Set((await db.all('SELECT blocked_id FROM user_blocks WHERE blocker_id = ?', [me])).map(r => r.blocked_id));
    const rows = latest
      .map(m => ({ ...m, other_id: m.sender_id === me ? m.recipient_id : m.sender_id }))
      .filter(m => !myBlocks.has(m.other_id))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const withMsg = new Set(rows.map(r => r.other_id));
    const ids = [...new Set([...rows.map(r => r.other_id), ...friendRows.map(f => f.friend_id)])];

    // 4) 表示に使うユーザー情報をまとめて取得
    const users = new Map();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const found = await db.all(
        `SELECT id, user_id, display_name, profile_pic FROM users WHERE id IN (${chunk.map(() => '?').join(',')})`,
        chunk
      );
      found.forEach(u => users.set(u.id, u));
    }

    const result = [];
    for (const row of rows) {
      const user = users.get(row.other_id);
      if (!user) continue;
      result.push({
        userId: user.id,
        userIdCode: user.user_id,
        displayName: user.display_name,
        profilePic: user.profile_pic,
        lastMessage: row.deleted_at ? '（送信取り消し済み）' : toPreviewText(row.content, row.encrypted),
        lastTime: row.created_at,
        unreadCount: unreadBy.get(row.other_id) || 0,
      });
    }
    // メッセージのない友達も含める
    for (const f of friendRows) {
      if (withMsg.has(f.friend_id) || myBlocks.has(f.friend_id)) continue;
      const user = users.get(f.friend_id);
      if (!user) continue;
      withMsg.add(f.friend_id);
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
    if (!req.body?.encrypted) censorBodyAndBanAfter(req, res, ['content']);
    const { messageId, content, encrypted } = req.body;
    if (!messageId || !content) return res.status(400).json({ error: 'messageId and content required' });
    // 編集には長さの上限が無く、4MBの本文を何度でも書き込めた。送信と同じ基準に揃える
    const badEdit = validateMessageInput(req.body, { allowMedia: false });
    if (badEdit) return res.status(badEdit === 'メッセージが長すぎます' ? 413 : 400).json({ error: badEdit });

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (msg.sender_id !== req.userId) return res.status(403).json({ error: 'not authorized' });
    if (msg.deleted_at) return res.status(400).json({ error: 'message deleted' });
    // サーバーが作る「通知」を本人が書き換えられないようにする
    if (msg.msg_type === 'notice') return res.status(400).json({ error: 'この種類のメッセージは編集できません' });

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
    if (!updated.hidden_for_recipient) broadcastToUser(updated.recipient_id, payload);
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
    if (!msg.hidden_for_recipient) broadcastToUser(msg.recipient_id, payload);
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
    if (msg.recipient_id === req.userId && msg.hidden_for_recipient) {
      return res.status(404).json({ error: 'message not found' });
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
    if (!msg.hidden_for_recipient) broadcastToUser(msg.recipient_id, payload);
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
    // emojiは絵文字1〜2文字想定。長い文字列でDBを汚染させない。
    if (typeof emoji !== 'string' || emoji.length > 10) {
      return res.status(400).json({ error: '不正なemojiです' });
    }

    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [messageId]);
    if (!msg) return res.status(404).json({ error: 'message not found' });
    if (msg.sender_id !== req.userId && msg.recipient_id !== req.userId) {
      return res.status(403).json({ error: 'not authorized' });
    }
    if (msg.recipient_id === req.userId && msg.hidden_for_recipient) {
      return res.status(404).json({ error: 'message not found' });
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
      reactions: reactions.map(r => ({ emoji: r.emoji, count: Number(r.cnt) })),
      senderId: msg.sender_id,
      recipientId: msg.recipient_id,
    };
    const { broadcastToUser } = require('../ws/wsServer');
    if (!msg.hidden_for_recipient) broadcastToUser(msg.recipient_id, payload);
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
      WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ? AND COALESCE(hidden_for_recipient, false) = false))
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
