// routes/stickers.js
// スタンプ: 自作スタンプ(パック)の作成・公開、スタンプショップ(全部無料)、マイスタンプ(並び・非表示)、お気に入り。
//
// メッセージとして送るのは本文 [[stamp:u:<スタンプID>]] だけ(E2E暗号のまま)。受け取った端末は
// GET /api/stickers/s?ids=... で画像URLを引く。画像URLはこのサーバーが保存した物だけなので、
// 送り主が好きなURLを埋め込んで相手の端末にアクセスさせる、ということはできない。
//
//   GET    /api/stickers/mine                     -> { packs:[{id,title,...,stickers}], order:[packId], hidden:[packId], favs:[key] }
//   PUT    /api/stickers/mine                     body { order?:[packId], hidden?:[packId] }
//   POST   /api/stickers/mine/:packId             マイスタンプに追加(無料ダウンロード)
//   DELETE /api/stickers/mine/:packId             マイスタンプから外す
//   PUT    /api/stickers/favs                     body { keys:[stickerKey] }  お気に入り(並び順ごと置き換え)
//   GET    /api/stickers/shop?q=&sort=new|popular&offset=
//   GET    /api/stickers/packs/:id                パックの中身(公開・非公開に関わらずIDを知っていれば見られる。LINEで届いたスタンプから辿れるのと同じ)
//   POST   /api/stickers/packs                    body { title, description?, isPublic? }
//   PATCH  /api/stickers/packs/:id                body { title?, description?, isPublic?, order?:[stickerId] }
//   DELETE /api/stickers/packs/:id
//   POST   /api/stickers/packs/:id/stickers       body { dataUrl, label?, keywords? }
//   PATCH  /api/stickers/packs/:id/stickers/:sid  body { label?, keywords? }
//   DELETE /api/stickers/packs/:id/stickers/:sid
//   GET    /api/stickers/s?ids=a,b,c              -> { stickers:[{id,packId,url,label,animated}] }
const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { parseDataUrl, storeIcon, baseUrl } = require('../utils/iconStore');

const router = express.Router();

// 公式パック(絵は端末側の stampArt.js にある)。並び替え・非表示のためにIDだけ知っておく
const BUILTIN_PACKS = ['b:neko', 'b:usa', 'b:kuma', 'b:msg'];
const MAX_PACKS_PER_USER = 30;     // 作れるパックの数
const MAX_STICKERS_PER_PACK = 40;  // LINEのクリエイターズスタンプと同じ上限
const MAX_MY_PACKS = 200;          // マイスタンプに入れられる数
const MAX_FAVS = 100;
const MAX_STICKER_BYTES = 800 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUILTIN_KEY_RE = /^[a-z0-9_]{1,24}$/;
const isPackId = v => typeof v === 'string' && (BUILTIN_PACKS.includes(v) || UUID_RE.test(v));
// お気に入りに入れられるキー: 公式 'ok' / 自作 'u:<uuid>'
const isStickerKey = v => typeof v === 'string' && (BUILTIN_KEY_RE.test(v) || (v.startsWith('u:') && UUID_RE.test(v.slice(2))));

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'u:' + req.userId,
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'スタンプの追加が多すぎます。しばらくしてからお試しください。' },
});

function clean(v, max) {
  if (typeof v !== 'string') return '';
  // 制御文字は消す(改行もいらない)
  return v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}
function cleanKeywords(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(/[,、\s]+/) : []);
  const out = [];
  for (const k of arr) {
    const c = clean(k, 20);
    if (c && !out.includes(c)) out.push(c);
    if (out.length >= 10) break;
  }
  return out;
}
const bool = v => v === true || v === 1 || v === '1';

