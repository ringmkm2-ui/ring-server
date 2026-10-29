// routes/drive.js
// トークの画像・動画(端末で暗号化済み)を公式アカウントのGoogleドライブに置く。
// 仕組みは utils/gdrive.js。つながっていない時は enabled:false を返し、端末は今まで通りCloudinaryへ送る。
const express = require('express');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { adminUserIds } = require('../utils/adminNotify');
const gd = require('../utils/gdrive');
const { canUploadTo } = require('../utils/uploadScope');

const router = express.Router();
const MAX_BYTES = 610 * 1024 * 1024; // 端末側の上限(600MB)+暗号化の分

async function isStaff(userId) {
  try { return (await adminUserIds('STAFF_USERS', require('../utils/adminNotify').DEFAULT_STAFF)).includes(userId); } catch (e) { return false; }
}

// 置き場所(端末が付ける folder 名)を、本人が当事者の会話に限る(Cloudinaryの署名と同じ基準。utils/uploadScope.js)
// ドライブはファイルIDの下位フォルダを付けないので、ここでは付いていない形だけを通す
async function canUseScope(userId, scope) {
  if (typeof scope !== 'string' || !/^brochat\/(dm\/[A-Za-z0-9_-]+|groups\/[A-Za-z0-9-]+|posts\/[A-Za-z0-9_-]+)$/.test(scope)) return false;
  return canUploadTo(userId, scope);
}
const isPostScope = scope => /^brochat\/posts\//.test(scope || '');
// 読む時は、抜けたメンバーでも当時のメッセージを見られるように left_at は問わない
async function canReadScope(userId, scope) {
  const dm = /^brochat\/dm\/([A-Za-z0-9_-]+)$/.exec(scope || '');
  if (dm) return dm[1].split('_').includes(userId);
  const gr = /^brochat\/groups\/([A-Za-z0-9-]+)$/.exec(scope || '');
  if (gr) return !!(await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?', [gr[1], userId]));
  return false;
}

router.get('/status', verifyToken, asyncHandler(async (req, res) => {
  const enabled = await gd.isConnected();
  const out = { enabled };
  if (await isStaff(req.userId)) {
    out.configured = gd.isConfigured();
    if (enabled) { try { out.quota = await gd.quota(); } catch (e) { out.quotaError = e.message; } }
  }
  res.json(out);
}));

// 運営だけ: Googleのログイン画面のURLを作る(ブラウザで開いて公式アカウントで許可する)
const states = new Map(); // state -> { userId, exp }
router.post('/connect-url', verifyToken, asyncHandler(async (req, res) => {
  if (!(await isStaff(req.userId))) return res.status(404).json({ error: 'Not Found' });
  if (!gd.isConfigured()) return res.status(400).json({ error: 'GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET がRenderに未設定です' });
  const state = gd.newState();
  for (const [k, v] of states) if (v.exp < Date.now()) states.delete(k);
  states.set(state, { userId: req.userId, exp: Date.now() + 10 * 60 * 1000 });
  res.json({ url: gd.authUrl(req, state) });
}));

function page(res, ok, msg) {
  res.status(ok ? 200 : 400).set('Content-Type', 'text/html; charset=utf-8').send(
    `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bro Chat</title></head>` +
    `<body style="font-family:system-ui,sans-serif;background:#0b0f0d;color:#e8eeea;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">` +
    `<div style="text-align:center;padding:24px"><h1 style="font-size:20px;color:${ok ? '#22c55e' : '#ef4444'}">${ok ? 'Googleドライブとつながりました' : 'つなげませんでした'}</h1>` +
    `<p style="opacity:.8;font-size:14px">${msg}</p><p><a href="/talklist.html" style="color:#22c55e">Bro Chatに戻る</a></p></div></body></html>`
  );
}

router.get('/callback', asyncHandler(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return page(res, false, 'Google側で許可されませんでした。');
  const st = typeof state === 'string' ? states.get(state) : null;
  if (!st || st.exp < Date.now() || typeof code !== 'string') return page(res, false, '時間切れです。もう一度やり直してください。');
  states.delete(state);
  try {
    await gd.exchangeCode(req, code);
    // つないだ時点でフォルダを作っておく(ドライブを開いた時に、つながったことが目で確かめられるように)
    await gd.folderId();
    console.log('[drive] connected, folder ready');
  } catch (e) {
    console.error('[drive] connect failed:', e.message);
    return page(res, false, '鍵の受け取りに失敗しました。リダイレクトURIとクライアントの設定を確認してください。');
  }
  page(res, true, 'これからトークで送る画像・動画は、公式アカウントのドライブに暗号化したまま置かれます。');
}));

