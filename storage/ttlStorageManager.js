// storage/ttlStorageManager.js
// TTLStorageManager: 7日を過ぎた画像・動画をディスク(本番はS3)とDBから自動削除
const cron = require('node-cron');
const db = require('../db/db');
const storage = require('./storage');

function cleanupExpiredMedia() {
  (async () => {
    const now = new Date().toISOString();
    const expired = await db.all('SELECT id FROM media_files WHERE expires_at < ?', [now]);

    if (!expired || expired.length === 0) return;

    for (const row of expired) {
      storage.deleteFinal(row.id);
      await db.run('DELETE FROM media_files WHERE id = ?', [row.id]);
    }

    console.log(`[TTLStorageManager] 期限切れメディアを ${expired.length} 件削除しました (${now})`);
  })().catch(err => console.error('[TTLStorageManager] エラー:', err.message));
}

function startTTLCleanupJob() {
  // 毎時0分に実行
  cron.schedule('0 * * * *', cleanupExpiredMedia);
  // 起動直後にも1回実行
  cleanupExpiredMedia();
  console.log('[TTLStorageManager] 起動しました (毎時チェック、TTL=7日)');
}

module.exports = { startTTLCleanupJob, cleanupExpiredMedia };
