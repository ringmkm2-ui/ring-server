// utils/staticTurn.js
// -----------------------------------------------------------------------
// 固定のユーザー名/パスワードで使うTURNサーバー(ExpressTURN, Metered Open Relay,
// 自前coturn など、カード不要の無料サービス向け)。
//
// 必要な環境変数:
//   TURN_URLS       : カンマ区切り。例)
//                     turn:relay1.expressturn.com:3478,turn:relay1.expressturn.com:3478?transport=tcp
//   TURN_USERNAME   : 発行されたユーザー名
//   TURN_CREDENTIAL : 発行されたパスワード
// -----------------------------------------------------------------------
const URLS = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(u => /^turns?:/i.test(u));
const USERNAME = (process.env.TURN_USERNAME || '').trim();
const CREDENTIAL = (process.env.TURN_CREDENTIAL || '').trim();

function isStaticTurnConfigured() {
  return URLS.length > 0 && !!USERNAME && !!CREDENTIAL;
}

function getStaticTurnIceServers() {
  if (!isStaticTurnConfigured()) return null;
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: URLS, username: USERNAME, credential: CREDENTIAL },
  ];
}

module.exports = { getStaticTurnIceServers, isStaticTurnConfigured };
