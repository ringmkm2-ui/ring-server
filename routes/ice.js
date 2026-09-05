// routes/ice.js
// -----------------------------------------------------------------------
// クライアント(admin.html)が通話を開始する直前に、このエンドポイントを
// 叩いて最新のSTUN/TURN(ICEサーバー)情報を取得する。
// 認証情報(Twilio/Metered)はサーバー側にのみ保持し、
// ここで発行される一時的なICEサーバー情報だけをクライアントへ渡す。
//
// TURN取得は多段フォールバック:
//   1) Twilio NTS (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN があれば最優先)
//   2) Metered.ca (METERED_SECRET_KEY があれば次点)
//   3) Google STUN のみ(最終フォールバック。国際通話等は繋がらない)
// -----------------------------------------------------------------------
const express = require('express');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { fetchTwilioIceServers, isTwilioConfigured } = require('../utils/twilioIce');
const { fetchMeteredIceServers, isMeteredConfigured } = require('../utils/meteredIce');

const router = express.Router();

const STUN_ONLY = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

router.get('/', verifyToken, asyncHandler(async (req, res) => {
  // 1) Twilio NTS を最優先で試す
  if (isTwilioConfigured()) {
    const twilio = await fetchTwilioIceServers();
    if (twilio && twilio.length > 0) {
      res.json({ iceServers: twilio, provider: 'twilio' });
      return;
    }
  }

  // 2) Metered.ca にフォールバック
  if (isMeteredConfigured()) {
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
