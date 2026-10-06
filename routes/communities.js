// routes/communities.js
// コミュニティ機能 — Discordライクなサーバー/チャンネル構造
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { rejectIfProfane, censorBodyAndBanAfter } = require('../utils/moderation');
const { sendServerError } = require('../utils/errorResponse');
const { messageSendLimiter } = require('../utils/rateLimits');

const router = express.Router();

// 鍵の配布データの形(グループと同じ)。中身はクライアントが暗号化した塊で、サーバーは読めない
function isEncKeyEntry(e) {
  return e && typeof e.userId === 'string' && e.userId.length <= 100
    && typeof e.encryptedKey === 'string' && e.encryptedKey.length > 20 && e.encryptedKey.length <= 8000;
}
async function isMember(communityId, userId) {
  const r = await db.get('SELECT 1 AS ok FROM community_members WHERE community_id = ? AND user_id = ?', [communityId, userId]);
  return !!r;
}

// コミュニティのメッセージは平文でDBに入る。長さもメディアのURLも見ていなかったため、
// 1通4MBの本文を連投するだけで無料プランのDB(1GB)を埋められたし、mediaUrlに好きなURLを
// 置いて、見た人の端末をそこへアクセスさせられた(IPや閲覧時刻の収集)。
const MAX_COMMUNITY_TEXT = 2000;
function isValidCommunityMediaUrl(value) {
  if (!value) return true;
  if (typeof value !== 'string' || value.length > 500) return false;
  return /^https:\/\/res\.cloudinary\.com\/[a-zA-Z0-9_\-./,]+$/.test(value);
}

// 招待コードの総当たり対策: 参加の試行はユーザー単位で15分に20回まで
const joinLimiter = require('express-rate-limit')({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'u:' + req.user.userId,
  message: { error: '試行が多すぎます。しばらくしてからお試しください。' },
});

// 招待コード生成(6文字英数字)
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  // Math.random は暗号用ではなく、作った招待コードから続きを予測されうる。暗号用乱数で10文字にする
  // (既存の6文字のコードはそのまま使える)
  const bytes = require('crypto').randomBytes(10);
  let code = '';
  for (let i = 0; i < 10; i++) code += chars[bytes[i] % chars.length];
  return code;
}

// --- コミュニティ作成 ---
router.post('/', verifyToken, asyncHandler(async (req, res) => {
  const { name, description } = req.body;
  if (await rejectIfProfane(req, res, name, description)) return;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return res.status(400).json({ error: 'コミュニティ名は必須です' });
  }
  if (name.length > 50) {
    return res.status(400).json({ error: 'コミュニティ名は50文字以内にしてください' });
  }
  if (description != null && (typeof description !== 'string' || description.length > 500)) {
    return res.status(400).json({ error: '説明は500文字以内にしてください' });
  }

  // 作成者の端末が作ったコミュニティ鍵(自分宛に暗号化済み)。
  // 古い版のアプリから来た場合は鍵が無く、その時は平文のコミュニティとして動く。
  const myKey = req.body && req.body.encryptedKeyForSelf;
  if (myKey != null && (typeof myKey !== 'string' || myKey.length < 20 || myKey.length > 8000)) {
    return res.status(400).json({ error: '鍵の形式が正しくありません' });
  }

  const id = uuidv4();
  const inviteCode = generateInviteCode();
  await db.run(
    'INSERT INTO communities (id, name, description, owner_id, invite_code, key_version) VALUES (?, ?, ?, ?, ?, 1)',
    [id, name.trim(), description || null, req.user.userId, inviteCode]
  );
  if (myKey) {
    await db.run(
      'INSERT INTO community_key_distributions (id, community_id, user_id, key_version, encrypted_key) VALUES (?, ?, ?, 1, ?)',
      [uuidv4(), id, req.user.userId, myKey]
    );
  }

  // オーナーを admin ロールで追加
  await db.run(
    'INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, ?)',
    [id, req.user.userId, 'admin']
  );

  // デフォルトチャンネル「一般」を作成
  const channelId = uuidv4();
  await db.run(
    'INSERT INTO community_channels (id, community_id, name, sort_order) VALUES (?, ?, ?, 0)',
    [channelId, id, '一般']
  );

  res.json({ ok: true, community: { id, name: name.trim(), description, inviteCode, channelId, keyVersion: 1, encrypted: !!myKey } });
}));

