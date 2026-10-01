// utils/secretBox.js
// DBに平文で置きたくない秘密(2FAのTOTP秘密鍵など)をAES-256-GCMで暗号化して保存するための小さな道具。
// 鍵は DATA_ENCRYPTION_KEY があればそれ、無ければ JWT_SECRET から導出する。
// 注意: 鍵(または JWT_SECRET)を変えると、既に暗号化済みの値は復号できなくなる。
const crypto = require('crypto');
const { JWT_SECRET } = require('./jwtSecret');

const PREFIX = 'enc:v1:';
const KEY = crypto.createHash('sha256').update((process.env.DATA_ENCRYPTION_KEY || JWT_SECRET) + ':secret-box').digest();

function encrypt(plain) {
  if (plain == null) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return PREFIX + [iv, tag, ct].map(b => b.toString('base64')).join('.');
}

function isEncrypted(v) {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

// 暗号化されていない旧データはそのまま返す(移行のため)。復号に失敗したら null。
function decrypt(stored) {
  if (stored == null) return null;
  if (!isEncrypted(stored)) return String(stored);
  try {
    const [iv, tag, ct] = stored.slice(PREFIX.length).split('.').map(s => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt, isEncrypted };