function stickerOut(r) {
  let kw = [];
  try { kw = r.keywords ? JSON.parse(r.keywords) : []; } catch (_) {}
  return { id: r.id, packId: r.pack_id, url: r.image_url, label: r.label || '', keywords: kw, animated: !!Number(r.animated) };
}
async function packOut(p, me, withStickers) {
  const owner = await db.get('SELECT display_name FROM users WHERE id = ?', [p.owner_id]);
  const out = {
    id: p.id,
    title: p.title,
    description: p.description || '',
    author: owner ? owner.display_name || '' : '',
    authorId: p.owner_id,
    isPublic: !!Number(p.is_public),
    addCount: Number(p.add_count) || 0,
    mine: p.owner_id === me,
    deleted: !!p.deleted_at,
  };
  const rows = await db.all('SELECT * FROM stickers WHERE pack_id = ? AND deleted_at IS NULL ORDER BY position ASC, created_at ASC', [p.id]);
  out.count = rows.length;
  out.cover = rows.length ? rows[0].image_url : null;
  if (withStickers) out.stickers = rows.map(stickerOut);
  const added = await db.get('SELECT 1 AS ok FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?', [me, p.id]);
  out.added = !!added;
  return out;
}
async function ownPack(req, res) {
  const id = req.params.id;
  if (!UUID_RE.test(id || '')) { res.status(404).json({ error: 'スタンプが見つかりません' }); return null; }
  const p = await db.get('SELECT * FROM sticker_packs WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!p) { res.status(404).json({ error: 'スタンプが見つかりません' }); return null; }
  if (p.owner_id !== req.userId) { res.status(403).json({ error: '自分が作ったスタンプだけ変更できます' }); return null; }
  return p;
}
async function nextMyPosition(me) {
  const r = await db.get('SELECT MAX(position) AS m FROM user_sticker_packs WHERE user_id = ?', [me]);
  return (r && r.m != null ? Number(r.m) : BUILTIN_PACKS.length) + 1;
}
// 初めて並びを書く時、公式パックの行も作っておく(行が無い = 既定の並びで全部表示)
async function ensureBuiltinRows(me) {
  const have = await db.all('SELECT pack_id FROM user_sticker_packs WHERE user_id = ?', [me]);
  const set = new Set(have.map(r => r.pack_id));
  for (let i = 0; i < BUILTIN_PACKS.length; i++) {
    if (set.has(BUILTIN_PACKS[i])) continue;
    await db.run('INSERT INTO user_sticker_packs (user_id, pack_id, position, hidden) VALUES (?, ?, ?, 0) ON CONFLICT(user_id, pack_id) DO NOTHING', [me, BUILTIN_PACKS[i], i]);
  }
}

// ---- マイスタンプ ----
router.get('/mine', verifyToken, asyncHandler(async (req, res) => {
  const me = req.userId;
  const rows0 = await db.all('SELECT pack_id, position, hidden FROM user_sticker_packs WHERE user_id = ? ORDER BY position ASC, added_at ASC', [me]);
  // まだ行が無い公式パックは既定の位置(0,1,2..)にあるものとして混ぜる
  const have = new Set(rows0.map(r => r.pack_id));
  const rows = rows0.map((r, i) => ({ ...r, k: i }))
    .concat(BUILTIN_PACKS.map((id, i) => ({ pack_id: id, position: i, hidden: 0, k: -1 })).filter(r => !have.has(r.pack_id)))
    .sort((x, y) => (Number(x.position) - Number(y.position)) || (x.k - y.k));
  const order = [];
  const hidden = [];
  const packs = [];
  for (const r of rows) {
    if (BUILTIN_PACKS.includes(r.pack_id)) {
      order.push(r.pack_id);
      if (Number(r.hidden)) hidden.push(r.pack_id);
      continue;
    }
    const p = await db.get('SELECT * FROM sticker_packs WHERE id = ?', [r.pack_id]);
    // 作った人が消したパックは、マイスタンプからも消える
    if (!p || p.deleted_at) continue;
    order.push(p.id);
    if (Number(r.hidden)) hidden.push(p.id);
    packs.push(await packOut(p, me, true));
  }
  const favs = (await db.all('SELECT sticker_key FROM user_sticker_favs WHERE user_id = ? ORDER BY position ASC', [me])).map(r => r.sticker_key);
  res.json({ packs, order, hidden, favs });
}));

router.put('/mine', verifyToken, asyncHandler(async (req, res) => {
  const me = req.userId;
  const b = req.body || {};
  if (b.order !== undefined && !Array.isArray(b.order)) return res.status(400).json({ error: '並びが正しくありません' });
  if (b.hidden !== undefined && !Array.isArray(b.hidden)) return res.status(400).json({ error: '非表示の指定が正しくありません' });
  await ensureBuiltinRows(me);
  if (Array.isArray(b.order)) {
    const ids = b.order.filter(isPackId).slice(0, MAX_MY_PACKS + BUILTIN_PACKS.length);
    for (let i = 0; i < ids.length; i++) {
      await db.run('UPDATE user_sticker_packs SET position = ? WHERE user_id = ? AND pack_id = ?', [i, me, ids[i]]);
    }
  }
  if (Array.isArray(b.hidden)) {
    const hid = new Set(b.hidden.filter(isPackId));
    const all = await db.all('SELECT pack_id FROM user_sticker_packs WHERE user_id = ?', [me]);
    for (const r of all) {
      await db.run('UPDATE user_sticker_packs SET hidden = ? WHERE user_id = ? AND pack_id = ?', [hid.has(r.pack_id) ? 1 : 0, me, r.pack_id]);
    }
  }
  res.json({ ok: true });
}));

router.post('/mine/:packId', verifyToken, asyncHandler(async (req, res) => {
  const me = req.userId;
  const id = req.params.packId;
  if (BUILTIN_PACKS.includes(id)) {
    // 公式パックは「非表示を戻す」だけ
    await ensureBuiltinRows(me);
    await db.run('UPDATE user_sticker_packs SET hidden = 0 WHERE user_id = ? AND pack_id = ?', [me, id]);
    return res.json({ ok: true });
  }
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'スタンプが見つかりません' });
  const p = await db.get('SELECT * FROM sticker_packs WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!p) return res.status(404).json({ error: 'スタンプが見つかりません' });
  const exists = await db.get('SELECT hidden FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?', [me, id]);
  if (exists) {
    await db.run('UPDATE user_sticker_packs SET hidden = 0 WHERE user_id = ? AND pack_id = ?', [me, id]);
    return res.json({ ok: true, pack: await packOut(p, me, true) });
  }
  const cnt = await db.get('SELECT COUNT(*) AS n FROM user_sticker_packs WHERE user_id = ?', [me]);
  if (Number(cnt && cnt.n) >= MAX_MY_PACKS + BUILTIN_PACKS.length) return res.status(400).json({ error: 'マイスタンプがいっぱいです。使わないスタンプを外してください' });
  await db.run('INSERT INTO user_sticker_packs (user_id, pack_id, position, hidden) VALUES (?, ?, ?, 0) ON CONFLICT(user_id, pack_id) DO NOTHING', [me, id, await nextMyPosition(me)]);
  if (p.owner_id !== me) await db.run('UPDATE sticker_packs SET add_count = add_count + 1 WHERE id = ?', [id]);
  res.json({ ok: true, pack: await packOut(p, me, true) });
}));

