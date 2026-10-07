// utils/adminNotify.js
// バグ報告・ユーザー通報が届いた時に、運営(Ring)のスマホ(APK)とブラウザへ通知を飛ばす。
// 送り先は環境変数 ADMIN_NOTIFY で指定する(カンマ区切りで、Bro Chatのメールアドレス か IDコード U...)。
// 未設定なら ringmkm2@gmail.com のアカウントへ送る。
const db = require('../db/db');

const DEFAULT_ADMINS = 'ringmkm2@gmail.com';

async function adminUserIds(envName = 'ADMIN_NOTIFY', fallback = DEFAULT_ADMINS) {
  const list = String(process.env[envName] || fallback)
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);
  if (!list.length) return [];
  const ph = list.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT id FROM users WHERE (LOWER(username) IN (${ph}) OR user_id IN (${ph})) AND username NOT LIKE 'deleted%'`,
    [...list.map(s => s.toLowerCase()), ...list.map(s => s.toUpperCase())]
  );
  return [...new Set(rows.map(r => r.id))];
}

const CATEGORY_JA = { spam: 'スパム', harassment: '嫌がらせ', impersonation: 'なりすまし', inappropriate: '不適切', other: 'その他' };

// report: { kind: 'bug'|'user', message, category?, reporterName, targetName? }
async function notifyAdminsOfReport(report) {
  let ids;
  try { ids = await adminUserIds(); } catch (e) { console.error('[adminNotify] lookup failed:', e.message); return; }
  if (!ids.length) { console.warn('[adminNotify] 通知先の運営アカウントが見つかりません(ADMIN_NOTIFY を確認)'); return; }

  const title = report.kind === 'bug' ? 'バグ報告が届きました' : '通報が届きました';
  const who = String(report.reporterName || 'ユーザー').slice(0, 30);
  const msg = String(report.message || '').replace(/\s+/g, ' ').slice(0, 80);
  const body = report.kind === 'bug'
    ? `${who}: ${msg}`
    : `${who} → ${String(report.targetName || '不明').slice(0, 30)}(${CATEGORY_JA[report.category] || 'その他'}): ${msg}`;

  for (const uid of ids) {
    // APK(FCM)。今のアプリのままで出せるよう、メッセージ通知の形で送る(送った人の欄は空=タップでアプリが開く)
    try {
      require('./fcm').sendMessageNotification(uid, 'Bro Chat ' + title, body, 'system', { senderId: '', chatId: 'reports' })
        .catch(e => console.error('[adminNotify] fcm:', e.message));
    } catch (e) {}
    // ブラウザ / デスクトップ(Web Push)
    try {
      require('./webPush').sendPushToUser(uid, { type: 'admin_report', title, body }, { ttl: 24 * 3600 })
        .catch(e => console.error('[adminNotify] push:', e.message));
    } catch (e) {}
  }
}

module.exports = { adminUserIds, notifyAdminsOfReport };
