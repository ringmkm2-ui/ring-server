// routes/ice.js
// -----------------------------------------------------------------------
// クライアント(admin.html)が通話を開始する直前に、このエンドポイントを
// 叩いて最新のSTUN/TURN(ICEサーバー)情報を取得する。
// 認証情報(Cloudflare/Metered)はサーバー側にのみ保持し、
// ここで発行される一時的なICEサーバー情報だけをクライアントへ渡す。
//
// TURN取得は多段フォールバック:
//   1) 固定認証のTURN (TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL。ExpressTURN等、カード不要の無料枠向け)
//   2) Cloudflare Realtime TURN (CLOUDFLARE_TURN_KEY_ID / CLOUDFLARE_TURN_API_TOKEN。要カード)
//   3) Metered.ca (METERED_API_KEY があれば次点)
//   4) Google STUN のみ(最終フォールバック。国際通話等は繋がらない)
// -----------------------------------------------------------------------
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { fetchCloudflareIceServers, isCloudflareConfigured } = require('../utils/cloudflareIce');
const { getStaticTurnIceServers, isStaticTurnConfigured } = require('../utils/staticTurn');
const { fetchMeteredIceServers, isMeteredConfigured } = require('../utils/meteredIce');

const router = express.Router();

const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

router.get('/', verifyToken, asyncHandler(async (req, res) => {
  // ?skip=cloudflare : クライアント側でTURNが実際には使えなかった(中継候補が取れない)時に次を試す
  const skip = String(req.query.skip || '').split(',');
  // 1) 固定認証のTURN(カード不要の無料サービス)
  if (isStaticTurnConfigured() && !skip.includes('turn')) {
    res.json({ iceServers: getStaticTurnIceServers(), provider: 'turn' });
    return;
  }

  // 2) Cloudflare Realtime TURN
  if (isCloudflareConfigured() && !skip.includes('cloudflare')) {
    const cf = await fetchCloudflareIceServers();
    if (cf && cf.length > 0) {
      res.json({ iceServers: cf, provider: 'cloudflare' });
      return;
    }
  }

  // 3) Metered.ca にフォールバック
  if (isMeteredConfigured() && !skip.includes('metered')) {
    const metered = await fetchMeteredIceServers();
    if (metered && metered.length > 0) {
      res.json({ iceServers: metered, provider: 'metered' });
      return;
    }
  }

  // 3) STUN のみ(TURN未設定。対称型NAT/CGNAT/国際通話では繋がらない)
  console.warn('[ice] TURNプロバイダ未設定のためSTUNのみを返します(国際通話・対称型NAT環境では接続できません)');
  res.json({ iceServers: STUN_ONLY, provider: 'stun-only' });
}));

module.exports = router;