router.delete('/mine/:packId', verifyToken, asyncHandler(async (req, res) => {
  const me = req.userId;
  const id = req.params.packId;
  if (BUILTIN_PACKS.includes(id)) {
    await ensureBuiltinRows(me);
    await db.run('UPDATE user_sticker_packs SET hidden = 1 WHERE user_id = ? AND pack_id = ?', [me, id]);
    return res.json({ ok: true });
  }
  if (!UUID_RE.test(id)) return res.status(404).json({ error: 'スタンプが見つかりません' });
  const r = await db.run('DELETE FROM user_sticker_packs WHERE user_id = ? AND pack_id = ?', [me, id]);
  if (r.changes) {
    await db.run('UPDATE sticker_packs SET add_count = add_count - 1 WHERE id = ? AND owner_id <> ? AND add_count > 0', [id, me]);
  }
  res.json({ ok: true });
}));

router.put('/favs', verifyToken, asyncHandler(async (req, res) => {
  const me = req.userId;
  const keys = req.body && req.body.keys;
  if (!Array.isArray(keys)) return res.status(400).json({ error: 'keys は配列で指定してください' });
  const list = [];
  for (const k of keys) { if (isStickerKey(k) && !list.includes(k)) list.push(k); if (list.length >= MAX_FAVS) break; }
  await db.run('DELETE FROM user_sticker_favs WHERE user_id = ?', [me]);
  for (let i = 0; i < list.length; i++) {
    await db.run('INSERT INTO user_sticker_favs (user_id, sticker_key, position) VALUES (?, ?, ?)', [me, list[i], i]);
  }
  res.json({ favs: list });
}));