// 暗号化済みのファイルを受け取ってドライブへ。本文はそのまま流す(JSONにしない)
// 写真をまとめて送ると1分10件(Cloudinary用の制限)にすぐ当たるので、ドライブは1分40件まで
const rateLimit = require('express-rate-limit');
const driveUploadLimiter = rateLimit({
  windowMs: 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false,
  ...require('../utils/rateLimits').perUser,
  message: { error: 'アップロードが多すぎます。しばらくしてからお試しください。' },
});
// 1人あたりの1日の上限。公式アカウントのドライブ(15GB)を1人で埋められないように
const DAILY_BYTES = Number(process.env.DRIVE_DAILY_BYTES_PER_USER) || 2 * 1024 * 1024 * 1024;
async function usedToday(userId) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const r = await db.get('SELECT COALESCE(SUM(size), 0) AS total FROM drive_files WHERE owner_id = ? AND created_at > ?', [userId, since]);
  return Number((r && r.total) || 0);
}
router.post('/upload', driveUploadLimiter, verifyToken, asyncHandler(async (req, res) => {
  if (!(await gd.isConnected())) return res.status(503).json({ error: 'drive not connected' });
  const scope = String(req.get('x-scope') || '');
  if (!(await canUseScope(req.userId, scope))) return res.status(403).json({ error: 'この場所には置けません' });
  const size = Number(req.get('content-length'));
  if (!Number.isFinite(size) || size <= 0) return res.status(411).json({ error: 'Content-Lengthが必要です' });
  if (size > MAX_BYTES) return res.status(413).json({ error: 'ファイルが大きすぎます' });
  if (!(await isStaff(req.userId)) && (await usedToday(req.userId)) + size > DAILY_BYTES) {
    return res.status(429).json({ error: '今日アップロードできる量を超えました。明日またお試しください' });
  }
  // 投稿は暗号化しないので、ブラウザがそのまま再生できるよう本当の種類で置く。トークは暗号文なので中身不明のまま
  const post = isPostScope(scope);
  let mime = 'application/octet-stream';
  if (post) {
    mime = String(req.get('x-content-type') || '').toLowerCase();
    if (!/^(image\/(jpeg|png|gif|webp|heic|heif|avif)|video\/(mp4|quicktime|webm|x-matroska|3gpp))$/.test(mime)) return res.status(415).json({ error: 'この種類のファイルは投稿できません' });
  }
  let out;
  try {
    out = await gd.uploadStream(Readable.toWeb(req), size, `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${post ? '' : '.bin'}`, mime);
  } catch (e) {
    console.error('[drive] upload failed:', e.message);
    return res.status(502).json({ error: 'ドライブへの保存に失敗しました' });
  }
  await db.run('INSERT INTO drive_files (file_id, owner_id, scope, size) VALUES (?, ?, ?, ?)', [out.id, req.userId, scope, out.size]);
  console.log(`[drive] stored ${Math.round(out.size / 1024)}KB`);
  const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  res.json({ url: `${base}/m/${post ? 'p' : 'd'}/${out.id}`, publicId: 'gd_' + out.id });
}));

