// ws/wsServer.js
// WebSocketServer: テキストメッセージの「中継のみ」を行う。
// サーバーはテキスト本文を保存しない (相手がオフラインの間だけ一時キューに置く)。
// 画像/動画は別途 REST (routes/media.js) でアップロード済みのURLだけをここで中継する。
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyTokenRaw } = require('../routes/auth');
const { sendPushToUser } = require('../utils/webPush');
const callAssist = require('./callAssistProxy');

const connections = new Map(); // userId -> Set<ws>

// 呼び出し中の通話。相手のアプリが閉じていてWSが繋がっていない間に届いた
// call_offer と ICE候補をここに置いておき、相手が(着信通知から)アプリを開いて
// WSを繋いだ瞬間に再配送する。以前は offer を中継するだけで、相手がオフラインだと
// 発信側に即 call_unavailable を返して終わっていたため、アプリを閉じている相手には
// どう頑張っても繋がらなかった。
const pendingCalls = new Map(); // callId -> { from, to, sdp, isVideo, ice[], ts, timer }
const RING_TIMEOUT_MS = 45000;

function clearPendingCall(callId) {
  const p = pendingCalls.get(callId);
  if (!p) return null;
  clearTimeout(p.timer);
  if (p.repeat) { clearInterval(p.repeat); p.repeat = null; }
  pendingCalls.delete(callId);
  return p;
}

// 着信を鳴らしている全端末(Web Push / APKのFCM)に「もう鳴らさなくていい」を送る
// missedFrom を渡すと「不在着信」通知に差し替える(iPhoneのPWAは着信音を指定できないので、
// 鳴らしっぱなしの着信通知を消す代わりに不在着信として残す)。渡さなければ静かに消すだけ。
async function cancelRinging(userId, callId, missedFrom) {
  if (missedFrom) {
    try {
      const caller = await db.get('SELECT display_name, username FROM users WHERE id = ?', [missedFrom]);
      const callerName = caller?.display_name || caller?.username || '不明なユーザー';
      sendPushToUser(userId, { type: 'call_missed', callId, callerId: missedFrom, callerName }, { ttl: 3600 })
        .catch(err => console.error('[push] call_missed failed:', err.message));
    } catch (err) {
      console.error('[push] call_missed lookup failed:', err.message);
    }
  } else {
    sendPushToUser(userId, { type: 'call_cancelled', callId }, { ttl: 30, skipApple: true })
      .catch(err => console.error('[push] call_cancelled failed:', err.message));
  }
  try {
    require('../utils/fcm').sendCallCancelled(userId, callId)
      .catch(err => console.error('[fcm] call_cancelled failed:', err.message));
  } catch (err) {
    console.error('[fcm] call_cancelled failed:', err.message);
  }
}

// APKのネイティブ着信画面から拒否されたとき(WSを持っていない)に使う
function rejectPendingCall(userId, callId) {
  const p = pendingCalls.get(callId);
  if (!p || p.to !== userId) return false;
  clearPendingCall(callId);
  broadcastToUser(p.from, { type: 'call_reject', callId, fromUserId: userId, reason: 'declined' });
  cancelRinging(userId, callId);
  return true;
}


// --- グループ通話(メッシュ型WebRTC) ---
// サーバーは参加者名簿とSDP/ICEの中継だけを行う。映像・音声は参加者同士が直接やり取りする。
// 参加者が増えると各端末の負荷が跳ね上がるため上限を設ける。
const groupCalls = new Map(); // groupId -> { video, startedAt, startedBy, peers: Map<userId, ws> }
// メッシュ型は1人あたり(人数-1)本の接続を張るので、30人では成立しない。
// 端末が耐えられる範囲として、音声は8人、ビデオは4人まで。
const GROUP_CALL_MAX_AUDIO = 8;
const GROUP_CALL_MAX_VIDEO = 4;

async function isActiveGroupMember(groupId, userId) {
  const row = await db.get(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
    [groupId, userId]
  );
  return !!row;
}

