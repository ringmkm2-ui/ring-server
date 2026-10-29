// utils/messageContent.js
// 個人チャットとグループで同じ「本文・メディアの受け入れ基準」を使うための共通処理。
//
// 以前は mediaUrl を一切見ずにそのまま保存していた。相手の画面はその URL を
// <img>/<video> の src に入れるので、友だちであれば自分のサーバーのURLを送るだけで、
// 相手がトークを開いた瞬間のIPアドレスと時刻を集められた(E2E暗号化していても、
// 「いつ開いたか」「どこから繋いでいるか」は漏れる)。
// また /edit 側には長さの上限が無く、4MBの本文を何度でも書き込めた。
const MAX_CONTENT_LENGTH = 64 * 1024;          // 暗号文の本文(Base64)の上限
const MAX_MEDIA_DATA_LENGTH = 35 * 1024 * 1024; // Base64直送りメディアの上限(約25MB相当)
const MAX_MEDIA_URL_LENGTH = 500;
const MAX_METADATA_LENGTH = 16 * 1024; // 暗号化メディアの付帯情報(ファイル名・分割長など)。1GBでも数KB
const ALLOWED_MEDIA_TYPES = ['image', 'video', 'audio', 'file'];

// メディアの置き場所はCloudinaryか、このサーバー経由のGoogleドライブ(/m/d/<id>)だけ。
// 他所のURLは相手の端末に取りに行かせない。
const SELF_HOSTS = new Set(['ring-server-50sy.onrender.com', ...String(process.env.PUBLIC_BASE_URL || '').replace(/^https?:\/\//, '').split(/[\/,]/).filter(Boolean)]);
// Cloudinaryは自分たちのクラウドだけ。以前は res.cloudinary.com なら誰のアカウントでも通り、
// 他人のクラウドに置いた画像で開いた時刻を数えられた
const CLOUD_NAMES = new Set(['a6rxinoz', ...String(process.env.CLOUDINARY_CLOUD_NAME || '').split(',').map(x => x.trim()).filter(Boolean)]);
function isOwnCloudinaryUrl(value, charset = /^[A-Za-z0-9_\-./,:%]+$/) {
  if (typeof value !== 'string') return false;
  const m = /^https:\/\/res\.cloudinary\.com\/([A-Za-z0-9_-]+)\/(.+)$/.exec(value);
  if (!m || !CLOUD_NAMES.has(m[1]) || !charset.test(m[2]) || m[2].includes('..')) return false;
  return true;
}
function isValidMessageMediaUrl(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_MEDIA_URL_LENGTH) return false;
  if (isOwnCloudinaryUrl(value)) return true;
  const m = /^https:\/\/([A-Za-z0-9.-]+(?::\d+)?)\/m\/d\/[A-Za-z0-9_-]{10,100}$/.exec(value);
  return !!(m && (SELF_HOSTS.has(m[1]) || process.env.NODE_ENV !== 'production' && /^localhost(:\d+)?$/.test(m[1])));
}

// 送信・編集の共通チェック。問題があればエラー文、無ければ null を返す。
// opts.allowMedia=false のとき(編集)は mediaType/mediaUrl を受け付けない。
function validateMessageInput(body, opts = {}) {
  const allowMedia = opts.allowMedia !== false;
  const { content, mediaType, mediaUrl, mediaData, mediaPublicId } = body || {};

  if (typeof content !== 'string') return '本文の形式が正しくありません';
  if (content.length > MAX_CONTENT_LENGTH) return 'メッセージが長すぎます';

  // 「通知」はサーバーだけが作る種類(Banのお知らせ等)。送信APIからは作らせない
  if (mediaType != null) {
    if (!allowMedia) return 'この操作ではメディアを変更できません';
    if (typeof mediaType !== 'string' || !ALLOWED_MEDIA_TYPES.includes(mediaType)) {
      return 'mediaTypeが不正です';
    }
  }
  if (mediaUrl != null) {
    if (!allowMedia) return 'この操作ではメディアを変更できません';
    if (!isValidMessageMediaUrl(mediaUrl)) return 'メディアのURLが不正です';
    if (!mediaType) return 'mediaTypeが必要です';
  }
  if (mediaPublicId != null && (typeof mediaPublicId !== 'string' || mediaPublicId.length > 300)) {
    return 'メディアの指定が不正です';
  }
  // 暗号化メディアの付帯情報。以前は大きさを見ておらず、1通2MBの文字列を詰めて
  // DBを埋めたり、履歴の読み込み(100件)でサーバーのメモリを使い切らせたりできた
  const { encryptedMetadata, chunkCount } = body || {};
  if (encryptedMetadata != null) {
    if (!allowMedia) return 'この操作ではメディアを変更できません';
    if (typeof encryptedMetadata !== 'object' || Array.isArray(encryptedMetadata)) return 'メディアの情報が不正です';
    const keys = Object.keys(encryptedMetadata);
    if (keys.some(k => k !== 'encrypted' && k !== 'nonce')) return 'メディアの情報が不正です';
    if (typeof encryptedMetadata.encrypted !== 'string' || encryptedMetadata.encrypted.length > MAX_METADATA_LENGTH) return 'メディアの情報が不正です';
    if (typeof encryptedMetadata.nonce !== 'string' || encryptedMetadata.nonce.length > 64) return 'メディアの情報が不正です';
  }
  if (chunkCount != null && !(Number.isInteger(chunkCount) && chunkCount >= 0 && chunkCount <= 1000)) {
    return 'メディアの情報が不正です';
  }
  if (mediaData != null) {
    if (!allowMedia) return 'この操作ではメディアを変更できません';
    // 画像・動画は今は全部Cloudinaryへ暗号化して送る。本文にBase64を直接入れる古い形式は
    // 1通数十MBをDBに積めて、履歴を開くだけでサーバーのメモリを使い切れたので受け付けない
    return 'この形式の送信は使えなくなりました。アプリを最新にしてください';
    if (!mediaType) return 'mediaTypeが必要です';
  }
  return null;
}

module.exports = {
  MAX_CONTENT_LENGTH,
  MAX_MEDIA_DATA_LENGTH,
  ALLOWED_MEDIA_TYPES,
  isValidMessageMediaUrl,
  isOwnCloudinaryUrl,
  validateMessageInput,
};