// --- 自分が参加しているコミュニティ一覧 ---
router.get('/list', verifyToken, asyncHandler(async (req, res) => {
  const communities = await db.all(
    `SELECT c.id, c.name, c.description, c.icon_url, c.owner_id, c.invite_code, cm.role,
            (SELECT COUNT(*) FROM community_members WHERE community_id = c.id) as member_count
     FROM communities c
     JOIN community_members cm ON cm.community_id = c.id AND cm.user_id = ?
     ORDER BY cm.joined_at DESC`,
    [req.user.userId]
  );
  res.json({ ok: true, communities });
}));

// --- 招待コードでコミュニティに参加 ---
router.post('/join', verifyToken, joinLimiter, asyncHandler(async (req, res) => {
  const { inviteCode } = req.body || {};
  if (!inviteCode || typeof inviteCode !== 'string' || inviteCode.length > 32) return res.status(400).json({ error: '招待コードが必要です' });

  const community = await db.get('SELECT * FROM communities WHERE invite_code = ?', [inviteCode]);
  if (!community) return res.status(404).json({ error: '招待コードが無効です' });

  const existing = await db.get(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?',
    [community.id, req.user.userId]
  );
  if (existing) return res.json({ ok: true, already: true, communityId: community.id, name: community.name });

  await db.run(
    'INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, ?)',
    [community.id, req.user.userId, 'member']
  );

  res.json({ ok: true, communityId: community.id, name: community.name });
}));

// 鍵をまだ持っていないメンバーがいるコミュニティ(自分が今の鍵を配れる物だけ)
router.get('/pending-keys', verifyToken, asyncHandler(async (req, res) => {
  const mine = await db.all(
    `SELECT c.id, c.key_version
       FROM communities c
       JOIN community_members m ON m.community_id = c.id AND m.user_id = ?
       JOIN community_key_distributions d ON d.community_id = c.id AND d.user_id = ? AND d.key_version = c.key_version`,
    [req.user.userId, req.user.userId]
  );
  const communities = [];
  for (const c of mine) {
    const rows = await db.all(
      `SELECT m.user_id FROM community_members m
        WHERE m.community_id = ?
          AND NOT EXISTS (SELECT 1 FROM community_key_distributions d
                           WHERE d.community_id = m.community_id AND d.user_id = m.user_id AND d.key_version = ?)
        LIMIT 100`,
      [c.id, c.key_version]
    );
    if (rows.length) communities.push({ communityId: c.id, keyVersion: c.key_version, userIds: rows.map(r => r.user_id) });
  }
  res.json({ communities });
}));

// --- コミュニティ詳細(チャンネル一覧含む) ---
router.get('/:id', verifyToken, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'このコミュニティのメンバーではありません' });

  const community = await db.get('SELECT * FROM communities WHERE id = ?', [req.params.id]);
  if (!community) return res.status(404).json({ error: 'コミュニティが見つかりません' });

  const channels = await db.all(
    'SELECT id, name, sort_order FROM community_channels WHERE community_id = ? ORDER BY sort_order',
    [req.params.id]
  );

  const members = await db.all(
    `SELECT u.id, u.display_name, u.profile_pic, cm.role, cm.joined_at
     FROM community_members cm
     JOIN users u ON u.id = cm.user_id
     WHERE cm.community_id = ?
     ORDER BY cm.role DESC, cm.joined_at`,
    [req.params.id]
  );

  res.json({
    ok: true,
    community: {
      id: community.id,
      name: community.name,
      description: community.description,
      iconUrl: community.icon_url,
      ownerId: community.owner_id,
      inviteCode: community.invite_code,
      myRole: member.role,
      keyVersion: community.key_version || 1,
    },
    channels,
    members,
  });
}));