async function broadcastToGroupMembers(groupId, payload, exceptUserId) {
  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => { if (m.user_id !== exceptUserId) broadcastToUser(m.user_id, payload); });
}

function leaveGroupCall(groupId, userId, ws) {
  const room = groupCalls.get(groupId);
  if (!room) return;
  // 別端末の同一ユーザーの接続を巻き込まない
  if (room.peers.get(userId) !== ws) return;
  room.peers.delete(userId);
  room.peers.forEach(peerWs => {
    if (peerWs.readyState === peerWs.OPEN) peerWs.send(JSON.stringify({ type: 'gcall_left', groupId, userId }));
  });
  if (room.peers.size === 0) {
    groupCalls.delete(groupId);
    broadcastToGroupMembers(groupId, { type: 'gcall_ended', groupId }).catch(() => {});
  }
}

function isUserOnline(userId) {
  const set = connections.get(userId);
  return !!set && set.size > 0;
}

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

// userIdがオンライン/オフラインになったことを、そのユーザーと1対1チャット中の
// 相手全員に通知する。誰が「相手」かはDBに問い合わせず、単純にトークしたことの
// ある全ユーザーへブロードキャストすると重いので、実際に接続中のユーザーのうち
// 過去にメッセージをやり取りしたことがある相手にだけ送る。
async function broadcastPresence(userId, online) {
  try {
    const rows = await db.all(
      `SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END as other_id
       FROM messages WHERE (sender_id = ? OR recipient_id = ?) AND sender_id != recipient_id`,
      [userId, userId, userId]
    );
    rows.forEach(row => {
      broadcastToUser(row.other_id, { type: 'presence_update', userId, online });
    });
  } catch (err) {
    console.error('[ws] presence broadcast error:', err);
  }
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
  // maxPayload: 単一WSフレームの最大サイズ。デフォルトは100MBで実質無制限。
  // 大きいペイロードでメモリ枯渇するDoSを防ぐため64KBに制限する。
  // (メッセージ本体はREST API経由で送られ、WSは通知のみのため64KBで十分)
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  // IP別接続数トラッキング（DDoS/接続枯渇対策）
  const ipConnections = new Map(); // IP -> count
  const MAX_CONNECTIONS_PER_IP = 10;

  // 死んだ接続の掃除: 相手が機内モード等で突然消えるとTCPが半開きのまま残り、
  // サーバーは「まだ繋がっている」と思い込む(着信を送ったつもりになる)。
  // 20秒ごとにpingし、次のpingまでにpongが返らない接続は切る。
  const heartbeat = setInterval(() => {
    wss.clients.forEach(c => {
      if (c.isAlive === false) { try { c.terminate(); } catch (e) {} return; }
      c.isAlive = false;
      try { c.ping(); } catch (e) {}
    });
  }, 20000);
  wss.on('close', () => clearInterval(heartbeat));

  wss.on('connection', (ws, req) => {
    let userId = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    // Call Assist: track('mic'|'remote')ごとに有効なDeepgramセッションIDを保持する。
    // 自分のマイク音声と相手の受信音声(remoteAudio)を別々に文字起こしするため。
    let callAssistSessions = { mic: null, remote: null };

    // 同一IPからの過剰接続をブロック
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
    const currentCount = ipConnections.get(clientIp) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      ws.close(1008, 'Too many connections from this IP');
      console.warn(`[ws] IP接続数上限 (${MAX_CONNECTIONS_PER_IP}): ${clientIp}`);
      return;
    }
    ipConnections.set(clientIp, currentCount + 1);

    ws.on('close', () => {
      const cnt = (ipConnections.get(clientIp) || 1) - 1;
      if (cnt <= 0) ipConnections.delete(clientIp);
      else ipConnections.set(clientIp, cnt);
    });

    // WSメッセージのレート制限（スライディングウィンドウ方式）。
    // REST APIにはexpress-rate-limitがあるが、WS経由は制限が無かった。
    // 認証済みユーザーが毎秒数千のメッセージを流し込んでDBやブロードキャストを
    // 飽和させるDoSが可能だったため、1秒あたり30メッセージに制限する。
    // バイナリ(音声チャンク)は高頻度で正常なため除外する。
    const WS_RATE_WINDOW_MS = 1000;
    const WS_RATE_MAX = 30;
    let wsRateCount = 0;
    let wsRateWindowStart = Date.now();

    ws.on('message', async (raw, isBinary) => {
      // バイナリ(音声)はレート制限対象外
      if (!isBinary) {
        const now = Date.now();
        if (now - wsRateWindowStart > WS_RATE_WINDOW_MS) {
          wsRateCount = 0;
          wsRateWindowStart = now;
        }
        wsRateCount++;
        if (wsRateCount > WS_RATE_MAX) {
          ws.send(JSON.stringify({ type: 'error', error: 'メッセージ送信が速すぎます' }));
          return;
        }
      }

      // Call Assist: リアルタイム字幕用の音声チャンク(バイナリフレーム)。
      // 先頭1バイトがtrack識別子(0x01=自分のマイク, 0x02=相手の受信音声)、
      // 残りがPCM16音声データ本体。
      if (isBinary) {
        if (userId && raw.length > 1) {
          const trackByte = raw[0];
          const audioData = raw.subarray(1);
          const track = trackByte === 0x02 ? 'remote' : 'mic';
          const sessionId = callAssistSessions[track];
          if (sessionId) {
            callAssist.sendAudioChunk(sessionId, audioData);
          }
        }
        return;
      }

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
        // 呼び出し中の着信があれば offer と ICE をこの接続に再配送する
        pendingCalls.forEach((p, callId) => {
          if (p.to !== userId) return;
          ws.send(JSON.stringify({ type: 'call_offer', callId, fromUserId: p.from, sdp: p.sdp, isVideo: p.isVideo, redelivered: true }));
          p.ice.forEach(candidate => ws.send(JSON.stringify({ type: 'call_ice', callId, fromUserId: p.from, candidate })));
        });
        // WS接続だけではオンラインにしない（chat_openイベントで明示的にオンラインにする）
        return;
      }

      // --- チャット画面を開いた/閉じた通知 ---
      if (data.type === 'chat_open') {
        if (!userId) return;
        broadcastPresence(userId, true);
        return;
      }
      if (data.type === 'chat_close') {
        if (!userId) return;
        broadcastPresence(userId, false);
        return;
      }

      // --- 相手のオンライン状態を問い合わせ ---
      if (data.type === 'presence_query') {
        if (!userId) return;
        ws.send(JSON.stringify({
          type: 'presence_result',
          userId: data.targetUserId,
          online: isUserOnline(data.targetUserId),
        }));
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

          // FCMでオフラインの相手に通知
          try {
            const fcm = require('../utils/fcm');
            const sender = await db.get('SELECT display_name, username FROM users WHERE id = ?', [userId]);
            const senderName = sender?.display_name || sender?.username || '不明';
            fcm.sendMessageNotification(data.recipientId, senderName, '新しいメッセージ', 'dm');
          } catch (fcmErr) {
            console.error('[fcm] message push failed:', fcmErr.message);
          }
        }

        // 送信者に確認応答 (チェックマーク点灯用)
        ws.send(JSON.stringify({ type: 'sent_ack', msgUuid, delivered }));
        return;
      }

      // --- 既読通知の中継・DB更新 ---
      if (data.type === 'read_receipt') {
        // 認可チェック: 自分が受信者のメッセージのみ既読にできる
        const targetMsg = await db.get(
          'SELECT id, sender_id, recipient_id FROM messages WHERE id = ?',
          [data.msgUuid]
        );
        if (!targetMsg || targetMsg.recipient_id !== userId) {
          // 存在しないIDや他人宛のメッセージへの操作は無視する
          return;
        }
        // DBの read_at をすぐに更新
        await db.run(
          'UPDATE messages SET read_at = ? WHERE id = ?',
          [new Date().toISOString(), data.msgUuid]
        );
        // 送信側（通知される側）に既読通知を送信
        // セキュリティ修正: data.recipientId(クライアントが自由に指定できる値)ではなく、
        // DBから取得したtargetMsg.sender_id(実際のメッセージ送信者)を通知先に使う。
        // 以前はクライアントが任意のuserIdを指定して、無関係な第三者に
        // 偽の既読通知を送りつけることが可能だった。
        broadcastToUser(targetMsg.sender_id, {
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
        // セキュリティ修正: 送信者がグループのアクティブメンバーか検証する。
        // 以前はgroupIdさえ知っていれば部外者でもグループ全員に偽メッセージを
        // 送信でき、オフラインキューにも永続的に保存されてしまう状態だった。
        const senderMembership = await db.get(
          'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
          [data.groupId, userId]
        );
        if (!senderMembership) {
          ws.send(JSON.stringify({ type: 'error', error: 'このグループのメンバーではありません' }));
          return;
        }
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
        // callIdが無い/宛先が無いofferは不正(キャンセル後の遅延送信など)。鳴らさず、タイマーも作らない
        if (!data.callId || !data.recipientId) return;
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

        // 相手がWS未接続でも即「不在」にはしない。プッシュで相手の端末を鳴らし、
        // 相手がアプリを開いたら offer を再配送する。RING_TIMEOUT_MS 内に応答が無ければ不在扱い。
        clearPendingCall(data.callId);
        const pending = {
          from: userId, to: data.recipientId, sdp: data.sdp, isVideo: !!data.isVideo,
          ice: [], ts: Date.now(), timer: null, delivered: false, // 相手の画面から call_ringing が来たら true
        };
        pending.timer = setTimeout(() => {
          const pc = pendingCalls.get(data.callId);
          if (!pc) return;
          clearPendingCall(data.callId);
          // 相手の端末で一度でも鳴っていれば「出られない」(留守番電話へ)、
          // 一度も繋がらなかったら「電波の届かない場所…」のガイダンスにする
          broadcastToUser(userId, { type: 'call_unavailable', callId: data.callId, reason: pc.delivered ? 'no_answer' : 'unreachable' });
          cancelRinging(data.recipientId, data.callId, userId);
        }, RING_TIMEOUT_MS);
        pendingCalls.set(data.callId, pending);
        if (!delivered) {
          ws.send(JSON.stringify({ type: 'call_waiting', callId: data.callId }));
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
          const callerName = caller?.display_name || caller?.username || '不明なユーザー';
          // Base64のプロフィール画像はプッシュの上限(約4KB)を超えるので載せない
          const rawPic = caller?.profile_pic || null;
          const callerPic = rawPic && !String(rawPic).startsWith('data:') && String(rawPic).length < 512 ? rawPic : null;

          // Web Push（ブラウザ用）
          // iPhoneのPWAは着信音を指定できず、通知音は1回しか鳴らない。電話のように鳴り続けて
          // 聞こえるよう、相手の画面で着信が出る(call_ringing)まで7秒おきに最大5回、同じtagで送り直す。
          const ringPayload = {
            type: 'call_incoming',
            callId: data.callId,
            callerId: userId,
            callerName,
            callerPic,
            isVideo: !!data.isVideo,
          };
          const sendRing = () => sendPushToUser(data.recipientId, ringPayload, { ttl: 30 })
            .catch(err => console.error('[push] call_offer push failed:', err.message));
          sendRing();
          if (pendingCalls.get(data.callId) === pending) {
            let repeats = 0;
            pending.repeat = setInterval(() => {
              if (pendingCalls.get(data.callId) !== pending || pending.delivered || ++repeats > 5) {
                clearInterval(pending.repeat); pending.repeat = null;
                return;
              }
              sendRing();
            }, 7000);
          }

          // FCM Push（Capacitorアプリ用）
          try {
            const fcm = require('../utils/fcm');
            fcm.sendCallNotification(data.recipientId, userId, callerName, callerPic || '', data.callId, !!data.isVideo);
          } catch (fcmErr) {
            console.error('[fcm] call push failed:', fcmErr.message);
          }
        } catch (err) {
          console.error('[push] caller lookup failed:', err.message);
        }

        return;
      }

      if (data.type === 'call_ringing') {
        // data: { callId } 相手の端末で着信画面が出た(= 圏外ではない)
        const p = pendingCalls.get(data.callId);
        if (p && p.to === userId) p.delivered = true;
        return;
      }

      if (data.type === 'call_answer') {
        // data: { recipientId, callId, sdp }
        clearPendingCall(data.callId);
        cancelRinging(userId, data.callId); // 応答した本人の他端末(APK等)の着信音を止める
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
        const pendingIce = pendingCalls.get(data.callId);
        if (pendingIce && pendingIce.from === userId && pendingIce.ice.length < 100) {
          pendingIce.ice.push(data.candidate);
        }
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
        clearPendingCall(data.callId);
        // 拒否した本人の他端末と、相手側に残っている着信通知を消す
        cancelRinging(userId, data.callId);
        cancelRinging(data.recipientId, data.callId);
        return;
      }

      if (data.type === 'call_end') {
        // data: { recipientId, callId }
        broadcastToUser(data.recipientId, {
          type: 'call_end',
          callId: data.callId,
          fromUserId: userId,
        });
        const wasRinging = clearPendingCall(data.callId);
        // 呼び出し中に発信者が切った場合など、相手の端末で鳴っている着信を止める
        // (まだ鳴っていた=応答されていないので、iPhoneにも不在着信として残す)
        cancelRinging(data.recipientId, data.callId, wasRinging ? userId : undefined);
        ['mic', 'remote'].forEach(track => {
          if (callAssistSessions[track]) {
            callAssist.stopSession(callAssistSessions[track]);
            callAssistSessions[track] = null;
          }
        });
        return;
      }

      // --- グループ通話 ---
      if (data.type === 'gcall_status') {
        if (!userId || !data.groupId) return;
        if (!(await isActiveGroupMember(data.groupId, userId))) return;
        const room = groupCalls.get(data.groupId);
        ws.send(JSON.stringify({
          type: 'gcall_state', groupId: data.groupId, active: !!room,
          participants: room ? [...room.peers.keys()] : [], video: room ? room.video : false, self: false,
        }));
        return;
      }

      if (data.type === 'gcall_join') {
        if (!userId || !data.groupId) return;
        const groupId = data.groupId;
        if (!(await isActiveGroupMember(groupId, userId))) return;
        let room = groupCalls.get(groupId);
        const isNew = !room;
        if (isNew) {
          room = { video: !!data.video, startedAt: Date.now(), startedBy: userId, peers: new Map() };
          groupCalls.set(groupId, room);
        }
        const roomMax = room.video ? GROUP_CALL_MAX_VIDEO : GROUP_CALL_MAX_AUDIO;
        if (!room.peers.has(userId) && room.peers.size >= roomMax) {
          if (isNew) groupCalls.delete(groupId);
          ws.send(JSON.stringify({ type: 'gcall_full', groupId, max: roomMax }));
          return;
        }
        // 同じユーザーが別端末から入り直した場合は古い接続を外す
        const prev = room.peers.get(userId);
        if (prev && prev !== ws && prev.readyState === prev.OPEN) {
          prev.send(JSON.stringify({ type: 'gcall_kicked', groupId }));
        }
        const existing = [...room.peers.keys()].filter(id => id !== userId);
        room.peers.set(userId, ws);
        // 入った本人には既存の参加者を渡す。接続(offer)は「入った側」から既存の全員へ張る
        ws.send(JSON.stringify({ type: 'gcall_state', groupId, active: true, participants: existing, video: room.video, self: true }));
        room.peers.forEach((peerWs, id) => {
          if (id !== userId && peerWs.readyState === peerWs.OPEN) {
            peerWs.send(JSON.stringify({ type: 'gcall_joined', groupId, userId }));
          }
        });
        if (isNew) {
          try {
            const group = await db.get('SELECT name FROM groups WHERE id = ?', [groupId]);
            const caller = await db.get('SELECT display_name FROM users WHERE id = ?', [userId]);
            const callerName = caller?.display_name || 'ユーザー';
            const groupName = group?.name || 'グループ';
            const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
            members.forEach(m => {
              if (m.user_id === userId) return;
              broadcastToUser(m.user_id, { type: 'gcall_started', groupId, groupName, byUserId: userId, byName: callerName, video: room.video });
              require('../utils/fcm').sendMessageNotification(
                m.user_id, `${callerName} (${groupName})`, 'グループ通話が始まりました', 'group', { senderId: userId, chatId: groupId }
              ).catch(err => console.error('[fcm] group call failed:', err.message));
              if (!isUserOnline(m.user_id)) {
                sendPushToUser(m.user_id, {
                  type: 'new_group_message', groupId, groupName, senderName: callerName, preview: 'グループ通話が始まりました',
                }).catch(err => console.error('[push] group call failed:', err.message));
              }
            });
          } catch (err) {
            console.error('[ws] group call notify error:', err);
          }
        }
        return;
      }

      if (data.type === 'gcall_signal') {
        // data: { groupId, to, kind: 'offer'|'answer'|'ice', sdp?, candidate? }
        if (!userId || !data.groupId || !data.to) return;
        const room = groupCalls.get(data.groupId);
        if (!room || room.peers.get(userId) !== ws) return; // 参加していない人の中継はしない
        const target = room.peers.get(data.to);
        if (!target || target.readyState !== target.OPEN) return;
        if (!['offer', 'answer', 'ice'].includes(data.kind)) return;
        target.send(JSON.stringify({
          type: 'gcall_signal', groupId: data.groupId, from: userId, kind: data.kind,
          sdp: data.sdp, candidate: data.candidate,
        }));
        return;
      }

      if (data.type === 'gcall_leave') {
        if (!userId || !data.groupId) return;
        leaveGroupCall(data.groupId, userId, ws);
        return;
      }

      // --- Call Assist: リアルタイム字幕・翻訳セッションの開始 ---
      // data: { callId, language?, track? }  track: 'mic'(自分) | 'remote'(相手)
      if (data.type === 'call_assist_start') {
        if (!userId) return;
        if (!callAssist.isDeepgramConfigured()) {
          ws.send(JSON.stringify({ type: 'call_assist_error', error: '音声認識機能が現在利用できません(サーバー未設定)', track: data.track }));
          return;
        }
        const track = data.track === 'remote' ? 'remote' : 'mic';
        if (callAssistSessions[track]) {
          callAssist.stopSession(callAssistSessions[track]);
        }
        const sessionId = `${userId}:${data.callId}:${track}:${Date.now()}`;
        callAssistSessions[track] = sessionId;
        callAssist.startSession(sessionId, {
          language: data.language || 'ja',
          onTranscript: (text, isFinal) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'call_assist_transcript', text, isFinal, track }));
            }
          },
          onError: (err) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'call_assist_error', error: err.message, track }));
            }
          },
        });
        return;
      }

      // --- Call Assist: 字幕セッション終了 ---
      // data: { track? }  未指定なら両方停止する
      if (data.type === 'call_assist_stop') {
        const tracks = data.track ? [data.track] : ['mic', 'remote'];
        tracks.forEach(track => {
          if (callAssistSessions[track]) {
            callAssist.stopSession(callAssistSessions[track]);
            callAssistSessions[track] = null;
          }
        });
        return;
      }
    });

    ws.on('close', () => {
      if (userId) groupCalls.forEach((room, gid) => { if (room.peers.get(userId) === ws) leaveGroupCall(gid, userId, ws); });
      ['mic', 'remote'].forEach(track => {
        if (callAssistSessions[track]) {
          callAssist.stopSession(callAssistSessions[track]);
          callAssistSessions[track] = null;
        }
      });
      if (userId && connections.has(userId)) {
        connections.get(userId).delete(ws);
        if (connections.get(userId).size === 0) {
          connections.delete(userId);
          broadcastPresence(userId, false); // 相手に「オフラインになった」ことを通知
        }
      }
    });
  });

  console.log('[ws] WebSocketServer 起動 (path: /ws)');
  return wss;
}

module.exports = { initWebSocketServer, broadcastToUser, isUserOnline, rejectPendingCall };