// ファイルIDごとの置き場所を少しの間だけ覚える。
// 動画は Range で何十回も取りに来る(シークするたびに増える)ので、そのたびにDBを引くと
// 1本見られるだけで数十クエリになる。置き場所は後から変わらないので覚えてよい。
// 消した時は忘れる(removeOwned)。
const scopeCache = new Map(); // file_id -> { scope, exp }
const SCOPE_TTL_MS = 10 * 60 * 1000;
const SCOPE_CACHE_MAX = 500;
async function scopeOf(id) {
  const hit = scopeCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.scope;
  const row = await db.get('SELECT scope FROM drive_files WHERE file_id = ?', [id]);
  const scope = row ? row.scope : null;
  if (scopeCache.size >= SCOPE_CACHE_MAX) scopeCache.clear();
  scopeCache.set(id, { scope, exp: Date.now() + SCOPE_TTL_MS });
  return scope;
}

// GET /m/d/:id (index.js から付ける。/api の回数制限に掛けないため)
async function serveFile(req, res) {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return res.status(404).end();
  const scope = await scopeOf(id);
  if (!scope || !(await canReadScope(req.userId, scope))) return res.status(404).end();
  let r;
  try { r = await gd.openDownload(id); } catch (e) { return res.status(503).end(); }
  if (!r.ok || !r.body) return res.status(r.status === 404 ? 404 : 502).end();
  res.status(200);
  res.set('Content-Type', 'application/octet-stream');
  const len = r.headers.get('content-length');
  if (len) res.set('Content-Length', len);
  // 中身は暗号化済みで二度と変わらないので、端末に長く持たせる(同じ画像を何度も取りに来ない)
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  try { await pipeline(Readable.fromWeb(r.body), res); } catch (e) { /* 途中で閉じられた */ }
}

// GET /m/p/:id 投稿の画像・動画。投稿のメディアはCloudinaryでも推測できないURLで誰でも見られる形なので、
// ここもログイン不要(<video src>はAuthorizationを付けられない)。トーク用のファイルはここからは出さない。
// Rangeを通すので、動画の途中から再生・シークができる(iPhoneのSafariはこれが無いと動画を再生しない)
async function servePublic(req, res) {
  const id = String(req.params.id || '');
  if (!/^[A-Za-z0-9_-]{10,100}$/.test(id)) return res.status(404).end();
  const scope = await scopeOf(id);
  if (!scope || !isPostScope(scope)) return res.status(404).end();
  const range = typeof req.headers.range === 'string' && /^bytes=\d*-\d*$/.test(req.headers.range) ? req.headers.range : null;
  let r;
  try { r = await gd.openDownload(id, range); } catch (e) { return res.status(503).end(); }
  if (r.status === 416) { res.status(416); const cr = r.headers.get('content-range'); if (cr) res.set('Content-Range', cr); return res.end(); }
  if (!r.ok || !r.body) return res.status(r.status === 404 ? 404 : 502).end();
  res.status(r.status === 206 ? 206 : 200);
  for (const h of ['content-type', 'content-length', 'content-range']) { const v = r.headers.get(h); if (v) res.set(h, v); }
  res.set('Accept-Ranges', 'bytes');
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('X-Content-Type-Options', 'nosniff');
  if (req.method === 'HEAD') { try { await r.body.cancel(); } catch (_) {} return res.end(); }
  try { await pipeline(Readable.fromWeb(r.body), res); } catch (e) { /* 途中で閉じられた(シークした等) */ }
}

// 送信取り消し等で消す(本人が置いたファイルだけ)
async function removeOwned(userId, publicId) {
  const id = String(publicId || '').replace(/^gd_/, '');
  const row = await db.get('SELECT owner_id FROM drive_files WHERE file_id = ?', [id]);
  if (!row || row.owner_id !== userId) return false;
  scopeCache.delete(id);
  await gd.remove(id);
  await db.run('DELETE FROM drive_files WHERE file_id = ?', [id]);
  return true;
}

module.exports = { router, serveFile, servePublic, removeOwned };