// --- チャンネルのメッセージ履歴 ---
router.get('/:id/channels/:channelId/messages', verifyToken, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'メンバーではありません' });
  // channelId が、メンバー確認をしたコミュニティのものかも確認する。
  // 無いと、自分のコミュニティIDに他コミュニティのchannelIdを組み合わせるだけで、
  // 参加していないコミュニティの会話を読めてしまう。
  const channel = await db.get('SELECT id FROM community_channels WHERE id = ? AND community_id = ?', [req.params.channelId, req.params.id]);
  if (!channel) return res.status(404).json({ error: 'チャンネルが見つかりません' });

  const before = req.query.before;
  let query = `SELECT m.id, m.channel_id, m.sender_id, m.content, m.media_url, m.media_type,
                      m.created_at, m.edited_at, m.encrypted, m.key_version,
                      u.display_name as sender_name, u.profile_pic as sender_pic
               FROM community_messages m
               JOIN users u ON u.id = m.sender_id
               WHERE m.channel_id = ? AND m.deleted_at IS NULL`;
  const params = [req.params.channelId];

  if (before) {
    query += ' AND m.created_at < ?';
    params.push(before);
  }
  query += ' ORDER BY m.created_at DESC LIMIT 50';

  const messages = await db.all(query, params);
  res.json({ ok: true, messages: messages.reverse() });
}));

