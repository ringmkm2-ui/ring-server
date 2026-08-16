// utils/twilioIce.js
// -----------------------------------------------------------------------
// Twilio Network Traversal Service を使い、通話開始のたびに一時的な
// STUN/TURN認証情報(ICEサーバー一覧)を取得するヘルパー。
//
// 経緯: Open Relay Projectの無料TURN(認証情報固定・アカウント登録不要)を
// 使っていたが、これは現在Twilioに買収されアカウント登録必須の運用に
// 移行しており、以前使っていた固定の公開デモ用認証情報は非推奨になった。
// 結果、遠距離の相手同士(対称型NATを越える必要があるケース)で通話が
// 「接続中...」のまま繋がらない問題が発生していた。
// Twilioの正式なNetwork Traversal Serviceに切り替えることで解決する。
//
// Account SID / Auth Token はサーバー側の環境変数にのみ保持し、
// クライアントには一切渡さない。クライアントには、この関数で取得した
// 「短時間だけ有効な一時的なICEサーバー認証情報」だけを渡す
// (Twilioのトークンはデフォルトで有効期限付きのため、漏洩しても
// 恒久的なリスクにはならない)。
const https = require('https');

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';

// Twilioが未設定の場合のフォールバック(Google STUNのみ)。
// TwilioなしでもSTUNだけで繋がるケースはあるため、設定漏れでアプリ全体が
// 壊れることは避け、機能を落として動かす。
const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

function isTwilioConfigured() {
  return !!(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);
}

/**
 * Twilioから一時的なICEサーバー一覧(STUN+TURN、有効期限付き)を取得する。
 * Twilio未設定、またはAPI呼び出し失敗時はGoogle STUNのみのフォールバックを返す
 * (通話機能自体を止めないため、例外は投げない設計)。
 */
function fetchTwilioIceServers() {
  return new Promise((resolve) => {
    if (!isTwilioConfigured()) {
      console.warn('[twilioIce] TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN が未設定のため、STUNのみで動作します');
      resolve(FALLBACK_ICE_SERVERS);
      return;
    }

    const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
    const postData = '';

    const options = {
      hostname: 'api.twilio.com',
      path: `/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Tokens.json`,
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: 8000,
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error(`[twilioIce] Twilio APIエラー (status=${res.statusCode}):`, body.slice(0, 300));
          resolve(FALLBACK_ICE_SERVERS);
          return;
        }
        try {
          const data = JSON.parse(body);
          if (Array.isArray(data.ice_servers) && data.ice_servers.length > 0) {
            // Twilioのレスポンス形式 { url, urls, username, credential } を
            // ブラウザのRTCIceServer形式 { urls, username, credential } に正規化
            const iceServers = data.ice_servers.map(s => ({
              urls: s.urls || s.url,
              username: s.username,
              credential: s.credential,
            }));
            resolve(iceServers);
          } else {
            console.warn('[twilioIce] Twilioレスポンスにice_serversが含まれていません');
            resolve(FALLBACK_ICE_SERVERS);
          }
        } catch (e) {
          console.error('[twilioIce] Twilioレスポンスのパースに失敗:', e.message);
          resolve(FALLBACK_ICE_SERVERS);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[twilioIce] Twilio API呼び出し失敗:', e.message);
      resolve(FALLBACK_ICE_SERVERS);
    });

    req.on('timeout', () => {
      req.destroy();
      console.error('[twilioIce] Twilio APIタイムアウト');
      resolve(FALLBACK_ICE_SERVERS);
    });

    req.write(postData);
    req.end();
  });
}

module.exports = { fetchTwilioIceServers, isTwilioConfigured };
