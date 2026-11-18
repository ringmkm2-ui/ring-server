// utils/callAssistQuota.js
// 字幕(Deepgram、音声の秒数で従量課金)の1日の上限。再起動で消えないようDBに記録する。
// 通話に見せかけた2アカウントで音声を流し続ければ、課金をいくらでも増やせたため。
// 数えるのは実際にDeepgramへ送った音声の秒数。自分の声と相手の声の字幕を同時に出すと、課金どおり2本分になる。
const db = require('../db/db');

const DEFAULT_MINUTES = 60;

function dailyLimitSeconds() {
  const raw = process.env.CALL_ASSIST_DAILY_MINUTES;
  const v = Number(raw);
  return (raw && Number.isFinite(v) && v >= 0 ? v : DEFAULT_MINUTES) * 60;
}

// 利用者は日本にいるので、日本時間で日付を切り替える
const dayKey = (now = Date.now()) => new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10);

async function usedSeconds(userId) {
  const r = await db.get('SELECT seconds FROM call_assist_usage WHERE user_id = ? AND day = ?', [userId, dayKey()]);
  return r ? Number(r.seconds) : 0;
}

// 足した後の合計を返す
async function addSeconds(userId, seconds) {
  await db.run(
    `INSERT INTO call_assist_usage (user_id, day, seconds) VALUES (?, ?, ?)
     ON CONFLICT(user_id, day) DO UPDATE SET seconds = call_assist_usage.seconds + excluded.seconds`,
    [userId, dayKey(), seconds]
  );
  return usedSeconds(userId);
}

module.exports = { dailyLimitSeconds, usedSeconds, addSeconds };
