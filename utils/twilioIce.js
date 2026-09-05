// utils/twilioIce.js
// -----------------------------------------------------------------------
// Twilio Network Traversal Service (NTS) TURN サーバー統合
// -----------------------------------------------------------------------
// Twilio NTS は UDP / TCP / TLS(443) 経由の実TURNサーバーを返す。
// STUN単独では抜けられない環境
//   - 対称型NAT(多くのモバイルキャリア回線)
//   - CGNAT(キャリアグレードNAT)
//   - 地域をまたぐ経路(日本⇔海外)
//   - ポート制限の厳しい企業/公共Wi-Fi(TLS 443 relayで回避)
// でもメディアを中継して接続を成立させる。
// これが無いと、上記環境の相手とは「接続中...」のまま
// iceConnectionStateがfailedになり通話が切れる。
//
// AccountSid / AuthToken はサーバー側環境変数にのみ保持し、
// ここで発行される一時的なICEサーバー情報(TTL付き)だけをクライアントへ渡す。
// -----------------------------------------------------------------------
const https = require('https');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

function isTwilioConfigured() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
}

/**
 * Twilio NTS から一時的なICEサーバー一覧(STUN+TURN)を取得する。
 * 失敗した場合は null を返し、呼び出し側でフォールバックさせる。
 */
function fetchTwilioIceServers() {
  return new Promise((resolve) => {
    if (!isTwilioConfigured()) {
      resolve(null);
      return;
    }

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Tokens.json`,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': 0,
      },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`[twilioIce] Twilio API エラー (status=${res.statusCode}):`, body.slice(0, 300));
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(body);
          if (!Array.isArray(data.ice_servers) || data.ice_servers.length === 0) {
            console.warn('[twilioIce] Twilio レスポンスに ice_servers が含まれていません');
            resolve(null);
            return;
          }
          // Twilioは {url, urls, username, credential} 形式で返す(urlは非推奨)。
          // ブラウザのRTCIceServer形式(urls必須)へ正規化する。
          const iceServers = data.ice_servers.map(s => {
            const entry = { urls: s.urls || s.url };
            if (s.username) entry.username = s.username;
            if (s.credential) entry.credential = s.credential;
            return entry;
          }).filter(s => s.urls);

          const turnCount = iceServers.filter(s => {
            const u = Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls);
            return /^turns?:/i.test(u);
          }).length;
          console.log(`[twilioIce] Twilio NTS から ICE サーバー取得: ${iceServers.length}件 (TURN ${turnCount}件, ttl=${data.ttl || '?'})`);
          resolve(iceServers);
        } catch (e) {
          console.error('[twilioIce] Twilio レスポンスのパースに失敗:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[twilioIce] Twilio API 呼び出し失敗:', e.message);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      console.error('[twilioIce] Twilio API タイムアウト');
      resolve(null);
    });

    req.end();
  });
}

module.exports = { fetchTwilioIceServers, isTwilioConfigured };
