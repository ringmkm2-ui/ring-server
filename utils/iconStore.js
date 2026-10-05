// utils/iconStore.js
// アイコン(プロフィール/グループ)画像の保存先。
// まずCloudinaryへアップロードし、届かなかった時だけサーバー(DB)に保存して配信する。
// どちらの場合も「https://... のURL」だけをDBに持たせる(Base64を丸ごと持たない)。
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'a6rxinoz';
const UPLOAD_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || 'brochat_upload';
const MAX_ICON_BYTES = 1.5 * 1024 * 1024;
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

function parseDataUrl(dataUrl) {
  const m = /^data:(image\/(?:png|jpe?g|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m) return null;
  const mime = m[1] === 'image/jpg' ? 'image/jpeg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_ICON_BYTES) return null;
  return { mime, buf };
}

function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

async function uploadToCloudinary(buf, mime) {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime }), 'icon');
  form.append('upload_preset', UPLOAD_PRESET);
  form.append('folder', 'brochat/icons');
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, {
    method: 'POST', body: form, signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw new Error('cloudinary ' + r.status);
  const j = await r.json();
  if (!j.secure_url) throw new Error('cloudinary: no url');
  // 表示は小さいので256px上限に縮めて配信する
  return j.secure_url.replace('/upload/', '/upload/w_256,h_256,c_limit,q_auto/');
}

async function saveToServer(buf, mime, base) {
  const id = uuidv4();
  await db.run('INSERT INTO icon_images (id, mime, data) VALUES (?, ?, ?)', [id, mime, buf]);
  return `${base}/icons/${id}`;
}

// 戻り値: 保存された画像のhttps URL
async function storeIcon(buf, mime, base) {
  try {
    return await uploadToCloudinary(buf, mime);
  } catch (e) {
    console.warn('[icons] cloudinary failed, storing on server:', e.message);
    return saveToServer(buf, mime, base);
  }
}

// DBに保存してよいアイコンURLか(このサーバーの/icons/<uuid> か Cloudinary の画像のみ)。
// 他人のサーバーのURLを許すと、開いた人の端末がそこへアクセスしてしまうため自サーバーに限る。
function isValidIconUrl(value, req) {
  if (typeof value !== 'string' || value.length > 500) return false;
  // Cloudinaryは、このアプリのアカウント(CLOUD_NAME)の画像だけ。他人のアカウントの画像は通さない
  if (value.startsWith(`https://res.cloudinary.com/${CLOUD_NAME}/`) && /^https:\/\/res\.cloudinary\.com\/[a-zA-Z0-9_\-./,]+$/.test(value)) return true;
  const own = req ? baseUrl(req) : '';
  const m = /^(https:\/\/[a-zA-Z0-9.\-]+(?::\d+)?)\/icons\/[0-9a-f\-]{36}$/.exec(value);
  return !!(m && own && m[1] === own);
}

module.exports = { parseDataUrl, storeIcon, isValidIconUrl, baseUrl, MAX_ICON_BYTES, ALLOWED_MIME };
