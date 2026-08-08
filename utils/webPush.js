// utils/webPush.js
// -----------------------------------------------------------------------
// VAPID Web Push 送信ヘルパー。
// ユーザーの全登録デバイス(purchase_subscriptions)にPush通知を送信する。
// 無効化された購読(410 Gone / 404)は自動でDBから削除する。
// -----------------------------------------------------------------------
const webpush = require('web-push');
const db = require('../db/db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BC8atUOdT4fxJm4LYrZ-vW1uH56_ZjQjkcGKD8rvnDPZXQY3fdLlMN2Bf_n__b-sMbABxoo1mDNqzJVYsG5ZP9k';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'Q41fiN6CXN2BTzFh5lb5YkahLD2bqv1-xCUOtxVZnxs';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@ring-server.example.com';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/**
 * 指定ユーザーの全デバイスにPush通知を送信する。
 * @param {string} userId 送信先ユーザーID
 * @param {object} payload 通知データ (JSON.stringifyしてSWのpushイベントに渡る)
 * @returns {Promise<number>} 送信成功件数
 */
async function sendPushToUser(userId, payload) {
  const subs = await db.all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  if (!subs || subs.length === 0) return 0;

  const payloadStr = JSON.stringify(payload);
  let successCount = 0;

  await Promise.all(subs.map(async (sub) => {
    const pushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth }
    };
    try {
      await webpush.sendNotification(pushSubscription, payloadStr, {
        urgency: 'high', // 着信は最優先で即座に配送させる
        TTL: 30 // 30秒以内に配送できなければ破棄（通話の即時性のため）
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
