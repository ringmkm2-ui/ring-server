// utils/gdrive.js
// 公式アカウント(brochatofficialglobal)のGoogleドライブを、トークの画像・動画の置き場所に使う。
//
// - 置くのは端末で暗号化済みのバイト列だけ。Googleにも中身は分からない(Cloudinaryと同じ扱い)
// - 権限は drive.file(このアプリが作ったファイルだけ触れる)。ドライブの他のファイルは見えない
// - 接続(リフレッシュトークン)はDBの app_kv に1つだけ持つ。運営が /drive-connect.html から1回つなぐ
// - 必要な環境変数: GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET (無ければ機能ごと無効で、今まで通りCloudinary)
const crypto = require('crypto');
const db = require('../db/db');

const CLIENT_ID = (process.env.GDRIVE_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.GDRIVE_CLIENT_SECRET || '').trim();
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Bro Chat media';

function isConfigured() { return !!(CLIENT_ID && CLIENT_SECRET); }

async function kvGet(k) {
  const row = await db.get('SELECT v FROM app_kv WHERE k = ?', [k]);
  return row ? row.v : null;
}
async function kvSet(k, v) {
  const row = await db.get('SELECT 1 AS ok FROM app_kv WHERE k = ?', [k]);
  if (row) await db.run('UPDATE app_kv SET v = ? WHERE k = ?', [v, k]);
  else await db.run('INSERT INTO app_kv (k, v) VALUES (?, ?)', [k, v]);
}

function redirectUri(req) {
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${base}/api/drive/callback`;
}

function authUrl(req, state) {
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function exchangeCode(req, code) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, redirect_uri: redirectUri(req), grant_type: 'authorization_code' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.refresh_token) throw new Error('token exchange failed: ' + (j.error_description || j.error || r.status));
  await kvSet('gdrive_refresh_token', j.refresh_token);
  await kvSet('gdrive_folder_id', '');
  access = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 - 60000 };
  connectedCache = { v: true, ts: Date.now() };
}

let access = { token: null, exp: 0 };
let connectedCache = { v: null, ts: 0 };
async function isConnected() {
  if (!isConfigured()) return false;
  if (connectedCache.v !== null && Date.now() - connectedCache.ts < 60000) return connectedCache.v;
  const v = !!(await kvGet('gdrive_refresh_token'));
  connectedCache = { v, ts: Date.now() };
  return v;
}

async function accessToken() {
  if (access.token && Date.now() < access.exp) return access.token;
  const rt = await kvGet('gdrive_refresh_token');
  if (!rt) throw new Error('drive not connected');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: rt, grant_type: 'refresh_token' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) {
    // 取り消された・期限切れ(テスト公開のまま7日たった等)。つなぎ直すまでCloudinaryに戻す
    if (j.error === 'invalid_grant') { await kvSet('gdrive_refresh_token', ''); connectedCache = { v: false, ts: Date.now() }; }
    throw new Error('refresh failed: ' + (j.error || r.status));
  }
  access = { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3000) * 1000 - 60000 };
  return access.token;
}

async function folderId() {
  const cached = await kvGet('gdrive_folder_id');
  if (cached) return cached;
  const tok = await accessToken();
  const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.id) throw new Error('folder create failed: ' + r.status);
  await kvSet('gdrive_folder_id', j.id);
  return j.id;
}

// 受け取ったリクエスト本文(暗号化済みのバイト列)を、そのままドライブへ流し込む(メモリに全部ためない)
async function uploadStream(stream, size, name) {
  const tok = await accessToken();
  const parent = await folderId();
  const init = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,size', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + tok,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/octet-stream',
      'X-Upload-Content-Length': String(size),
    },
    body: JSON.stringify({ name, parents: [parent], mimeType: 'application/octet-stream' }),
  });
  const loc = init.headers.get('location');
  if (!init.ok || !loc) throw new Error('upload init failed: ' + init.status);
  const put = await fetch(loc, {
    method: 'PUT',
    headers: { 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' },
    body: stream,
    duplex: 'half',
  });
  const j = await put.json().catch(() => ({}));
  if (!put.ok || !j.id) throw new Error('upload failed: ' + put.status);
  return { id: j.id, size: Number(j.size) || size };
}

async function openDownload(fileId) {
  const tok = await accessToken();
  return fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    headers: { Authorization: 'Bearer ' + tok },
  });
}

async function remove(fileId) {
  const tok = await accessToken();
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + tok },
  });
  return r.ok || r.status === 404;
}

async function quota() {
  const tok = await accessToken();
  const r = await fetch('https://www.googleapis.com/drive/v3/about?fields=storageQuota', { headers: { Authorization: 'Bearer ' + tok } });
  const j = await r.json().catch(() => ({}));
  return j.storageQuota || null;
}

function newState() { return crypto.randomBytes(24).toString('hex'); }

module.exports = { isConfigured, isConnected, authUrl, exchangeCode, uploadStream, openDownload, remove, quota, newState, folderId };