// ---- ショップ(全部無料) ----
router.get('/shop', verifyToken, asyncHandler(async (req, res) => {
  const me = req.userId;
  const q = clean(req.query.q, 40);
  const sort = req.query.sort === 'popular' ? 'popular' : 'new';
  const offset = Math.max(0, Math.min(10000, parseInt(req.query.offset, 10) || 0));
  const limit = 24;
  const where = ['p.deleted_at IS NULL', 'p.is_public = 1',
    'EXISTS (SELECT 1 FROM stickers s WHERE s.pack_id = p.id AND s.deleted_at IS NULL)'];
  const params = [];
  if (q) {
    const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c).toLowerCase() + '%';
    where.push("(LOWER(p.title) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM stickers s2 WHERE s2.pack_id = p.id AND s2.deleted_at IS NULL AND (LOWER(COALESCE(s2.label, '')) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(s2.keywords, '')) LIKE ? ESCAPE '\\')))");
    params.push(like, like, like, like);
  }
  const order = sort === 'popular' ? 'p.add_count DESC, p.created_at DESC' : 'p.created_at DESC';
  const rows = await db.all(`SELECT p.* FROM sticker_packs p WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${limit + 1} OFFSET ${offset}`, params);
  const packs = [];
  for (const p of rows.slice(0, limit)) packs.push(await packOut(p, me, false));
  res.json({ packs, hasMore: rows.length > limit });
}));

router.get('/packs/:id', verifyToken, asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id || '')) return res.status(404).json({ error: 'スタンプが見つかりません' });
  const p = await db.get('SELECT * FROM sticker_packs WHERE id = ?', [req.params.id]);
  if (!p) return res.status(404).json({ error: 'スタンプが見つかりません' });
  res.json(await packOut(p, req.userId, true));
}));

// 自分が作ったパックの一覧(作成画面用)
router.get('/created', verifyToken, asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT * FROM sticker_packs WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', [req.userId]);
  const packs = [];
  for (const p of rows) packs.push(await packOut(p, req.userId, true));
  res.json({ packs });
}));

router.post('/packs', verifyToken, asyncHandler(async (req, res) => {
  const me = req.userId;
  const b = req.body || {};
  const title = clean(b.title, 40);
  if (!title) return res.status(400).json({ error: 'スタンプの名前を入れてください' });
  const cnt = await db.get('SELECT COUNT(*) AS n FROM sticker_packs WHERE owner_id = ? AND deleted_at IS NULL', [me]);
  if (Number(cnt && cnt.n) >= MAX_PACKS_PER_USER) return res.status(400).json({ error: `作れるスタンプは${MAX_PACKS_PER_USER}個までです` });
  const id = uuidv4();
  await db.run('INSERT INTO sticker_packs (id, owner_id, title, description, is_public) VALUES (?, ?, ?, ?, ?)',
    [id, me, title, clean(b.description, 200), b.isPublic === false ? 0 : 1]);
  // 作った人のマイスタンプには最初から入れる
  await db.run('INSERT INTO user_sticker_packs (user_id, pack_id, position, hidden) VALUES (?, ?, ?, 0) ON CONFLICT(user_id, pack_id) DO NOTHING', [me, id, await nextMyPosition(me)]);
  const p = await db.get('SELECT * FROM sticker_packs WHERE id = ?', [id]);
  res.json(await packOut(p, me, true));
}));

