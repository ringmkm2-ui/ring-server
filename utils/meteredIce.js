// utils/meteredIce.js
// -----------------------------------------------------------------------
// Metered.ca TURN サーバー統合
// -----------------------------------------------------------------------
// Metered はアカウントごとに専用ドメイン <appname>.metered.live を発行する。
// TURN認証情報(ICEサーバー配列)は以下のエンドポイントから取得する:
//   GET https://<appname>.metered.live/api/v1/turn/credentials?apiKey=<API_KEY>
// このエンドポイントは iceServers 配列を「直接」返す(ラッパー無し)。
//
// 必要な環境変数:
//   METERED_APP_NAME : 専用ドメインのサブドメイン部分(例: brochat.metered.live なら "brochat")
//                      フルドメイン "brochat.metered.live" を入れても動くよう吸収する。
//   METERED_API_KEY  : credential の API Key
//                      (旧名 METERED_SECRET_KEY でも動くよう後方互換で読む)
//
// STUNは無料無制限だが、対称型NAT/CGNAT/国際通話ではTURN中継が必須。
// 設定が無い場合はSTUNのみにフォールバックする(=国際通話は繋がらない)。
// -----------------------------------------------------------------------
const https = require('https');

const RAW_APP = (process.env.METERED_APP_NAME || '').trim();
const METERED_API_KEY = (process.env.METERED_API_KEY || process.env.METERED_SECRET_KEY || '').trim();

// "brochat" でも "brochat.metered.live" でも "https://brochat.metered.live/" でも
// 受け取れるように、サブドメイン部分だけを抽出する。
function normalizeAppName(v) {
  if (!v) return '';
  let s = v.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  s = s.replace(/\.metered\.live$/i, '');
  return s;
}
const METERED_APP_NAME = normalizeAppName(RAW_APP);

const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

function isMeteredConfigured() {
  return !!(METERED_APP_NAME && METERED_API_KEY);
}

/**
 * Metered から一時的なICEサーバー一覧(STUN+TURN)を取得する。
 * 失敗した場合は FALLBACK_ICE_SERVERS (STUNのみ) を返す。
 */
function fetchMeteredIceServers() {
  return new Promise((resolve) => {
    if (!isMeteredConfigured()) {
      if (!METERED_APP_NAME) console.warn('[meteredIce] METERED_APP_NAME が未設定です');
      if (!METERED_API_KEY) console.warn('[meteredIce] METERED_API_KEY が未設定です');
      console.warn('[meteredIce] 設定不足のためSTUNのみで動作します(国際通話は繋がりません)');
      resolve(FALLBACK_ICE_SERVERS);
      return;
    }

    const options = {
      hostname: `${METERED_APP_NAME}.metered.live`,
      path: `/api/v1/turn/credentials?apiKey=${encodeURIComponent(METERED_API_KEY)}`,
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`[meteredIce] Metered API エラー (status=${res.statusCode}):`, body.slice(0, 300));
          resolve(FALLBACK_ICE_SERVERS);
          return;
        }
        try {
          const data = JSON.parse(body);
          // v1 エンドポイントは配列を直接返す。念のため {iceServers:[...]} 形式にも対応。
          const raw = Array.isArray(data)
            ? data
            : (Array.isArray(data.iceServers) ? data.iceServers : null);
          if (!raw || raw.length === 0) {
            console.warn('[meteredIce] Metered レスポンスにICEサーバーが含まれていません:', body.slice(0, 200));
            resolve(FALLBACK_ICE_SERVERS);
            return;
          }
          const iceServers = raw.map(s => {
            const entry = { urls: s.urls || s.url };
            if (s.username) entry.username = s.username;
            if (s.credential) entry.credential = s.credential;
            return entry;
          }).filter(s => s.urls);

          const turnCount = iceServers.filter(s => {
            const u = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls);
            return /^turns?:/i.test(u);
          }).length;
          console.log(`[meteredIce] Metered から ICE サーバー取得: ${iceServers.length}件 (TURN ${turnCount}件)`);
          resolve(iceServers);
        } catch (e) {
          console.error('[meteredIce] Metered レスポンスのパースに失敗:', e.message);
          resolve(FALLBACK_ICE_SERVERS);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[meteredIce] Metered API 呼び出し失敗:', e.message);
      resolve(FALLBACK_ICE_SERVERS);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error('[meteredIce] Metered API タイムアウト');
      resolve(FALLBACK_ICE_SERVERS);
    });

    req.end();
  });
}

module.exports = { fetchMeteredIceServers, isMeteredConfigured };
