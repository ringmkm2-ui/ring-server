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
const sessionEvents = require('../utils/sessionEvents');
const { canInteract, getBlockVersion, isBlockedEither } = require('../utils/relations');
const { getSettings } = require('../utils/userSettings');

const connections = new Map(); // userId -> Set<ws>

// 呼び出し中の通話。相手のアプリが閉じていてWSが繋がっていない間に届いた
// call_offer と ICE候補をここに置いておき、相手が(着信通知から)アプリを開いて
// WSを繋いだ瞬間に再配送する。以前は offer を中継するだけで、相手がオフラインだと
// 発信側に即 call_unavailable を返して終わっていたため、アプリを閉じている相手には
// どう頑張っても繋がらなかった。
const pendingCalls = new Map(); // callId -> { from, to, sdp, isVideo, ice[], ts, timer }
const RING_TIMEOUT_MS = 45000;

// 発信から終了までの通話の当事者。callId はクライアントが作る値なので、
// 「その通話の当事者か」をサーバー側で覚えておき、応答・ICE・拒否・終了はこの2人の間でしか中継しない。
// 以前は callId と宛先を自由に書けたため、他人の呼び出し中の通話を横取り・強制終了したり、
// 無関係な人に偽の「通話終了」を送りつけたりできた。
const activeCalls = new Map(); // callId -> { a: 発信者, b: 着信者, ts }
const ACTIVE_CALL_MAX_MS = 6 * 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of activeCalls) if (now - c.ts > ACTIVE_CALL_MAX_MS) activeCalls.delete(id);
}, 10 * 60 * 1000).unref();
const CALL_ID_RE = /^[A-Za-z0-9_.:-]{1,100}$/;

// 通知の連打よけ。グループ通話・ライブを「始める→やめる」を繰り返すと、そのたびに全員の端末へ
// プッシュ/FCMが飛び、1秒に何回でも鳴らせた。画面上の表示(WS)はそのまま、端末を鳴らすのは間隔を空ける
const notifyLast = new Map(); // key -> 最後に鳴らした時刻
function notifyAllowed(key, ms) {
  const now = Date.now();
  const t = notifyLast.get(key);
  if (t && now - t < ms) return false;
  notifyLast.set(key, now);
  if (notifyLast.size > 20000) { for (const [k, v] of notifyLast) if (now - v > 3600 * 1000) notifyLast.delete(k); }
  return true;
}
// 1対1の発信は、同じ相手へ1分に6回まで(発信→すぐ切る→発信…で相手の端末を鳴らし続けられた)
const offerLog = new Map(); // 'from>to' -> [時刻...]
function offerAllowed(from, to) {
  const key = from + '>' + to;
  const now = Date.now();
  const arr = (offerLog.get(key) || []).filter(t => now - t < 60 * 1000);
  if (arr.length >= 6) { offerLog.set(key, arr); return false; }
  arr.push(now);
  offerLog.set(key, arr);
  if (offerLog.size > 20000) { for (const [k, v] of offerLog) if (!v.length || now - v[v.length - 1] > 60 * 1000) offerLog.delete(k); }
  return true;
}
// 1人が覚えさせられる通話の数。発信→応答を繰り返すと6時間消えない記録が際限なく増えた
const MAX_ACTIVE_CALLS_PER_USER = 10;
function rememberCall(callId, a, b) {
  const mine = [];
  for (const [id, c] of activeCalls) if (c.a === a) mine.push([id, c.ts]);
  if (mine.length >= MAX_ACTIVE_CALLS_PER_USER) {
    mine.sort((x, y) => x[1] - y[1]);
    for (const [id] of mine.slice(0, mine.length - MAX_ACTIVE_CALLS_PER_USER + 1)) activeCalls.delete(id);
  }
  activeCalls.set(callId, { a, b, ts: Date.now() });
}
function callPeerOf(callId, userId) {
  const c = typeof callId === 'string' ? activeCalls.get(callId) : null;
  if (!c) return null;
  if (c.a === userId) return c.b;
  if (c.b === userId) return c.a;
  return null;
}
function isCallParticipant(callId, userId) {
  return !!callPeerOf(callId, userId);
}
// 相手が出た後の通話の当事者か(字幕は呼び出し中には使わせない。以前は出てもらえない発信でも字幕を起動できた)
function isCallAnswered(callId, userId) {
  const c = typeof callId === 'string' ? activeCalls.get(callId) : null;
  return !!(c && c.answered && (c.a === userId || c.b === userId));
}

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
      const caller = await db.get('SELECT display_name, username, profile_pic FROM users WHERE id = ?', [missedFrom]);
      const callerName = caller?.display_name || caller?.username || '不明なユーザー';
      sendPushToUser(userId, { type: 'call_missed', callId, callerId: missedFrom, callerName, callerPic: require('../utils/pushPic').pushPic(caller?.profile_pic) }, { ttl: 3600 })
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
  activeCalls.delete(callId);
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

// グループから外された(抜けた)人を、そのグループの通話からも外す。
// 以前は外されても通話に残り、後から入ってきた人の映像・音声を受け取り続けられた
function kickFromGroupCall(groupId, userId) {
  const room = groupCalls.get(groupId);
  if (!room) return;
  const ws = room.peers.get(userId);
  if (!ws) return;
  try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'gcall_ended', groupId })); } catch (_) {}
  leaveGroupCall(groupId, userId, ws);
}

