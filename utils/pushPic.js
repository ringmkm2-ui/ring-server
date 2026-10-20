// utils/pushPic.js
// 通知に出す相手のアイコンのURL。
// プッシュ通知は約4KBまでなので、Base64(data:)や長いものは載せない。
// 通知は端末のOSが取りに行くため、https のURL(Cloudinary等)か、このサーバーの /icons/<id> だけを通す。
function pushPic(raw) {
  if (typeof raw !== 'string' || !raw || raw.length >= 512) return undefined;
  if (/^\/icons\/[A-Za-z0-9-]+$/.test(raw)) return raw;
  if (/^https:\/\/[^\s]+$/.test(raw)) return raw;
  return undefined;
}

module.exports = { pushPic };
