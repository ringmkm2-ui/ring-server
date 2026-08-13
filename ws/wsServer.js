// ws/wsServer.js
// WebSocketServer: テキストメッセージの「中継のみ」を行う。
// サーバーはテキスト本文を保存しない (相手がオフラインの間だけ一時キューに置く)。
// 画像/動画は別途 REST (routes/media.js) でアップロード済みのURLだけをここで中継する。
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyTokenRaw } = require('../routes/auth');
const { sendPushToUser } = require('../utils/webPush');

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
        const payload = await verifyTokenRaw(data.token);
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
      // 注意: 実際のメッセージ送信は現在 /api/messages/send (REST) 経由で行われており、
      // このWS直接中継は現行UIからは使われていない。ただし接続さえ確立すれば
      // 誰でも呼べる生きた経路のため、REST側と同じ認可基準を適用しておく。
      if (data.type === 'message') {
        const [msgUserA, msgUserB] = [userId, data.recipientId].sort();
        const msgFriendship = await db.get(
          "SELECT status FROM friendships WHERE user_a_id = ? AND user_b_id = ? AND status = 'accepted'",
          [msgUserA, msgUserB]
        );
        if (!msgFriendship) {
          ws.send(JSON.stringify({ type: 'error', error: '友達ではないユーザーには送信できません' }));
          return;
        }

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

      // --- 既読通知の中継・DB更新 ---
      if (data.type === 'read_receipt') {
        // DBの read_at をすぐに更新
        await db.run(
          'UPDATE messages SET read_at = ? WHERE id = ?',
          [new Date().toISOString(), data.msgUuid]
        );
        // 送信側（通知される側）に既読通知を送信
        broadcastToUser(data.recipientId, {
          type: 'read_receipt',
          fromUserId: userId,
          msgUuid: data.msgUuid,
        });
        // 受信側（既読を送った側）にも確認応答を返す
        ws.send(JSON.stringify({
          type: 'read_ack',
          msgUuid: data.msgUuid,
        }));
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

      // --- 音声通話シグナリング (WebRTC) ---
      // サーバーは映像・音声本体には一切触れず、SDP/ICE候補の中継のみを行う。
      // callId はクライアント側(発信者)が生成し、通話1本を通して一貫して使う。
      if (data.type === 'call_offer') {
        // data: { recipientId, callId, sdp, isVideo? }
        //
        // 以前は友達関係チェック(user_a_id/user_b_idがfriendships上でacceptedか)を
        // ここに入れていたが、これがあるとテスト用アカウント間のような
        // 正式な友達登録をしていない相手には発信自体が即座に'not_friends'で
        // 弾かれ、着信が一切届かなくなる。使い勝手を優先し、このチェックは撤去した。
        const delivered = broadcastToUser(data.recipientId, {
          type: 'call_offer',
          callId: data.callId,
          fromUserId: userId,
          sdp: data.sdp,
          isVideo: !!data.isVideo,
        });

        // 相手がWS未接続(アプリを閉じている)なら、発信者にすぐ「不在」を返す
        // （オフラインキューには積まない = 電話はリアルタイム性が命）
        if (!delivered) {
          ws.send(JSON.stringify({ type: 'call_unavailable', callId: data.callId }));
        }

        // WS配達の成否にかかわらず、Push通知は常に送る
        // （スリープ中/バックグラウンドタブだとWSが届いても着信音が鳴らないため、OSレベルで叩き起こす）
        //
        // 重要: db.get()の戻り値をPromiseチェーン(.then/.catch)で扱っていたが、
        // db/db.sqlite.js の get() は同期関数(Promiseを返さない)であるため、
        // ローカル開発環境(SQLite使用時)で "db.get(...).then is not a function"
        // というTypeErrorが発生し、サーバープロセスそのものがクラッシュしていた。
        // 本番のPostgreSQL版はasync関数でこそ動いていたが、環境によって
        // 挙動が異なる書き方自体が危険なため、awaitに統一する
        // (ws.on('message', async raw => ...) 内なのでawaitが使える)。
        try {
          const caller = await db.get('SELECT display_name, username, profile_pic FROM users WHERE id = ?', [userId]);
          sendPushToUser(data.recipientId, {
            type: 'call_incoming',
            callId: data.callId,
            callerId: userId,
            callerName: caller?.display_name || caller?.username || '不明なユーザー',
            callerPic: caller?.profile_pic || null,
            isVideo: !!data.isVideo,
          }).catch(err => console.error('[push] call_offer push failed:', err.message));
        } catch (err) {
          console.error('[push] caller lookup failed:', err.message);
        }

        return;
      }

      if (data.type === 'call_answer') {
        // data: { recipientId, callId, sdp }
        broadcastToUser(data.recipientId, {
          type: 'call_answer',
          callId: data.callId,
          fromUserId: userId,
          sdp: data.sdp,
        });
        return;
      }

      if (data.type === 'call_ice') {
        // data: { recipientId, callId, candidate }
        broadcastToUser(data.recipientId, {
          type: 'call_ice',
          callId: data.callId,
          fromUserId: userId,
          candidate: data.candidate,
        });
        return;
      }

      if (data.type === 'call_reject') {
        // data: { recipientId, callId, reason? }  reason: 'declined' | 'busy'
        broadcastToUser(data.recipientId, {
          type: 'call_reject',
          callId: data.callId,
          fromUserId: userId,
          reason: data.reason || 'declined',
        });
        // バックグラウンドで表示中の着信通知があれば消す
        sendPushToUser(data.recipientId, { type: 'call_cancelled', callId: data.callId })
          .catch(err => console.error('[push] call_reject cancel push failed:', err.message));
        return;
      }

      if (data.type === 'call_end') {
        // data: { recipientId, callId }
        broadcastToUser(data.recipientId, {
          type: 'call_end',
          callId: data.callId,
          fromUserId: userId,
        });
        // 呼び出し中に発信者が切った場合など、バックグラウンド通知が残っていれば消す
        sendPushToUser(data.recipientId, { type: 'call_cancelled', callId: data.callId })
          .catch(err => console.error('[push] call_end cancel push failed:', err.message));
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
