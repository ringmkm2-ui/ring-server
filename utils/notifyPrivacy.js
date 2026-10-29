// utils/notifyPrivacy.js
// 「通知に本文を出さない」設定(hideNotificationBody)を、プッシュを作る全ての経路で同じように効かせる。
//
// ロック画面は他人の目に触れる。これまでの通知には本文の暗号文(cipher)を載せ、端末の中で復号して
// 本文を表示していたので、この設定を入れた人でも本文が画面に出てしまう。
// 設定が有効な受信者には、送信者名は残したまま本文・暗号文・公開鍵・メディアの種類まで落とす。
// 通話の着信は「メッセージ本文」ではないので対象外(呼び出し側が containsMessage を付けた時だけ効く)。
const { getSettings } = require('./userSettings');

const GENERIC_BODY = '新しいメッセージ';

async function shouldHideBody(userId) {
  try {
    return !!(await getSettings(userId)).hideNotificationBody;
  } catch (e) {
    // 設定が読めない時に本文を出してしまうより、隠す側に倒す
    return true;
  }
}

// Web Push のペイロード。type が new_message / new_group_message の本文系だけを書き換える
function privatizeWebPayload(payload) {
  const out = { ...payload };
  out.preview = GENERIC_BODY;
  // 端末側のService Workerが復号して本文を出すための材料は全部落とす
  delete out.cipher;
  delete out.senderPub;
  delete out.thumbnail;
  delete out.image;
  delete out.body;
  delete out.mediaType;
  return out;
}

// FCM に渡す (content, extra)。extra は cipher / senderPub を含みうる
function privatizeFcmArgs(content, extra) {
  const e = { ...(extra || {}) };
  e.cipher = '';
  e.senderPub = '';
  delete e.thumbnail;
  return { content: GENERIC_BODY, extra: e };
}

module.exports = { GENERIC_BODY, shouldHideBody, privatizeWebPayload, privatizeFcmArgs };