// --- チャンネルにメッセージ送信 ---
router.post('/:id/channels/:channelId/messages', verifyToken, messageSendLimiter, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member) return res.status(403).json({ error: 'メンバーではありません' });
  const channel = await db.get('SELECT id FROM community_channels WHERE id = ? AND community_id = ?', [req.params.channelId, req.params.id]);
  if (!channel) return res.status(404).json({ error: 'チャンネルが見つかりません' });

  // 暗号化されている時はサーバーから中身が見えないので、禁止語は送る側の端末が調べる
  // (個人チャット・グループと同じやり方。public/js/profanity.js)
  if (!req.body?.encrypted) censorBodyAndBanAfter(req, res, ['content']);
  const { content, mediaUrl, mediaType, encrypted, keyVersion } = req.body || {};
  if ((content != null && typeof content !== 'string') || (mediaUrl != null && typeof mediaUrl !== 'string')) {
    return res.status(400).json({ error: '入力の形式が正しくありません' });
  }
  if (!content && !mediaUrl) return res.status(400).json({ error: 'メッセージが必要です' });
  if (content && content.length > MAX_COMMUNITY_TEXT) {
    return res.status(400).json({ error: `メッセージは${MAX_COMMUNITY_TEXT}文字以内にしてください` });
  }
  if (!isValidCommunityMediaUrl(mediaUrl)) return res.status(400).json({ error: 'メディアの形式が不正です' });
  if (mediaUrl && !['image', 'video'].includes(mediaType)) return res.status(400).json({ error: 'mediaTypeが不正です' });

  const community = await db.get('SELECT key_version FROM communities WHERE id = ?', [req.params.id]);
  const curVer = (community && community.key_version) || 1;
  const kv = (Number.isInteger(keyVersion) && keyVersion >= 1 && keyVersion <= curVer) ? keyVersion : curVer;

  const id = uuidv4();
  await db.run(
    'INSERT INTO community_messages (id, channel_id, sender_id, content, media_url, media_type, encrypted, key_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [id, req.params.channelId, req.user.userId, content || '', mediaUrl || null, mediaUrl ? mediaType : null, !!encrypted, encrypted ? kv : null]
  );

  const msg = await db.get(
    `SELECT m.id, m.channel_id, m.sender_id, m.content, m.media_url, m.media_type,
            m.created_at, m.edited_at, m.encrypted, m.key_version,
            u.display_name as sender_name, u.profile_pic as sender_pic
     FROM community_messages m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
    [id]
  );
  res.json({ ok: true, message: msg });
}));

// --- チャンネル追加(admin/ownerのみ) ---
router.post('/:id/channels', verifyToken, asyncHandler(async (req, res) => {
  const member = await db.get(
    'SELECT role FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  if (!member || member.role !== 'admin') return res.status(403).json({ error: '管理者のみチャンネルを作成できます' });

  const { name } = req.body;
  if (await rejectIfProfane(req, res, name)) return;
  if (!name || name.length > 30) return res.status(400).json({ error: 'チャンネル名は1-30文字で入力してください' });

  const maxSort = await db.get(
    'SELECT MAX(sort_order) as mx FROM community_channels WHERE community_id = ?',
    [req.params.id]
  );
  const id = uuidv4();
  await db.run(
    'INSERT INTO community_channels (id, community_id, name, sort_order) VALUES (?, ?, ?, ?)',
    [id, req.params.id, name.trim(), (maxSort?.mx || 0) + 1]
  );

  res.json({ ok: true, channel: { id, name: name.trim() } });
}));

// --- コミュニティ退出 ---
router.post('/:id/leave', verifyToken, asyncHandler(async (req, res) => {
  const community = await db.get('SELECT owner_id FROM communities WHERE id = ?', [req.params.id]);
  if (!community) return res.status(404).json({ error: 'コミュニティが見つかりません' });
  if (community.owner_id === req.user.userId) {
    return res.status(400).json({ error: 'オーナーは退出できません。コミュニティを削除してください' });
  }

  await db.run(
    'DELETE FROM community_members WHERE community_id = ? AND user_id = ?',
    [req.params.id, req.user.userId]
  );
  // 抜けた人は今の鍵を持っているので、印を付けて、次に誰かが開いた時に作り直させる
  // (グループの「member_left」と同じ考え方)
  try { await db.run('UPDATE communities SET rekey_needed = ? WHERE id = ?', [true, req.params.id]); } catch (e) {}
  res.json({ ok: true, rekeyNeeded: true });
}));

// =====================================================================
// コミュニティのE2E暗号化の鍵のやり取り。
// 仕組みはグループ(routes/groups.js)と同じで、共有鍵をメンバーごとにX3DHで
// 暗号化した塊だけがサーバーに置かれる。サーバーは鍵もメッセージも読めない。
//
// 参加した人には現行の鍵をそのまま配る(= 参加前の投稿も読める)。
// コミュニティは「入れば過去ログが読める場所」なので、そこは仕様としてこうする。
// 抜けた人に以後の投稿を読ませないために、退出が起きたら鍵を作り直す。
// =====================================================================

// 自分宛の鍵。version指定で過去の版も取れる(古いメッセージの復号用)
router.get('/:id/my-key', verifyToken, asyncHandler(async (req, res) => {
  if (!(await isMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'このコミュニティのメンバーではありません' });
  }
  const wantVer = parseInt(req.query.version, 10);
  const row = Number.isInteger(wantVer)
    ? await db.get('SELECT * FROM community_key_distributions WHERE community_id=? AND user_id=? AND key_version=? LIMIT 1',
        [req.params.id, req.user.userId, wantVer])
    : await db.get('SELECT * FROM community_key_distributions WHERE community_id=? AND user_id=? ORDER BY key_version DESC LIMIT 1',
        [req.params.id, req.user.userId]);
  if (!row) return res.status(404).json({ error: '鍵が見つかりません' });
  res.json({ keyVersion: row.key_version, encryptedKey: row.encrypted_key });
}));

// 今の版の鍵を、残っているメンバーの誰かが持っているか
router.get('/:id/key-status', verifyToken, asyncHandler(async (req, res) => {
  if (!(await isMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'このコミュニティのメンバーではありません' });
  }
  const c = await db.get('SELECT key_version, rekey_needed FROM communities WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'コミュニティが見つかりません' });
  const ver = c.key_version || 1;
  const holder = await db.get(
    `SELECT 1 AS ok FROM community_key_distributions d
       JOIN community_members m ON m.community_id = d.community_id AND m.user_id = d.user_id
      WHERE d.community_id = ? AND d.key_version = ? LIMIT 1`,
    [req.params.id, ver]
  );
  res.json({ keyVersion: ver, orphaned: !holder, rekeyNeeded: !!c.rekey_needed });
}));

// 今の鍵を持っている人が、まだ持っていない人へ配る(上書きはできない)
router.post('/:id/distribute-keys', verifyToken, asyncHandler(async (req, res) => {
  const { keyVersion, encryptedKeysForMembers } = req.body || {};
  const c = await db.get('SELECT key_version FROM communities WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'コミュニティが見つかりません' });
  if (!(await isMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'このコミュニティのメンバーではありません' });
  }
  const ver = c.key_version || 1;
  if (Number(keyVersion) !== ver) return res.status(409).json({ error: '鍵のバージョンが古くなっています', keyVersion: ver });
  const holds = await db.get('SELECT 1 FROM community_key_distributions WHERE community_id=? AND user_id=? AND key_version=?',
    [req.params.id, req.user.userId, ver]);
  if (!holds) return res.status(403).json({ error: 'このコミュニティの現在の鍵を持っていません' });
  if (!Array.isArray(encryptedKeysForMembers)) return res.status(400).json({ error: '配布データが不正です' });

  let delivered = 0;
  for (const entry of encryptedKeysForMembers.slice(0, 100)) {
    if (!isEncKeyEntry(entry)) continue;
    if (!(await isMember(req.params.id, entry.userId))) continue;
    const exists = await db.get('SELECT 1 FROM community_key_distributions WHERE community_id=? AND user_id=? AND key_version=?',
      [req.params.id, entry.userId, ver]);
    if (exists) continue;
    await db.run('INSERT INTO community_key_distributions (id, community_id, user_id, key_version, encrypted_key) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), req.params.id, entry.userId, ver, entry.encryptedKey]);
    delivered++;
  }
  res.json({ ok: true, delivered, keyVersion: ver });
}));

// 鍵の作り直し。誰かが抜けた後や、誰も今の鍵を読めなくなった時にメンバーの端末が呼ぶ
router.post('/:id/rotate-key', verifyToken, asyncHandler(async (req, res) => {
  const { expectedVersion, encryptedKeysForMembers } = req.body || {};
  const c = await db.get('SELECT key_version FROM communities WHERE id = ?', [req.params.id]);
  if (!c) return res.status(404).json({ error: 'コミュニティが見つかりません' });
  if (!(await isMember(req.params.id, req.user.userId))) {
    return res.status(403).json({ error: 'このコミュニティのメンバーではありません' });
  }
  const ver = c.key_version || 1;
  if (Number(expectedVersion) !== ver) {
    return res.status(409).json({ error: '鍵のバージョンが変わっています。開き直してください', keyVersion: ver });
  }
  if (!Array.isArray(encryptedKeysForMembers) || !encryptedKeysForMembers.length) {
    return res.status(400).json({ error: '配布データが不正です' });
  }
  if (!encryptedKeysForMembers.some(e => isEncKeyEntry(e) && e.userId === req.user.userId)) {
    return res.status(400).json({ error: '自分宛の鍵が含まれていません' });
  }

  const newVersion = ver + 1;
  await db.run('UPDATE communities SET key_version = ? WHERE id = ? AND key_version = ?', [newVersion, req.params.id, ver]);
  const again = await db.get('SELECT key_version FROM communities WHERE id = ?', [req.params.id]);
  if (!again || again.key_version !== newVersion) {
    return res.status(409).json({ error: '鍵のバージョンが変わっています。開き直してください' });
  }

  let delivered = 0;
  for (const entry of encryptedKeysForMembers.slice(0, 100)) {
    if (!isEncKeyEntry(entry)) continue;
    if (!(await isMember(req.params.id, entry.userId))) continue;
    await db.run('INSERT INTO community_key_distributions (id, community_id, user_id, key_version, encrypted_key) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), req.params.id, entry.userId, newVersion, entry.encryptedKey]);
    delivered++;
  }
  try { await db.run('UPDATE communities SET rekey_needed = ? WHERE id = ?', [false, req.params.id]); } catch (e) {}
  res.json({ ok: true, keyVersion: newVersion, delivered });
}));

module.exports = router;