router.patch('/packs/:id', verifyToken, asyncHandler(async (req, res) => {
  const p = await ownPack(req, res);
  if (!p) return;
  const b = req.body || {};
  if (b.title !== undefined) {
    const title = clean(b.title, 40);
    if (!title) return res.status(400).json({ error: 'スタンプの名前を入れてください' });
    await db.run('UPDATE sticker_packs SET title = ? WHERE id = ?', [title, p.id]);
  }
  if (b.description !== undefined) await db.run('UPDATE sticker_packs SET description = ? WHERE id = ?', [clean(b.description, 200), p.id]);
  if (b.isPublic !== undefined) await db.run('UPDATE sticker_packs SET is_public = ? WHERE id = ?', [bool(b.isPublic) ? 1 : 0, p.id]);
  if (Array.isArray(b.order)) {
    const ids = b.order.filter(x => typeof x === 'string' && UUID_RE.test(x)).slice(0, MAX_STICKERS_PER_PACK * 2);
    for (let i = 0; i < ids.length; i++) await db.run('UPDATE stickers SET position = ? WHERE id = ? AND pack_id = ?', [i, ids[i], p.id]);
  }
  await db.run('UPDATE sticker_packs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [p.id]);
  res.json(await packOut(await db.get('SELECT * FROM sticker_packs WHERE id = ?', [p.id]), req.userId, true));
}));

router.delete('/packs/:id', verifyToken, asyncHandler(async (req, res) => {
  const p = await ownPack(req, res);
  if (!p) return;
  // 画像は残す(もう送ったトークの中のスタンプは見えたままにする)。ショップ・マイスタンプからは消える
  await db.run('UPDATE sticker_packs SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [p.id]);
  await db.run('DELETE FROM user_sticker_packs WHERE pack_id = ?', [p.id]);
  res.json({ ok: true });
}));

router.post('/packs/:id/stickers', verifyToken, uploadLimiter, asyncHandler(async (req, res) => {
  const p = await ownPack(req, res);
  if (!p) return;
  const b = req.body || {};
  const parsed = parseDataUrl(b.dataUrl);
  if (!parsed || parsed.buf.length > MAX_STICKER_BYTES) return res.status(400).json({ error: '画像の形式またはサイズが正しくありません(png/jpeg/webp/gif、800KBまで)' });
  const cnt = await db.get('SELECT COUNT(*) AS n, MAX(position) AS m FROM stickers WHERE pack_id = ? AND deleted_at IS NULL', [p.id]);
  if (Number(cnt && cnt.n) >= MAX_STICKERS_PER_PACK) return res.status(400).json({ error: `1つのスタンプに入れられるのは${MAX_STICKERS_PER_PACK}個までです` });
  const url = await storeIcon(parsed.buf, parsed.mime, baseUrl(req), { folder: 'brochat/stickers', size: 320 });
  const id = uuidv4();
  const animated = parsed.mime === 'image/gif' || (parsed.mime === 'image/webp' && parsed.buf.includes(Buffer.from('ANIM'))) ? 1 : 0;
  await db.run('INSERT INTO stickers (id, pack_id, owner_id, position, image_url, label, keywords, animated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, p.id, p.owner_id, (cnt && cnt.m != null ? Number(cnt.m) : -1) + 1, url, clean(b.label, 20), JSON.stringify(cleanKeywords(b.keywords)), animated]);
  await db.run('UPDATE sticker_packs SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [p.id]);
  res.json(stickerOut(await db.get('SELECT * FROM stickers WHERE id = ?', [id])));
}));

router.patch('/packs/:id/stickers/:sid', verifyToken, asyncHandler(async (req, res) => {
  const p = await ownPack(req, res);
  if (!p) return;
  const s = await db.get('SELECT * FROM stickers WHERE id = ? AND pack_id = ? AND deleted_at IS NULL', [req.params.sid, p.id]);
  if (!s) return res.status(404).json({ error: 'スタンプが見つかりません' });
  const b = req.body || {};
  if (b.label !== undefined) await db.run('UPDATE stickers SET label = ? WHERE id = ?', [clean(b.label, 20), s.id]);
  if (b.keywords !== undefined) await db.run('UPDATE stickers SET keywords = ? WHERE id = ?', [JSON.stringify(cleanKeywords(b.keywords)), s.id]);
  res.json(stickerOut(await db.get('SELECT * FROM stickers WHERE id = ?', [s.id])));
}));

router.delete('/packs/:id/stickers/:sid', verifyToken, asyncHandler(async (req, res) => {
  const p = await ownPack(req, res);
  if (!p) return;
  const r = await db.run('UPDATE stickers SET deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND pack_id = ? AND deleted_at IS NULL', [req.params.sid, p.id]);
  if (!r.changes) return res.status(404).json({ error: 'スタンプが見つかりません' });
  res.json({ ok: true });
}));

// 届いたスタンプの画像を引く(消されたパック・スタンプでも、送られた物は表示できるように返す)
router.get('/s', verifyToken, asyncHandler(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(x => UUID_RE.test(x)).slice(0, 60);
  if (!ids.length) return res.json({ stickers: [] });
  const rows = await db.all(`SELECT * FROM stickers WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  res.set('Cache-Control', 'private, max-age=300');
  res.json({ stickers: rows.map(stickerOut) });
}));

module.exports = router;
