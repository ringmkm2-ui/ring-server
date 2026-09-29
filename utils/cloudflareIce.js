// utils/cloudflareIce.js
// -----------------------------------------------------------------------
// Cloudflare Realtime TURN 統合。
// ダッシュボードで作った TURN キー(ID + API トークン)から、通話ごとに
// 短命のICEサーバー情報を発行する。トークンはサーバーにだけ置く。
//
// 必要な環境変数:
//   CLOUDFLARE_TURN_KEY_ID    : TURN Token ID
//   CLOUDFLARE_TURN_API_TOKEN : TURN の API Token
// 料金: 月1,000GBまで無料(通話音声なら実質使い切らない)。超過は $0.05/GB。
// -----------------------------------------------------------------------
const https = require('https');

const KEY_ID = (process.env.CLOUDFLARE_TURN_KEY_ID || '').trim();
const API_TOKEN = (process.env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
const TTL_SECONDS = 86400;

function isCloudflareConfigured() {
  return !!(KEY_ID && API_TOKEN);
}

// ブラウザがブロックするport 53の候補は外す(繋がらない候補で待たされるだけなので)
function dropPort53(servers) {
  return servers
    .map(s => {
      const urls = [].concat(s.urls || []).filter(u => !/:53(\?|$)/.test(u));
      return urls.length ? { ...s, urls } : null;
    })
    .filter(Boolean);
}

// 失敗・TURN無しの場合は null(routes/ice.js が次のプロバイダへ進む)
function fetchCloudflareIceServers() {
  return new Promise((resolve) => {
    if (!isCloudflareConfigured()) { resolve(null); return; }
    const body = JSON.stringify({ ttl: TTL_SECONDS });
    const req = https.request({
      hostname: 'rtc.live.cloudflare.com',
      path: `/v1/turn/keys/${encodeURIComponent(KEY_ID)}/credentials/generate-ice-servers`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_TOKEN}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    }, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          console.error('[cloudflareIce] 発行に失敗:', res.statusCode, raw.slice(0, 200));
          resolve(null); return;
        }
        try {
          const json = JSON.parse(raw);
          // generate-ice-servers は配列、旧 generate は単体オブジェクトを返すので両方受ける
          const list = [].concat(json.iceServers || []);
          const servers = dropPort53(list);
          const hasTurn = servers.some(s => [].concat(s.urls).some(u => /^turns?:/i.test(u)));
          if (!hasTurn) { console.error('[cloudflareIce] 応答にturn:が含まれていません'); resolve(null); return; }
          resolve(servers);
        } catch (e) {
          console.error('[cloudflareIce] 応答の解析に失敗:', e.message);
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => { console.error('[cloudflareIce] 通信エラー:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

module.exports = { fetchCloudflareIceServers, isCloudflareConfigured };