// ===== ライブ配信(グループ) =====
// 配信者1人が、見ている人それぞれへ直接WebRTCで映像を送る(サーバーは名簿と合図の中継だけ)。
// 配信者の回線で送れる量に限りがあるので、同時に見られるのは10人まで。
const liveRooms = new Map(); // groupId -> { host, hostWs, hostName, viewers: Map<userId, ws>, startedAt }
const LIVE_MAX_VIEWERS = 10;
// このユーザーとブロックし合っている人のID(コメントを届けるかどうかの判定用)
async function liveBlockSet(userId) {
  const rows = await db.all('SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [userId, userId]);
  return new Set(rows.map(b => (b.blocker_id === userId ? b.blocked_id : b.blocker_id)));
}
function liveSend(ws, obj) { try { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); } catch (_) {} }
function liveCount(groupId) {
  const r = liveRooms.get(groupId);
  if (!r) return;
  const msg = { type: 'live_count', groupId, viewers: r.viewers.size };
  liveSend(r.hostWs, msg);
  r.viewers.forEach(w => liveSend(w, msg));
  liveViewersBroadcast(groupId);
}
// 「誰が見ているか」の名簿。配信者と、見ている全員に送る(最大10人なので小さい)
function liveViewerList(r) {
  const list = [];
  r.viewers.forEach((w, id) => {
    const i = r.info.get(id) || {};
    list.push({ id, name: i.name || 'ユーザー', pic: i.pic || null, muted: r.muted.has(id) });
  });
  return list;
}
function liveViewersMsg(groupId, r) {
  return { type: 'live_viewers', groupId, host: { id: r.host, name: r.hostName, pic: r.hostPic || null }, viewers: liveViewerList(r) };
}
function liveViewersBroadcast(groupId) {
  const r = liveRooms.get(groupId);
  if (!r) return;
  const msg = liveViewersMsg(groupId, r);
  liveSend(r.hostWs, msg);
  r.viewers.forEach(w => liveSend(w, msg));
}
function liveMetaMsg(groupId, r) { return { type: 'live_meta', groupId, title: r.title || '', comments: r.comments !== false }; }
const LIVE_TITLE_MAX = 60, LIVE_COMMENT_MAX = 200, LIVE_COMMENT_GAP_MS = 700, LIVE_CHAT_KEEP = 50;
// 制御文字を落として、前後の空白を詰め、長さを切る
function liveClean(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
// 禁止語は「f***」にして通し、言った本人は3日間停止(投稿・コメントと同じ扱い)
function liveModerate(userId, text) {
  const mod = require('../utils/moderation');
  if (!text || !mod.containsBannedWord(text)) return text;
  mod.banUser(userId, 'profanity').catch(() => {});
  return mod.censor(text);
}
function endLive(groupId) {
  const r = liveRooms.get(groupId);
  if (!r) return;
  liveRooms.delete(groupId);
  if (groupId.startsWith('u:')) {
    // 投稿タブのライブ: 見ていた人と、配信者の友だちに知らせる
    r.viewers.forEach(w => liveSend(w, { type: 'live_ended', groupId }));
    liveFriends(r.host).then(ids => ids.forEach(id => broadcastToUser(id, { type: 'live_ended', groupId }))).catch(() => {});
    return;
  }
  broadcastToGroupMembers(groupId, { type: 'live_ended', groupId }).catch(() => {});
}
// 投稿タブのライブ('u:<配信者ID>')を知らせる相手 = 配信者の友だち(ブロック関係の人は除く)
async function liveFriends(hostId) {
  const rows = await db.all(
    "SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END AS id FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'accepted'",
    [hostId, hostId, hostId]
  );
  const blocks = await db.all('SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [hostId, hostId]);
  const hide = new Set(blocks.map(b => (b.blocker_id === hostId ? b.blocked_id : b.blocker_id)));
  return rows.map(r => r.id).filter(id => !hide.has(id));
}
// ライブの部屋に入ってよいか。グループならメンバー、投稿タブのライブなら配信者本人(配信)か、ブロック関係でない人(見る)
async function liveAllowed(gid, userId, asHost) {
  if (gid.startsWith('u:')) {
    const hostId = gid.slice(2);
    if (asHost) return hostId === userId;
    if (!hostId || hostId === userId) return false;
    return !(await isBlockedEither(userId, hostId));
  }
  return isActiveGroupMember(gid, userId);
}
// 投稿タブに出す、今やっているライブの一覧(見る人から見てブロック関係の配信は出さない)
async function listFeedLives(viewerId) {
  const out = [];
  for (const [gid, r] of liveRooms) {
    if (!gid.startsWith('u:')) continue;
    if (r.host !== viewerId && await isBlockedEither(viewerId, r.host)) continue;
    out.push({ key: gid, hostId: r.host, hostName: r.hostName, viewers: r.viewers.size, startedAt: r.startedAt, title: r.title || '', fps: r.fps || 30 });
  }
  return out;
}
function leaveLive(groupId, userId, ws) {
  const r = liveRooms.get(groupId);
  if (!r) return;
  if (r.host === userId && r.hostWs === ws) return endLive(groupId);
  if (r.viewers.get(userId) !== ws) return;
  r.viewers.delete(userId);
  r.info.delete(userId);
  liveSend(r.hostWs, { type: 'live_viewer_left', groupId, userId });
  liveCount(groupId);
}
// グループから外された人を、見ている/配信しているライブからも外す
function kickFromLive(groupId, userId) {
  const r = liveRooms.get(groupId);
  if (!r) return;
  if (r.host === userId) return endLive(groupId);
  const w = r.viewers.get(userId);
  if (w) { liveSend(w, { type: 'live_ended', groupId }); leaveLive(groupId, userId, w); }
}

function isUserOnline(userId) {
  const set = connections.get(userId);
  return !!set && set.size > 0;
}

// 今つながっている人の一覧(運営用)。since: その人の一番古い接続が始まった時刻
function onlineUsers() {
  const out = [];
  for (const [uid, set] of connections) {
    if (!set || !set.size) continue;
    let since = Infinity;
    for (const w of set) if (w._connectedAt && w._connectedAt < since) since = w._connectedAt;
    out.push({ userId: uid, since: since === Infinity ? null : since, devices: set.size });
  }
  return out;
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
// 画面を移るたびに接続が切れてすぐ繋ぎ直されるので、そのたびに「オフライン→オンライン」を
// 相手に送ると、相手の画面でオンライン表示がちらつき、DBも毎回重い検索をしていた。
// ・オフラインは少し待ってから送る(その間に戻ってきたら何も送らない)
// ・すでにその状態を伝えてあれば送り直さない
// ・相手の一覧(トークしたことのある人)は30秒だけ覚える
const PRESENCE_OFFLINE_GRACE_MS = 4000;
const presenceSent = new Map();    // userId -> true(相手に「オンライン」と伝えてある)
const offlineTimers = new Map();   // userId -> timer
const contactCache = new Map();    // userId -> { ts, ids }
const presenceShown = new Set();   // 実際に「オンライン」を相手へ送った人
function announceOnline(userId) {
  const t = offlineTimers.get(userId);
  if (t) { clearTimeout(t); offlineTimers.delete(userId); }
  if (presenceSent.get(userId)) return;
  presenceSent.set(userId, true);
  broadcastPresence(userId, true);
}
function announceOffline(userId) {
  if (offlineTimers.has(userId)) return;
  offlineTimers.set(userId, setTimeout(() => {
    offlineTimers.delete(userId);
    if (!presenceSent.get(userId)) return;
    presenceSent.delete(userId);
    broadcastPresence(userId, false);
  }, PRESENCE_OFFLINE_GRACE_MS));
}
async function presenceContacts(userId) {
  const hit = contactCache.get(userId);
  if (hit && Date.now() - hit.ts < 30000) return hit.ids;
  // 知らせるのは今の友だちだけ。以前は「トークしたことのある人」も入れていて、友だちを解除した後も
  // 元友だちにオンライン/オフラインが届き続けていた(問い合わせ側の presence_query は既に友だち限定)
  const rows = [];
  const friends = await db.all(
    `SELECT CASE WHEN user_a_id = ? THEN user_b_id ELSE user_a_id END as other_id
     FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status = 'accepted'`,
    [userId, userId, userId]
  );
  const ids = [...new Set(rows.concat(friends).map(r => r.other_id))];
  if (contactCache.size > 2000) contactCache.clear();
  contactCache.set(userId, { ts: Date.now(), ids });
  return ids;
}

async function broadcastPresence(userId, online) {
  try {
    // 「オンライン状態を見せない」設定の人は、相手の画面に常にオフラインとして映る
    const st = await getSettings(userId);
    if (!st.showOnlineStatus && online) return;
    // 「オンラインを見せない」人は、オフラインも送らない(送るとオンラインだったことが分かる)。
    // ただし、見せていた間に「オンライン」を伝えた相手には、オフラインを1回だけ送って表示を戻す
    if (!online && !presenceShown.has(userId)) return;
    if (online) presenceShown.add(userId); else presenceShown.delete(userId);
    const rows = (await presenceContacts(userId)).map(other_id => ({ other_id }));
    // ブロックしている/されている相手には、オンラインになったことを知らせない
    const blocks = await db.all('SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?', [userId, userId]);
    const hide = new Set(blocks.map(b => (b.blocker_id === userId ? b.blocked_id : b.blocker_id)));
    rows.forEach(row => {
      if (hide.has(row.other_id)) return;
      broadcastToUser(row.other_id, { type: 'presence_update', userId, online });
    });
  } catch (err) {
    console.error('[ws] presence broadcast error:', err);
  }
}

async function flushOfflineQueue(userId) {
  // (新しく積まれることはもう無い。昔の残りを一度に全部メモリに読まないよう上限付き)
  const rows = await db.all('SELECT * FROM offline_queue WHERE recipient_id = ? ORDER BY created_at ASC LIMIT 200', [userId]);
  rows.forEach(row => {
    let payload;
    try { payload = JSON.parse(row.payload); } catch (_) { return; } // 壊れた行1件で、接続の後始末まで止まらないように
    broadcastToUser(userId, {
      type: 'message',
      senderId: row.sender_id,
      msgUuid: row.msg_uuid,
      payload,
      queued: true,
    });
  });
  if (rows.length > 0) {
    await db.run('DELETE FROM offline_queue WHERE recipient_id = ?', [userId]);
    console.log(`[ws] ${rows.length}件のオフラインキューを ${userId} に配送し、DBから削除しました`);
  }
}

// セッションが失効したら、その端末のWebSocketもすぐ切る(トークンを失効させても、
// 既に繋がっている接続は生きたままメッセージを受け取り続けてしまうため)。
sessionEvents.on('revoked', ({ userId, sid, exceptSid }) => {
  const set = connections.get(userId);
  if (!set) return;
  for (const c of [...set]) {
    const hit = sid ? c.sessionId === sid : (exceptSid ? c.sessionId !== exceptSid : true);
    if (!hit) continue;
    try { c.send(JSON.stringify({ type: 'session_revoked' })); } catch (e) {}
    try { c.close(4001, 'session revoked'); } catch (e) {}
    set.delete(c);
  }
  if (set.size === 0) connections.delete(userId);
});

function initWebSocketServer(server) {
  // maxPayload: 単一WSフレームの最大サイズ。デフォルトは100MBで実質無制限。
  // 大きいペイロードでメモリ枯渇するDoSを防ぐため64KBに制限する。
  // (メッセージ本体はREST API経由で送られ、WSは通知のみのため64KBで十分)
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

  // IP別接続数トラッキング（DDoS/接続枯渇対策）
  const ipConnections = new Map(); // IP -> count
  // 学校や家の同じWi-Fiだと全員が同じIPになる。以前は10本までで、5人ほどしかリアルタイムで繋がらなかった。
  // IPごとは緩めにして、代わりに1人あたりの本数を絞る(下の auth で古い接続から閉じる)
  const MAX_CONNECTIONS_PER_IP = 200;
  const MAX_CONNECTIONS_PER_USER = 8;

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
    let callAssistCallIds = { mic: null, remote: null }; // 字幕を始めた通話。終わった通話の字幕は音声を流しても止める
    // 入力中表示・オンライン問い合わせのたびにDBを引かないよう、関係の確認結果を1分だけ覚える
    const relationCache = new Map(); // targetId -> { ok, ts }
    const fakeCalls = new Map(); // ブロックされた相手への「呼び出し中」だけの通話 callId -> timer
    const groupTypingCache = new Map(); // groupId -> { ts, members }  (入力中の中継先。30秒だけ覚える)
    const canReach = async (targetId) => {
      if (typeof targetId !== 'string' || !targetId || targetId.length > 100) return false;
      const hit = relationCache.get(targetId);
      // ブロックの付け外しがあったら、覚えていた結果は使わない(ブロックした直後から着信も止まるように)
      if (hit && Date.now() - hit.ts < 60000 && hit.bv === getBlockVersion()) return hit.ok;
      const ok = await canInteract(userId, targetId);
      if (relationCache.size > 500) relationCache.clear();
      relationCache.set(targetId, { ok, ts: Date.now(), bv: getBlockVersion() });
      return ok;
    };

    // 同一IPからの過剰接続をブロック
    // X-Forwarded-For の先頭はクライアントが自由に書ける値なので、それで数えると
    // 毎回違うIPを名乗るだけで上限をすり抜けられた。Renderのプロキシが付け足した
    // 末尾の値(Expressの trust proxy 1 と同じ位置)を使う。
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(v => v.trim()).filter(Boolean);
    const clientIp = xff.length ? xff[xff.length - 1] : (req.socket.remoteAddress || 'unknown');
    const currentCount = ipConnections.get(clientIp) || 0;
    if (currentCount >= MAX_CONNECTIONS_PER_IP) {
      ws.close(1008, 'Too many connections from this IP');
      console.warn(`[ws] IP接続数上限 (${MAX_CONNECTIONS_PER_IP}): ${clientIp}`);
      return;
    }
    ipConnections.set(clientIp, currentCount + 1);

    ws.on('close', () => {
      fakeCalls.forEach(t => clearTimeout(t)); fakeCalls.clear();
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

    // 接続だけして認証しない接続を放置しない(15秒で切る)。接続数上限を食いつぶす嫌がらせ対策
    const authTimer = setTimeout(() => {
      if (!userId) { try { ws.close(4000, 'auth timeout'); } catch (e) {} }
    }, 15000);
    ws.on('close', () => clearTimeout(authTimer));

    const handleWsMessage = async (raw, isBinary) => {
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
            // 通話が終わった(タイムアウト・拒否・相手の終了)後も音声を流し続けて課金を増やせないよう、毎回確かめる
            if (!isCallAnswered(callAssistCallIds[track], userId)) {
              callAssist.stopSession(sessionId);
              callAssistSessions[track] = null;
              callAssistCallIds[track] = null;
            } else {
              callAssist.sendAudioChunk(sessionId, audioData);
            }
          }
        }
        return;
      }

      let data;
      try { data = JSON.parse(raw.toString()); } catch { return; }
      // 'null' や数値・配列などオブジェクト以外は無視(data.typeで落ちるのを防ぐ。認証前でも送れるため誰でもサーバーを落とせた)
      if (!data || typeof data !== 'object' || Array.isArray(data)) return;

      // --- 認証 (接続直後に1回だけ) ---
      if (data.type === 'auth') {
        // 認証は接続ごとに1回だけ。認証済みの接続で再度authを送られても無視する
        // (別ユーザーのトークンで userId を差し替えて、前のユーザーの接続集合に居座られるのを防ぐ)
        if (userId) return;
        let payload;
        try {
          payload = await verifyTokenRaw(data.token);
        } catch (e) {
          // DBの一時的な不調。auth_errorを送るとアプリがログアウトしてしまうので、
          // 黙って切って(1013 = あとでもう一度)、アプリ側の自動再接続に任せる
          console.error('[ws] auth verify error:', e && e.message);
          try { ws.close(1013, 'try again later'); } catch (_) {}
          return;
        }
        if (!payload) {
          ws.send(JSON.stringify({ type: 'auth_error', error: 'トークンが無効です' }));
          ws.close();
          return;
        }
        if (payload.bannedUntil) {
          ws.send(JSON.stringify({ type: 'banned', bannedUntil: payload.bannedUntil }));
          setTimeout(() => { try { ws.close(4003, 'banned'); } catch (e) {} }, 300);
          return;
        }
        userId = payload.userId;
        ws.sessionId = payload.sid || null;
        clearTimeout(authTimer);
        if (!connections.has(userId)) connections.set(userId, new Set());
        if (!ws._connectedAt) ws._connectedAt = Date.now();
        connections.get(userId).add(ws);
        // 1人で開きすぎた時は、いちばん古い接続を閉じる(切れたまま残った接続の掃除にもなる)
        const mineSet = connections.get(userId);
        if (mineSet.size > MAX_CONNECTIONS_PER_USER) {
          let oldest = null;
          for (const w of mineSet) if (w !== ws && (!oldest || (w._connectedAt || 0) < (oldest._connectedAt || 0))) oldest = w;
          if (oldest) { try { oldest.close(4000, 'too many connections'); } catch (_) {} }
        }
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
        announceOnline(userId);
        return;
      }
      if (data.type === 'chat_close') {
        if (!userId) return;
        announceOffline(userId);
        return;
      }

      // --- 相手のオンライン状態を問い合わせ ---
      if (data.type === 'presence_query') {
        if (!userId) return;
        // 知り合い以外のオンライン状態は見せない(常にオフライン扱い)
        const visible = await canReach(data.targetUserId);
        const targetSt = visible ? await getSettings(data.targetUserId) : null;
        ws.send(JSON.stringify({
          type: 'presence_result',
          userId: data.targetUserId,
          online: visible && targetSt.showOnlineStatus ? isUserOnline(data.targetUserId) : false,
        }));
        return;
      }

      if (!userId) {
        ws.send(JSON.stringify({ type: 'error', error: '先に auth してください' }));
        return;
      }

      // 以前ここにあった WebSocket での直接中継('message' と 'group_message')は削除した。
      // 今の画面はどちらも使っておらず(送信は全部 REST)、検査も回数制限も無く、
      // 相手がオフラインだと中身をそのままDBの offline_queue に積むので、
      // 1人でDBを埋め尽くせる穴になっていた。

      // --- 既読通知の中継・DB更新 ---
      if (data.type === 'read_receipt') {
        // 認可チェック: 自分が受信者のメッセージのみ既読にできる
        const targetMsg = await db.get(
          'SELECT id, sender_id, recipient_id, hidden_for_recipient FROM messages WHERE id = ?',
          [data.msgUuid]
        );
        if (!targetMsg || targetMsg.recipient_id !== userId) {
          // 存在しないIDや他人宛のメッセージへの操作は無視する
          return;
        }
        // ブロック中に届いた(自分には見えない)メッセージは既読にしない
        if (targetMsg.hidden_for_recipient) return;
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
        // 「既読を送らない」設定なら、相手には知らせない(以前は画面側で隠すだけで、
        // 情報自体は相手の端末まで届いていた)
        // ブロックしている/されている相手には既読を知らせない
        if ((await getSettings(userId)).sendReadReceipts && !(await isBlockedEither(userId, targetMsg.sender_id))) {
          broadcastToUser(targetMsg.sender_id, {
            type: 'read_receipt',
            fromUserId: userId,
            msgUuid: data.msgUuid,
          });
        }
        // 受信側（既読を送った側）にも確認応答を返す
        ws.send(JSON.stringify({
          type: 'read_ack',
          msgUuid: data.msgUuid,
        }));
        return;
      }

      // --- タイピングインジケータの中継 ---
      // --- グループの「入力中」: 自分以外の今のメンバーに中継する ---
      if (data.type === 'group_typing' || data.type === 'group_typing_stop') {
        const gid = typeof data.groupId === 'string' ? data.groupId.slice(0, 100) : '';
        if (!gid) return;
        const now = Date.now();
        let g = groupTypingCache.get(gid);
        if (!g || now - g.ts > 30000) {
          const rows = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [gid]);
          g = { ts: now, members: rows.map(r => r.user_id) };
          if (groupTypingCache.size > 200) groupTypingCache.clear();
          groupTypingCache.set(gid, g);
        }
        if (!g.members.includes(userId)) return;
        if (data.type === 'group_typing' && !(await getSettings(userId)).sendTypingIndicator) return;
        const out = { type: data.type, groupId: gid, userId };
        g.members.forEach(m => { if (m !== userId) broadcastToUser(m, out); });
        return;
      }

      if (data.type === 'typing') {
        if (!(await canReach(data.recipientId))) return;
        if (!(await getSettings(userId)).sendTypingIndicator) return;
        broadcastToUser(data.recipientId, {
          type: 'typing',
          userId: userId,
        });
        return;
      }

      // --- 音声通話シグナリング (WebRTC) ---
      // サーバーは映像・音声本体には一切触れず、SDP/ICE候補の中継のみを行う。
      // callId はクライアント側(発信者)が生成し、通話1本を通して一貫して使う。
      if (data.type === 'call_offer') {
        // data: { recipientId, callId, sdp, isVideo? }
        // callIdが無い/宛先が無いofferは不正(キャンセル後の遅延送信など)。鳴らさず、タイマーも作らない
        if (!data.callId || !data.recipientId || typeof data.recipientId !== 'string') return;
        if (typeof data.callId !== 'string' || !CALL_ID_RE.test(data.callId)) return;
        if (data.recipientId === userId) return;
        // 呼び出し情報(SDP)はサーバーのメモリに45秒置くので、大きさと同時に掛けられる数を絞る
        // (以前は無制限で、1人が大量に発信するだけでメモリを使い切れた)
        const sdpSize = (() => { try { return JSON.stringify(data.sdp || '').length; } catch (_) { return Infinity; } })();
        if (sdpSize > 32000) return;

        // 他人の通話と同じcallIdを使って、その通話を上書き・横取りさせない
        const existingCall = activeCalls.get(data.callId);
        if (existingCall && existingCall.a !== userId) return;
        //
        // 友だち、または同じグループのメンバーにだけ発信できる。
        // (以前は誰でも誰にでも発信でき、知らない相手の端末をプッシュで何度でも鳴らせた。
        //  正式な友だち登録をしていないテスト用アカウント同士でも、同じグループにいれば掛けられる)
        // 断られた理由は相手に伝えず、通常の「繋がらない」と同じ見え方にする。
        if (!(await canReach(data.recipientId))) {
          // 相手にブロックされている時は、すぐ「繋がらない」にするとブロックに気づかれるので、
          // 相手がオフラインの時と同じく「呼び出し中」を出して、時間切れで「繋がらない」にする
          if (await isBlockedEither(userId, data.recipientId)) {
            ws.send(JSON.stringify({ type: 'call_waiting', callId: data.callId }));
            const t = setTimeout(() => {
              fakeCalls.delete(data.callId);
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'call_unavailable', callId: data.callId, reason: 'unreachable' }));
            }, RING_TIMEOUT_MS);
            fakeCalls.set(data.callId, t);
            return;
          }
          ws.send(JSON.stringify({ type: 'call_unavailable', callId: data.callId, reason: 'unreachable' }));
          return;
        }
        // 相手が「着信を受け取らない」設定なら、呼び出しもプッシュも出さない。
        // 断られた理由は伝えず、普通に繋がらないのと同じ見え方にする
        if ((await getSettings(data.recipientId)).allowCallsFrom === 'nobody') {
          ws.send(JSON.stringify({ type: 'call_unavailable', callId: data.callId, reason: 'unreachable' }));
          return;
        }
        // 同時に呼び出せるのは1人3本まで(ここから set までの間に await が無いので、同時に来ても数え漏れない)
        {
          let mine = 0;
          for (const pc of pendingCalls.values()) if (pc.from === userId) mine++;
          if (mine >= 3) {
            ws.send(JSON.stringify({ type: 'call_unavailable', callId: data.callId, reason: 'unreachable' }));
            return;
          }
        }
        if (!offerAllowed(userId, data.recipientId)) {
          ws.send(JSON.stringify({ type: 'call_unavailable', callId: data.callId, reason: 'unreachable' }));
          return;
        }
        rememberCall(data.callId, userId, data.recipientId);
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
          activeCalls.delete(data.callId);
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
          // WebのPush通知は通知音を指定できず、1回の音は短い。電話のように鳴り続けて聞こえるよう、
          // 相手の画面で着信が出る(call_ringing)まで4秒おきに、呼び出し時間いっぱい(最大10回)同じtagで送り直す。
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
              if (pendingCalls.get(data.callId) !== pending || pending.delivered || ++repeats > 10) {
                clearInterval(pending.repeat); pending.repeat = null;
                return;
              }
              sendRing();
            }, 4000);
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
        // 応答できるのは、その通話の着信側だけ
        const ac = typeof data.callId === 'string' ? activeCalls.get(data.callId) : null;
        if (!ac || ac.b !== userId) return;
        const answerTo = ac.a;
        ac.answered = true;
        clearPendingCall(data.callId);
        cancelRinging(userId, data.callId); // 応答した本人の他端末(APK等)の着信音を止める
        broadcastToUser(answerTo, {
          type: 'call_answer',
          callId: data.callId,
          fromUserId: userId,
          sdp: data.sdp,
        });
        return;
      }

      if (data.type === 'call_ice') {
        // data: { recipientId, callId, candidate }
        const iceTo = callPeerOf(data.callId, userId);
        if (!iceTo) return;
        const pendingIce = pendingCalls.get(data.callId);
        if (pendingIce && pendingIce.from === userId && pendingIce.ice.length < 100 && JSON.stringify(data.candidate || '').length < 2000) {
          pendingIce.ice.push(data.candidate);
        }
        broadcastToUser(iceTo, {
          type: 'call_ice',
          callId: data.callId,
          fromUserId: userId,
          candidate: data.candidate,
        });
        return;
      }

      if (data.type === 'call_reject') {
        // data: { recipientId, callId, reason? }  reason: 'declined' | 'busy'
        const rejectTo = callPeerOf(data.callId, userId);
        if (!rejectTo) return;
        broadcastToUser(rejectTo, {
          type: 'call_reject',
          callId: data.callId,
          fromUserId: userId,
          reason: data.reason === 'busy' ? 'busy' : 'declined',
        });
        clearPendingCall(data.callId);
        activeCalls.delete(data.callId);
        // 拒否した本人の他端末と、相手側に残っている着信通知を消す
        cancelRinging(userId, data.callId);
        cancelRinging(rejectTo, data.callId);
        return;
      }

      if (data.type === 'call_end') {
        // data: { recipientId, callId }
        if (typeof data.callId === 'string' && fakeCalls.has(data.callId)) {
          clearTimeout(fakeCalls.get(data.callId)); fakeCalls.delete(data.callId);
          return;
        }
        const endTo = callPeerOf(data.callId, userId);
        if (endTo) {
          broadcastToUser(endTo, {
            type: 'call_end',
            callId: data.callId,
            fromUserId: userId,
          });
          const wasRinging = clearPendingCall(data.callId);
          activeCalls.delete(data.callId);
          // 呼び出し中に発信者が切った場合など、相手の端末で鳴っている着信を止める
          // (まだ鳴っていた=応答されていないので、iPhoneにも不在着信として残す)
          cancelRinging(endTo, data.callId, wasRinging ? userId : undefined);
        }
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
          const ring = notifyAllowed('gcall:' + groupId, 60 * 1000);
          try {
            const group = await db.get('SELECT name FROM groups WHERE id = ?', [groupId]);
            const caller = await db.get('SELECT display_name FROM users WHERE id = ?', [userId]);
            const callerName = caller?.display_name || 'ユーザー';
            const groupName = group?.name || 'グループ';
            const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
            members.forEach(m => {
              if (m.user_id === userId) return;
              broadcastToUser(m.user_id, { type: 'gcall_started', groupId, groupName, byUserId: userId, byName: callerName, video: room.video });
              if (!ring) return;
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

      if (typeof data.type === 'string' && data.type.startsWith('live_')) {
        if (!userId || typeof data.groupId !== 'string' || !data.groupId) return;
        const gid = data.groupId;
        if (gid.length > 80) return;
        if (data.type === 'live_status') {
          const r = liveRooms.get(gid);
          if (!gid.startsWith('u:') && !(await isActiveGroupMember(gid, userId))) return;
          if (gid.startsWith('u:') && r && !(await liveAllowed(gid, userId, false)) && r.host !== userId) return;
          liveSend(ws, { type: 'live_status', groupId: gid, live: !!r, hostId: r ? r.host : null, hostName: r ? r.hostName : null, viewers: r ? r.viewers.size : 0, startedAt: r ? r.startedAt : null, title: r ? (r.title || '') : '' });
          return;
        }
        if (data.type === 'live_start') {
          if (!(await liveAllowed(gid, userId, true))) return;
          const cur = liveRooms.get(gid);
          if (cur && cur.host !== userId) { liveSend(ws, { type: 'live_error', groupId: gid, error: cur.hostName + 'が配信中です' }); return; }
          const me = await db.get('SELECT display_name, profile_pic FROM users WHERE id = ?', [userId]);
          const hostName = (me && me.display_name) || 'ユーザー';
          // 配信の設定(タイトル・コメント許可・fps)。つなぎ直しで送られなかった項目は前のまま
          const title = data.title !== undefined ? liveModerate(userId, liveClean(data.title, LIVE_TITLE_MAX)) : (cur ? cur.title : '');
          const comments = data.comments !== undefined ? data.comments !== false : (cur ? cur.comments : true);
          const fps = [30, 60, 120].includes(data.fps) ? data.fps : (cur ? cur.fps : 30);
          liveRooms.set(gid, {
            host: userId, hostWs: ws, hostName, hostPic: (me && me.profile_pic) || null,
            viewers: cur ? cur.viewers : new Map(), info: cur ? cur.info : new Map(), muted: cur ? cur.muted : new Set(),
            chat: cur ? cur.chat : [], lastComment: cur ? cur.lastComment : new Map(),
            title, comments, fps, startedAt: cur ? cur.startedAt : Date.now(),
          });
          liveSend(ws, { type: 'live_ready', groupId: gid });
          liveSend(ws, liveMetaMsg(gid, liveRooms.get(gid)));
          liveSend(ws, liveViewersMsg(gid, liveRooms.get(gid)));
          if (cur) { const nr = liveRooms.get(gid); nr.viewers.forEach(w => { liveSend(w, liveMetaMsg(gid, nr)); }); liveViewersBroadcast(gid); }
          // 配信者がつなぎ直した時は、見ている人へ送り直す
          if (cur) cur.viewers.forEach((w, vid) => liveSend(ws, { type: 'live_viewer', groupId: gid, userId: vid }));
          const ringLive = !cur && notifyAllowed('live:' + gid, 5 * 60 * 1000);
          if (!cur && gid.startsWith('u:')) {
            try {
              (await liveFriends(userId)).forEach(id => {
                broadcastToUser(id, { type: 'live_started', groupId: gid, hostId: userId, hostName, feed: true, title: liveRooms.get(gid).title || '' });
                if (!ringLive) return;
                require('../utils/fcm').sendMessageNotification(id, hostName, liveRooms.get(gid).title || 'ライブ配信を始めました', 'system', { senderId: userId, chatId: '' }).catch(() => {});
              });
            } catch (e) { console.error('[live] notify failed:', e.message); }
          } else if (!cur) {
            try {
              const group = await db.get('SELECT name FROM groups WHERE id = ?', [gid]);
              const groupName = (group && group.name) || 'グループ';
              const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [gid]);
              members.forEach(m => {
                if (m.user_id === userId) return;
                broadcastToUser(m.user_id, { type: 'live_started', groupId: gid, groupName, hostId: userId, hostName, title: liveRooms.get(gid).title || '' });
                if (!ringLive) return;
                require('../utils/fcm').sendMessageNotification(
                  m.user_id, `${hostName} (${groupName})`, 'ライブ配信を始めました', 'group', { senderId: userId, chatId: gid }
                ).catch(() => {});
                if (!isUserOnline(m.user_id)) {
                  sendPushToUser(m.user_id, { type: 'new_group_message', groupId: gid, groupName, senderName: hostName, preview: 'ライブ配信を始めました' }).catch(() => {});
                }
              });
            } catch (e) { console.error('[live] notify failed:', e.message); }
          }
          return;
        }
        const r = liveRooms.get(gid);
        if (!r) { if (data.type === 'live_join') liveSend(ws, { type: 'live_ended', groupId: gid }); return; }
        if (data.type === 'live_join') {
          if (userId === r.host) return;
          if (!(await liveAllowed(gid, userId, false))) return;
          if (!r.viewers.has(userId) && r.viewers.size >= LIVE_MAX_VIEWERS) { liveSend(ws, { type: 'live_error', groupId: gid, error: '満員です(最大' + LIVE_MAX_VIEWERS + '人)' }); return; }
          const vu = await db.get('SELECT display_name, profile_pic FROM users WHERE id = ?', [userId]);
          if (liveRooms.get(gid) !== r) return; // 待っている間に配信が終わった
          if (!r.viewers.has(userId) && r.viewers.size >= LIVE_MAX_VIEWERS) { liveSend(ws, { type: 'live_error', groupId: gid, error: '満員です(最大' + LIVE_MAX_VIEWERS + '人)' }); return; }
          r.viewers.set(userId, ws);
          r.info.set(userId, { name: (vu && vu.display_name) || 'ユーザー', pic: (vu && vu.profile_pic) || null });
          liveSend(r.hostWs, { type: 'live_viewer', groupId: gid, userId });
          liveSend(ws, liveMetaMsg(gid, r));
          // 入った人に、直近のコメントを送る(ブロック関係の人のコメントは除く)
          if (r.chat.length) {
            const blocks = await liveBlockSet(userId);
            liveSend(ws, { type: 'live_chat', groupId: gid, items: r.chat.filter(c => !blocks.has(c.userId)) });
          }
          liveCount(gid);
          return;
        }
        if (data.type === 'live_comment') {
          const isHost = userId === r.host && r.hostWs === ws;
          if (!isHost && r.viewers.get(userId) !== ws) return;
          const text = liveModerate(userId, liveClean(data.text, LIVE_COMMENT_MAX));
          if (!text) return;
          if (r.comments === false && !isHost) { liveSend(ws, { type: 'live_comment_rejected', groupId: gid, reason: 'off' }); return; }
          if (!isHost && r.muted.has(userId)) { liveSend(ws, { type: 'live_comment_rejected', groupId: gid, reason: 'muted' }); return; }
          const now = Date.now();
          if (now - (r.lastComment.get(userId) || 0) < LIVE_COMMENT_GAP_MS) { liveSend(ws, { type: 'live_comment_rejected', groupId: gid, reason: 'rate' }); return; }
          r.lastComment.set(userId, now);
          const who = isHost ? { name: r.hostName, pic: r.hostPic } : (r.info.get(userId) || {});
          const c = { id: uuidv4(), userId, name: who.name || 'ユーザー', pic: who.pic || null, text, at: now, host: isHost };
          r.chat.push(c); if (r.chat.length > LIVE_CHAT_KEEP) r.chat.shift();
          const blocks = await liveBlockSet(userId); // 送った人とブロック関係の人には届けない
          const out = { type: 'live_comment', groupId: gid, comment: c };
          if (!blocks.has(r.host)) liveSend(r.hostWs, out); else liveSend(ws, out);
          r.viewers.forEach((w, id) => { if (!blocks.has(id) || id === userId) liveSend(w, out); });
          return;
        }
        // 以下は配信者だけ
        if (['live_settings', 'live_mute', 'live_comment_delete', 'live_kick'].includes(data.type)) {
          if (!(userId === r.host && r.hostWs === ws)) return;
          if (data.type === 'live_settings') {
            if (data.title !== undefined) r.title = liveModerate(userId, liveClean(data.title, LIVE_TITLE_MAX));
            if (data.comments !== undefined) r.comments = data.comments !== false;
            const m = liveMetaMsg(gid, r);
            liveSend(r.hostWs, m); r.viewers.forEach(w => liveSend(w, m));
          } else if (data.type === 'live_mute') {
            if (typeof data.userId !== 'string' || !r.viewers.has(data.userId)) return;
            if (data.on === false) r.muted.delete(data.userId); else r.muted.add(data.userId);
            liveViewersBroadcast(gid);
          } else if (data.type === 'live_comment_delete') {
            const i = r.chat.findIndex(c => c.id === data.id);
            if (i < 0) return;
            r.chat.splice(i, 1);
            const m = { type: 'live_comment_deleted', groupId: gid, id: data.id };
            liveSend(r.hostWs, m); r.viewers.forEach(w => liveSend(w, m));
          } else if (data.type === 'live_kick') {
            const w = r.viewers.get(data.userId);
            if (!w) return;
            liveSend(w, { type: 'live_ended', groupId: gid }); leaveLive(gid, data.userId, w);
          }
          return;
        }
        if (data.type === 'live_signal') {
          // 配信者 ⇔ 見ている人 の間だけ中継する
          if (!['offer', 'answer', 'ice'].includes(data.kind) || typeof data.to !== 'string') return;
          const fromHost = userId === r.host && r.hostWs === ws;
          const fromViewer = r.viewers.get(userId) === ws;
          let target = null;
          if (fromHost) target = r.viewers.get(data.to);
          else if (fromViewer && data.to === r.host) target = r.hostWs;
          if (!target) return;
          let size = 0; try { size = JSON.stringify(data.sdp || data.candidate || '').length; } catch (_) { return; }
          if (size > 32000) return;
          liveSend(target, { type: 'live_signal', groupId: gid, from: userId, kind: data.kind, sdp: data.sdp, candidate: data.candidate });
          return;
        }
        if (data.type === 'live_leave' || data.type === 'live_end') { leaveLive(gid, userId, ws); return; }
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
        // 字幕(Deepgram、従量課金)は、実際に参加している通話の間だけ使える。
        // 以前は通話と無関係にいつでも開始でき、音声を流し続けて課金を膨らませられた。
        if (!isCallAnswered(data.callId, userId)) {
          ws.send(JSON.stringify({ type: 'call_assist_error', error: '通話中のみ利用できます', track: data.track }));
          return;
        }
        const track = data.track === 'remote' ? 'remote' : 'mic';
        if (callAssistSessions[track]) {
          callAssist.stopSession(callAssistSessions[track]);
        }
        const lang = typeof data.language === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(data.language) ? data.language : 'ja';
        const sessionId = `${userId}:${data.callId}:${track}:${Date.now()}`;
        callAssistSessions[track] = sessionId;
        callAssistCallIds[track] = data.callId;
        callAssist.startSession(sessionId, {
          owner: userId,
          language: lang,
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
    };
    // 例外が外に漏れるとプロセスごと落ちる(未処理のPromise rejection)ため必ずここで握る
    ws.on('message', (raw, isBinary) => {
      handleWsMessage(raw, isBinary).catch(e => console.error('[ws] メッセージ処理エラー:', e && e.message));
    });

    ws.on('close', () => {
      if (userId) groupCalls.forEach((room, gid) => { if (room.peers.get(userId) === ws) leaveGroupCall(gid, userId, ws); });
      if (userId) liveRooms.forEach((r, gid) => { if (r.hostWs === ws || r.viewers.get(userId) === ws) leaveLive(gid, userId, ws); });
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
          announceOffline(userId); // 相手に「オフラインになった」ことを通知(すぐ繋ぎ直した時は送らない)
        }
      }
    });
  });

  console.log('[ws] WebSocketServer 起動 (path: /ws)');
  return wss;
}

// 禁止語で利用停止になった人の接続に知らせてから切る(停止画面を出させる)
function disconnectBanned(userId, until) {
  const set = connections.get(userId);
  if (!set) return;
  const msg = JSON.stringify({ type: 'banned', bannedUntil: until });
  for (const ws of [...set]) {
    try { ws.send(msg); } catch (e) {}
    setTimeout(() => { try { ws.close(4003, 'banned'); } catch (e) {} }, 300);
  }
}

function forgetPresenceContacts(userId) { contactCache.delete(userId); }

module.exports = { forgetPresenceContacts, initWebSocketServer, broadcastToUser, isUserOnline, onlineUsers, kickFromGroupCall, kickFromLive, listFeedLives, rejectPendingCall, disconnectBanned };
