// utils/meteredIce.js
// -----------------------------------------------------------------------
// Metered.ca TURN サーバー統合
// クレジットカード不要で月1000分の無料通話時間
// Secret Key はサーバー側環境変数にのみ保持
// -----------------------------------------------------------------------
const https = require('https');

const METERED_SECRET_KEY = process.env.METERED_SECRET_KEY || '';

// Metered.ca が未設定の場合のフォールバック(Google STUNのみ)
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

function isMeteredConfigured() {
  return !!METERED_SECRET_KEY;
}

/**
 * Metered.ca から一時的なICEサーバー一覧(STUN+TURN)を取得する
 */
function fetchMeteredIceServers() {
  return new Promise((resolve) => {
    if (!isMeteredConfigured()) {
      console.warn('[meteredIce] METERED_SECRET_KEY が未設定のため、STUNのみで動作します');
      resolve(FALLBACK_ICE_SERVERS);
      return;
    }

    const options = {
      hostname: 'api.metered.ca',
      path: '/api/v1/turn/credentials?apiKey=' + METERED_SECRET_KEY,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
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
          if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
            // Metered.ca のレスポンス形式をブラウザのRTCIceServer形式に正規化
            const iceServers = data.iceServers.map(s => ({
              urls: s.urls || (s.url ? [s.url] : []),
              username: s.username,
              credential: s.credential,
            }));
            console.log('[meteredIce] Metered.ca から ICE サーバー取得:', iceServers.length, 'servers');
            resolve(iceServers);
          } else {
            console.warn('[meteredIce] Metered レスポンスに iceServers が含まれていません');
            resolve(FALLBACK_ICE_SERVERS);
          }
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
