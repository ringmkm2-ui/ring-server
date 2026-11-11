// utils/fcm.js — Firebase Cloud Messaging プッシュ通知送信
const admin = require('firebase-admin');
const db = require('../db/db');
const fcmCrypto = require('./fcmCrypto');

let initialized = false;

// 環境変数の中身を寛容に読む。Base64でも生JSONでもよく、貼り付け時に後ろへ
// ゴミ(二重貼り付け・古い値の残り等)が付いていても、先頭の完全なJSONだけを使う。
function parseServiceAccount(raw) {
  const text = raw.trim();
  const candidates = [text];
  try { candidates.push(Buffer.from(text, 'base64').toString('utf8').trim()); } catch {}
  for (const c of candidates) {
    try { return JSON.parse(c); } catch {}
    const start = c.indexOf('{');
    if (start < 0) continue;
    for (let i = c.indexOf('}', start); i >= 0; i = c.indexOf('}', i + 1)) {
      try {
        const obj = JSON.parse(c.slice(start, i + 1));
        if (obj && obj.private_key && obj.client_email) {
          if (i + 1 < c.trim().length) console.warn('[FCM] FIREBASE_SERVICE_ACCOUNT の末尾に余計な文字があったので無視しました');
          return obj;
        }
      } catch {}
    }
  }
  throw new Error('FIREBASE_SERVICE_ACCOUNT をJSONとして読めません');
}

function initFirebase() {
  if (initialized) return;
  
  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credJson) {
    console.log('[FCM] FIREBASE_SERVICE_ACCOUNT not set, push disabled');
    return;
  }

  try {
    const credential = parseServiceAccount(credJson);

    admin.initializeApp({
      credential: admin.credential.cert(credential)
    });
    initialized = true;
    console.log('[FCM] Firebase initialized for project:', credential.project_id);
  } catch (e) {
    console.error('[FCM] Firebase init failed:', e.message);
  }
}

/**
 * ユーザーのFCMトークンを保存/更新
 */
// pushKey: 新しいAPKが作った端末ごとの暗号鍵(Base64 32バイト)。あればFCMの中身をこの鍵で暗号化して送る。
// 渡されなかった時は、既に保存してある鍵を消さない。Web側(talklist.html)の古い登録経路はトークンだけを
// 送ってくるので、ここで NULL に戻すと、新しいAPKでも平文に戻ってしまうため。
async function saveToken(userId, fcmToken, pushKey = null) {
  if (pushKey != null && !fcmCrypto.isValidPushKey(pushKey)) throw new Error('invalid push key');
  // FCMトークンは「端末(アプリ)」に1つ。同じ端末で別のアカウントにログインし直したとき、
  // 前のアカウントの行を残すと、そのアカウント宛ての着信・通知がこの端末にも届いてしまう
  // (Aで発信するとBに着信するはずが、同じ端末で以前Bにログインしていたせいで自分の端末が鳴る)。
  // 最後に登録したアカウントだけがこのトークンを持つようにする。
  await db.run('DELETE FROM fcm_tokens WHERE token = ? AND user_id <> ?', [fcmToken, userId]);
  await db.run(
    `INSERT INTO fcm_tokens (user_id, token, push_key, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id, token) DO UPDATE SET updated_at = CURRENT_TIMESTAMP,
       push_key = COALESCE(excluded.push_key, fcm_tokens.push_key)`,
    [userId, fcmToken, pushKey || null]
  );
  // 1人あたり新しい方から10台分まで
  await db.run(
    'DELETE FROM fcm_tokens WHERE user_id = ? AND token NOT IN (SELECT token FROM fcm_tokens WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10)',
    [userId, userId]
  );
}

/**
 * ユーザーのFCMトークン一覧を取得
 */
// この端末(トークン)を、そのユーザーから外す。ログアウト時に使う
async function removeToken(userId, fcmToken) {
  if (!fcmToken) return;
  await db.run('DELETE FROM fcm_tokens WHERE user_id = ? AND token = ?', [userId, fcmToken]);
}

// [{ token, push_key }] 新しい順に5台まで。push_key が無い行は古いAPK(平文で送る)
async function getTokenRows(userId) {
  return db.all(
    'SELECT token, push_key FROM fcm_tokens WHERE user_id = ? ORDER BY updated_at DESC LIMIT 5',
    [userId]
  );
}

async function getTokens(userId) {
  return (await getTokenRows(userId)).map(r => r.token);
}

/**
 * 着信プッシュ通知を送信
 */
async function sendCallNotification(recipientId, callerId, callerName, callerAvatar, callId, isVideo = false) {
  if (!initialized) { initFirebase(); }
  if (!initialized) return;

  let tokens = await getTokenRows(recipientId);
  // 発信者自身の端末(同じトークンが発信者の行にも残っている場合)は鳴らさない
  if (callerId && tokens.length) {
    const own = new Set(await getTokens(callerId));
    tokens = tokens.filter(t => !own.has(t.token));
  }
  if (tokens.length === 0) {
    console.log('[FCM] No tokens for user:', recipientId);
    return;
  }

  const message = {
    data: {
      type: 'incoming_call',
      call_id: callId || '',
      caller_name: callerName || '不明',
      // プロフィール画像がdata:URL(Base64)だとFCMの上限4KBを超えて着信プッシュ自体が送れなかった。
      // ネイティブ側は画像を使っていないので、短いURLの時だけ載せる
      caller_avatar: (callerAvatar && !String(callerAvatar).startsWith('data:') && String(callerAvatar).length < 512) ? callerAvatar : '',
      caller_id: callerId || '',
      is_video: isVideo ? '1' : '0',
    },
    android: {
      priority: 'high',
      ttl: 30000, // 30秒で期限切れ
    },
  };

  await sendToTokens(tokens, message, recipientId);
}

