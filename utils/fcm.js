// utils/fcm.js — Firebase Cloud Messaging プッシュ通知送信
const admin = require('firebase-admin');
const db = require('../db/db');

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
async function saveToken(userId, fcmToken) {
  // FCMトークンは「端末(アプリ)」に1つ。同じ端末で別のアカウントにログインし直したとき、
  // 前のアカウントの行を残すと、そのアカウント宛ての着信・通知がこの端末にも届いてしまう
  // (Aで発信するとBに着信するはずが、同じ端末で以前Bにログインしていたせいで自分の端末が鳴る)。
  // 最後に登録したアカウントだけがこのトークンを持つようにする。
  await db.run('DELETE FROM fcm_tokens WHERE token = ? AND user_id <> ?', [fcmToken, userId]);
  await db.run(
    `INSERT INTO fcm_tokens (user_id, token, updated_at) VALUES (?, ?, now())
     ON CONFLICT (user_id, token) DO UPDATE SET updated_at = now()`,
    [userId, fcmToken]
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

async function getTokens(userId) {
  const rows = await db.all(
    'SELECT token FROM fcm_tokens WHERE user_id = ? ORDER BY updated_at DESC LIMIT 5',
    [userId]
  );
  return rows.map(r => r.token);
}

/**
 * 着信プッシュ通知を送信
 */
async function sendCallNotification(recipientId, callerId, callerName, callerAvatar, callId, isVideo = false) {
  if (!initialized) { initFirebase(); }
  if (!initialized) return;

  let tokens = await getTokens(recipientId);
  // 発信者自身の端末(同じトークンが発信者の行にも残っている場合)は鳴らさない
  if (callerId && tokens.length) {
    const own = new Set(await getTokens(callerId));
    tokens = tokens.filter(t => !own.has(t));
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

  const tokens = await getTokens(recipientId);
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
async function sendMessageNotification(recipientId, senderName, content, chatType, extra = {}) {
  if (!initialized) { initFirebase(); }
  if (!initialized) return;

  const tokens = await getTokens(recipientId);
  if (tokens.length === 0) return;

  // メッセージ本文を短縮
  let body = content || '';
  if (body.length > 100) body = body.substring(0, 100) + '...';
  if (body.startsWith('data:')) body = '画像を送信しました';

  const message = {
    data: {
      type: 'message',
      sender_name: senderName || '不明',
      content: body,
      chat_type: chatType || 'dm',
      sender_id: String(extra.senderId || ''),
      chat_id: String(extra.chatId || ''),
      cipher: String(extra.cipher || ''),
      sender_pub: String(extra.senderPub || ''),
    },
    // data専用メッセージにする。notification を付けるとアプリが裏にいる時にOSが勝手に表示し、
    // 「そのトークを開いている時は出さない」「タップでそのトークを開く」がネイティブ側で出来なかった
    android: { priority: 'high', ttl: 24 * 3600 * 1000 },
  };

  await sendToTokens(tokens, message, recipientId);
}

/**
 * 複数トークンに送信、無効なトークンは削除
 */
async function sendToTokens(tokens, messageTemplate, userId) {
  for (const token of tokens) {
    try {
      const msg = { ...messageTemplate, token };
      await admin.messaging().send(msg);
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

module.exports = { initFirebase, saveToken, removeToken, getTokens, sendCallNotification, sendCallCancelled, sendMessageNotification };
