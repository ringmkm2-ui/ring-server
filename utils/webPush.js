// utils/webPush.js
// -----------------------------------------------------------------------
// VAPID Web Push 送信ヘルパー。
// ユーザーの全登録デバイス(purchase_subscriptions)にPush通知を送信する。
// 無効化された購読(410 Gone / 404)は自動でDBから削除する。
// -----------------------------------------------------------------------
const webpush = require('web-push');
const db = require('../db/db');

// 公開鍵は公開前提の値。秘密鍵はコードに置かず、必ず環境変数 VAPID_PRIVATE_KEY で渡す。
// (以前はここに秘密鍵が直書きされていた。履歴に残っているので、漏れた前提で扱うこと)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BC8atUOdT4fxJm4LYrZ-vW1uH56_ZjQjkcGKD8rvnDPZXQY3fdLlMN2Bf_n__b-sMbABxoo1mDNqzJVYsG5ZP9k';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@ring-server.example.com';

const PUSH_ENABLED = !!VAPID_PRIVATE_KEY;
if (PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
} else {
  console.warn('[webPush] VAPID_PRIVATE_KEY が未設定のため、Web Push通知は無効です');
}

/**
 * 指定ユーザーの全デバイスにPush通知を送信する。
 * @param {string} userId 送信先ユーザーID
 * @param {object} payload 通知データ (JSON.stringifyしてSWのpushイベントに渡る)
 * @returns {Promise<number>} 送信成功件数
 */
// options: { ttl, urgency } を渡せる。
// 通話着信は TTL:30(30秒で破棄)、テキスト通知はデフォルト TTL:86400(1日)。
async function sendPushToUser(userId, payload, options = {}) {
  if (!PUSH_ENABLED) return 0;
  let subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  if (!subs || subs.length === 0) return 0;
  // iPhone(Safari)は「通知を出さないプッシュ」を繰り返すと購読を取り消すため、
  // 着信を消すだけの静かなプッシュはApple宛てには送らない
  if (options.skipApple) subs = subs.filter(sb => !String(sb.endpoint).includes('push.apple.com'));
  if (subs.length === 0) return 0;

  const payloadStr = JSON.stringify(payload);
  let successCount = 0;

  await Promise.all(subs.map(async (sub) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    try {
      await webpush.sendNotification(pushSubscription, payloadStr, {
        urgency: options.urgency || 'high',
        TTL: options.ttl !== undefined ? options.ttl : 86400,
      });
      successCount++;
    } catch (err) {
      // 410 Gone / 404 Not Found → 購読が無効化されている（ブラウザ側で解除済み等）
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.run('DELETE FROM push_subscriptions WHERE endpoint = ?', [sub.endpoint]).catch(() => {});
        console.log(`[webpush] Removed stale subscription for user ${userId}`);
      } else {
        console.error(`[webpush] Send failed for user ${userId}:`, err.statusCode, err.message);
      }
    }
  }));

  return successCount;
}

module.exports = { sendPushToUser, VAPID_PUBLIC_KEY };
