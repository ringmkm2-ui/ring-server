// utils/fcm.js — Firebase Cloud Messaging プッシュ通知送信
const admin = require('firebase-admin');
const db = require('../db/db');

let initialized = false;

function initFirebase() {
  if (initialized) return;
  
  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!credJson) {
    console.log('[FCM] FIREBASE_SERVICE_ACCOUNT not set, push disabled');
    return;
  }

  try {
    let credential;
    // Base64エンコードされたJSON or 生JSON
    try {
      credential = JSON.parse(Buffer.from(credJson, 'base64').toString('utf8'));
    } catch {
      credential = JSON.parse(credJson);
    }

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
  await db.run(
    `INSERT INTO fcm_tokens (user_id, token, updated_at) VALUES (?, ?, now())
     ON CONFLICT (user_id, token) DO UPDATE SET updated_at = now()`,
    [userId, fcmToken]
  );
}

/**
 * ユーザーのFCMトークン一覧を取得
 */
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
async function sendCallNotification(recipientId, callerId, callerName, callerAvatar, callId) {
  if (!initialized) { initFirebase(); }
  if (!initialized) return;

  const tokens = await getTokens(recipientId);
  if (tokens.length === 0) {
    console.log('[FCM] No tokens for user:', recipientId);
    return;
  }

  const message = {
    data: {
      type: 'incoming_call',
      call_id: callId || '',
      caller_name: callerName || '不明',
      caller_avatar: callerAvatar || '',
      caller_id: callerId || '',
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
async function sendMessageNotification(recipientId, senderName, content, chatType) {
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
    },
    notification: {
      title: senderName || '新しいメッセージ',
      body: body,
    },
    android: {
      priority: 'high',
      notification: {
        channelId: 'brochat_messages',
        sound: 'default',
      },
    },
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
        console.error('[FCM] Send error:', e.code || e.message);
      }
    }
  }
}

// 起動時に初期化
initFirebase();

module.exports = { initFirebase, saveToken, getTokens, sendCallNotification, sendCallCancelled, sendMessageNotification };
