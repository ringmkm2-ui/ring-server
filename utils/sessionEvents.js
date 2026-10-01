// utils/sessionEvents.js
// セッション失効をWebSocket側へ伝える小さな橋渡し(routes/auth.js と ws/wsServer.js が
// お互いを require すると循環するため、イベントで繋ぐ)。
//   emit('revoked', { userId, sid })        その端末だけ切る
//   emit('revoked', { userId, exceptSid })  指定の端末以外すべて切る
//   emit('revoked', { userId })             そのユーザーの全接続を切る
const { EventEmitter } = require('events');
module.exports = new EventEmitter();
