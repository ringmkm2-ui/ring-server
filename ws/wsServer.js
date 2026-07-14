// ws/wsServer.js
// WebSocketServer: テキストメッセージの「中継のみ」を行う。
// サーバーはテキスト本文を保存しない (相手がオフラインの間だけ一時キューに置く)。
// 画像/動画は別途 REST (routes/media.js) でアップロード済みのURLだけをここで中継する。
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyTokenRaw } = require('../routes/auth');

const connections = new Map(); // userId -> Set<ws>

function broadcastToUser(userId, payload) {
  const set = connections.get(userId);
  if (!set) return false;
  const msg = JSON.stringify(payload);
  let delivered = false;
  set.forEach(ws => {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
      delivered = true;
    }
  });
  return delivered;
}

async function flushOfflineQueue(userId) {
  const rows = await db.all('SELECT * FROM offline_queue WHERE recipient_id = ? ORDER BY created_at ASC', [userId]);
  rows.forEach(row => {
    broadcastToUser(userId, {
      type: 'message',
      senderId: row.sender_id,
      msgUuid: row.msg_uuid,
      payload: JSON.parse(row.payload),
      queued: true,
    });
  });
  if (rows.length > 0) {
    await db.run('DELETE FROM offline_queue WHERE recipient_id = ?', [userId]);
    console.log(`[ws] ${rows.length}件のオフラインキューを ${userId} に配送し、DBから削除しました`);
  }
}

function initWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    let userId = null;

    ws.on('message', async raw => {
      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }

      // --- 認証 (接続直後に1回だけ) ---
      if (data.type === 'auth') {
        const payload = verifyTokenRaw(data.token);
        if (!payload) {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'トークンが無効です' }));
          ws.close();
          return;
        }
        userId = payload.userId;
        if (!connections.has(userId)) connections.set(userId, new Set());
        connections.get(userId).add(ws);
        ws.send(JSON.stringify({ type: 'auth_ok', userId }));
        await flushOfflineQueue(userId); // オンラインになった瞬間、溜まっていたメッセージを配送
        return;
      }

      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', error: '先に auth してください' }));
        return;
      }

      // --- テキスト/暗号化メッセージの中継 ---
      // data: { type:'message', recipientId, payload (暗号化済み本文), msgUuid }
      if (data.type === 'message') {
        const msgUuid = data.msgUuid || uuidv4(); // 重複排除用の一意ID
        const delivered = broadcastToUser(data.recipientId, {
          type: 'message',
          senderId: userId,
          msgUuid,
          payload: data.payload,
          queued: false,
        });

        if (!delivered) {
          // 相手がオフライン → 一時的にDBへ (配送完了後は即削除する設計)
          await db.run(
            'INSERT INTO offline_queue (id, recipient_id, sender_id, payload, msg_uuid) VALUES (?, ?, ?, ?, ?)',
            [uuidv4(), data.recipientId, userId, JSON.stringify(data.payload), msgUuid]
          );
        }

        // 送信者に確認応答 (チェックマーク点灯用)
        ws.send(JSON.stringify({ type: 'sent_ack', msgUuid, delivered }));
        return;
      }

      // --- 既読通知の中継 ---
      if (data.type === 'read_receipt') {
        broadcastToUser(data.recipientId, {
          type: 'read_receipt',
          fromUserId: userId,
          msgUuid: data.msgUuid,
        });
        return;
      }

      // --- タイピングインジケータの中継 ---
      if (data.type === 'typing') {
        broadcastToUser(data.recipientId, {
          type: 'typing',
          userId: userId,
        });
        return;
      }

      // --- グループメッセージの中継 (メンバー全員に配送) ---
      if (data.type === 'group_message') {
        const members = await db.all(
          'SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL AND user_id != ?',
          [data.groupId, userId]
        );
        const msgUuid = data.msgUuid || uuidv4();
        for (const m of members) {
          const delivered = broadcastToUser(m.user_id, {
            type: 'group_message',
            groupId: data.groupId,
            senderId: userId,
            msgUuid,
            payload: data.payload,
            keyVersion: data.keyVersion,
          });
          if (!delivered) {
            await db.run(
              'INSERT INTO offline_queue (id, recipient_id, sender_id, payload, msg_uuid) VALUES (?, ?, ?, ?, ?)',
              [uuidv4(), m.user_id, userId, JSON.stringify({ group: true, groupId: data.groupId, ...data.payload }), msgUuid]
            );
          }
        }
        return;
      }
    });

    ws.on('close', () => {
      if (userId && connections.has(userId)) {
        connections.get(userId).delete(ws);
        if (connections.get(userId).size === 0) connections.delete(userId);
      }
    });
  });

  console.log('[ws] WebSocketServer 起動 (path: /ws)');
  return wss;
}

module.exports = { initWebSocketServer, broadcastToUser };