/**
 * 通話キャンセル通知
 */
async function sendCallCancelled(recipientId, callId) {
  if (!initialized) { initFirebase(); }
  if (!initialized) return;

  const tokens = await getTokenRows(recipientId);
  if (tokens.length === 0) return;

  const message = {
    data: {
      type: 'call_cancelled',
      call_id: callId || '',
    },
    android: { priority: 'high' },
  };

  await sendToTokens(tokens, message, recipientId);
}

/**
 * メッセージ通知を送信
 */
// extra.containsMessage: true のとき、受信者の「通知に本文を出さない」設定を見て、
// 有効なら本文・暗号文・公開鍵を落として汎用の文言にする(送信者名は残す)。
// 組み立ては buildMessageData に分けてある(設定ごとの出力をテストで確かめるため)。
function buildMessageData(senderName, content, chatType, extra = {}, hide = false) {
  if (hide) ({ content, extra } = require('./notifyPrivacy').privatizeFcmArgs(content, extra));
  // メッセージ本文を短縮
  let body = content || '';
  if (body.length > 100) body = body.substring(0, 100) + '...';
  if (body.startsWith('data:')) body = '画像を送信しました';
  return {
    type: 'message',
    sender_name: senderName || '不明',
    content: body,
    chat_type: chatType || 'dm',
    sender_id: String(extra.senderId || ''),
    chat_id: String(extra.chatId || ''),
    cipher: String(extra.cipher || ''),
    sender_pub: String(extra.senderPub || ''),
    sender_avatar: String(extra.senderPic || ''),
  };
}

async function sendMessageNotification(recipientId, senderName, content, chatType, extra = {}) {
  if (!initialized) { initFirebase(); }
  if (!initialized) return;

  const tokens = await getTokenRows(recipientId);
  if (tokens.length === 0) return;

  const hide = extra.containsMessage ? await require('./notifyPrivacy').shouldHideBody(recipientId) : false;
  const message = {
    data: buildMessageData(senderName, content, chatType, extra, hide),
    // data専用メッセージにする。notification を付けるとアプリが裏にいる時にOSが勝手に表示し、
    // 「そのトークを開いている時は出さない」「タップでそのトークを開く」がネイティブ側で出来なかった
    android: { priority: 'high', ttl: 24 * 3600 * 1000 },
  };

  await sendToTokens(tokens, message, recipientId);
}

/**
 * 1台分の送信内容を作る。鍵のある端末には data を暗号化した {v,n,c} だけを載せ、
 * 優先度・TTL などの android 側の指定はそのまま使う(着信の高優先度を落とさない)。
 * 鍵の無い(古いAPKの)端末には今まで通り平文の data を送る。
 */
function buildMessageForToken(messageTemplate, row) {
  const token = typeof row === 'string' ? row : row.token;
  const key = typeof row === 'string' ? null : row.push_key;
  const msg = { ...messageTemplate, token };
  if (key && fcmCrypto.isValidPushKey(key)) msg.data = fcmCrypto.sealDataFitting(messageTemplate.data || {}, key);
  return msg;
}

// テストで送信を差し替えるための口(firebase-admin の messaging() は書き換えられないため)
let sender = msg => admin.messaging().send(msg);
function _setSenderForTest(fn) { sender = fn; initialized = true; }

/**
 * 複数トークンに送信、無効なトークンは削除
 */
async function sendToTokens(tokens, messageTemplate, userId) {
  for (const row of tokens) {
    const token = typeof row === 'string' ? row : row.token;
    try {
      const msg = buildMessageForToken(messageTemplate, row);
      await sender(msg);
      console.log('[FCM] Sent to', userId, '(token:', token.substring(0, 20) + '...)');
    } catch (e) {
      if (e.code === 'messaging/registration-token-not-registered' ||
          e.code === 'messaging/invalid-registration-token') {
        // 無効なトークンを削除
        await db.run('DELETE FROM fcm_tokens WHERE user_id = ? AND token = ?', [userId, token]);
        console.log('[FCM] Removed invalid token for', userId);
      } else {
        // codeだけだと原因が分からない(invalid-credentialの中身が鍵の失効なのか形式ミスなのか等)ので本文も出す
        console.error('[FCM] Send error:', e.code, '-', e.message);
      }
    }
  }
}

// 起動時に初期化
initFirebase();

module.exports = { buildMessageData, buildMessageForToken, initFirebase, saveToken, removeToken, getTokens, getTokenRows, sendCallNotification, sendCallCancelled, sendMessageNotification, _setSenderForTest };
