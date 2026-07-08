// storage/ttlStorageManager.js
// TTLStorageManager: 7日を過ぎた画像・動画をディスク(本番はS3)とDBから自動削除
const cron = require('node-cron');
const db = require('../db/db');
const storage = require('./storage');

function cleanupExpiredMedia() {
  const now = new Date().toISOString();
  const expired = db.all('SELECT id FROM media_files WHERE expires_at < ?', [now]);

  if (expired.length === 0) return;

  expired.forEach(row => {
    storage.deleteFinal(row.id);
    db.run('DELETE FROM media_files WHERE id = ?', [row.id]);
  });

  console.log(`[TTLStorageManager] 期限切れメディアを ${expired.length} 件削除しました (${now})`);
}

function startTTLCleanupJob() {
  // 毎時0分に実行 (本番はこれで十分な頻度)
  cron.schedule('0 * * * *', cleanupExpiredMedia);
  // 起動直後にも1回実行しておく
  cleanupExpiredMedia();
  console.log('[TTLStorageManager] 起動しました (毎時チェック、TTL=7日)');
}

module.exports = { startTTLCleanupJob, cleanupExpiredMedia };
