// routes/groups.js
// グループ作成・招待・削除 + キー・ラチェット(鍵更新)のトリガー
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { broadcastToUser } = require('../ws/wsServer');
const { asyncHandler } = require('../utils/asyncHandler');
const { validateMessageInput } = require('../utils/messageContent');
const { rejectIfProfane, censorBodyAndBanAfter } = require('../utils/moderation');
const { messageSendLimiter } = require('../utils/rateLimits');
const { isValidIconUrl } = require('../utils/iconStore');
const { areFriends, isBlockedEither } = require('../utils/relations');

// 暗号化済みグループ鍵1件の上限(X3DHで包んだ32バイト鍵なら数百文字。巨大な値でDBを埋めさせない)
const MAX_ENC_KEY_LENGTH = 8192;
const isEncKeyEntry = (e) => !!e && typeof e.userId === 'string' && typeof e.encryptedGroupKey === 'string'
  && e.encryptedGroupKey.length > 0 && e.encryptedGroupKey.length <= MAX_ENC_KEY_LENGTH;


const router = express.Router();

// 指定ユーザーがそのグループの現メンバーかどうかを確認する共通ヘルパー。
// これが無いと、groupIdとmsgIdさえ知っていれば部外者でも
// メッセージの閲覧・送信・既読・ピン留めができてしまう重大な権限バグになる。
async function isGroupMember(groupId, userId) {
  const row = await db.get(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
    [groupId, userId]
  );
  return !!row;
}

// --- 自分が所属するグループ一覧を取得 ---
router.get('/list', verifyToken, asyncHandler(async (req, res) => {
  const rows = await db.all(
    `SELECT g.id, g.name, g.owner_id, g.key_version, g.created_at, g.avatar_url, gm.joined_at, gm.last_read_at
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id
     WHERE gm.user_id = ? AND gm.left_at IS NULL
     ORDER BY g.created_at DESC`,
    [req.user.userId]
  );
  const groups = [];
  for (const g of rows) {
    const members = await db.all(
      `SELECT u.id as user_id, u.display_name, u.profile_pic
       FROM group_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = ? AND gm.left_at IS NULL`,
      [g.id]
    );
    // 参加前のメッセージは一覧にも出さない(履歴と同じ)
    const since = g.joined_at || null;
    const lastMsg = await db.get(
      `SELECT content, created_at, encrypted, key_version FROM group_messages
       WHERE group_id = ? AND deleted_at IS NULL${since ? ' AND created_at >= ?' : ''}
       ORDER BY created_at DESC LIMIT 1`,
      since ? [g.id, since] : [g.id]
    );
    // 未読数: 最後に開いた時(まだ開いていなければ参加した時)より後に、他の人が送った分
    const from = g.last_read_at || g.joined_at || null;
    let unreadCount = 0;
    if (from) {
      const u = await db.get(
        'SELECT COUNT(*) AS c FROM group_messages WHERE group_id = ? AND sender_id != ? AND deleted_at IS NULL AND created_at > ?',
        [g.id, req.user.userId, from]
      );
      unreadCount = Number(u && u.c) || 0;
    }
    groups.push({
      groupId: g.id,
      name: g.name,
      ownerId: g.owner_id,
      isOwner: g.owner_id === req.user.userId,
      keyVersion: g.key_version,
      avatarUrl: g.avatar_url || null,
      members: members.map(m => ({ userId: m.user_id, displayName: m.display_name, profilePic: m.profile_pic })),
      lastMessage: lastMsg ? { content: lastMsg.content, createdAt: lastMsg.created_at, encrypted: !!lastMsg.encrypted, keyVersion: lastMsg.key_version } : null,
      unreadCount,
    });
  }
  // 新しいメッセージがあったグループを上に(LINEと同じ。以前は作った順のままだった)
  const t = g => new Date((g.lastMessage && g.lastMessage.createdAt) || 0).getTime();
  groups.sort((a, b) => t(b) - t(a));
  res.json({ groups });
}));

// --- グループ作成 ---
// body: { name, memberIds: [userId, ...] } (memberIdsは作成者以外の初期メンバー)
router.post('/create', verifyToken, asyncHandler(async (req, res) => {
  const { name, memberIds, encryptedKeysForMembers } = req.body;
  if (await rejectIfProfane(req, res, name)) return;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'グループ名が必要です' });
  if (memberIds != null && (!Array.isArray(memberIds) || memberIds.length > 200)) {
    return res.status(400).json({ error: 'メンバーの指定が正しくありません' });
  }
  // 表示崩壊・DB肥大化防止のため上限を設ける(display_nameと同基準)
  if (name.length > 50) return res.status(400).json({ error: 'グループ名は50文字以内にしてください' });

  const groupId = uuidv4();
  await db.run('INSERT INTO groups (id, name, owner_id, key_version) VALUES (?, ?, ?, 1)', [groupId, name, req.user.userId]);
  await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, req.user.userId]);

  const addedMembers = [req.user.userId];
  if (Array.isArray(memberIds)) {
    for (const uid of memberIds) {
      if (typeof uid !== 'string' || uid === req.user.userId) continue; // 作成者は既に追加済み
      // 本人の同意なしに知らない人をグループへ入れられないよう、友だちだけ追加できる
      if (!(await areFriends(req.user.userId, uid))) continue;
      // ブロックしている/されている相手は入れない(ブロックされた人がグループを作って相手に連絡できてしまう)
      if (await isBlockedEither(req.user.userId, uid)) continue;
      const already = await db.get('SELECT * FROM group_members WHERE group_id=? AND user_id=?', [groupId, uid]);
      if (already) continue;
      await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, uid]);
      addedMembers.push(uid);
      broadcastToUser(uid, { type: 'added_to_group', groupId, name });
    }
  }

  // クライアントが生成した初期グループ鍵(全メンバー分、X3DHで個別暗号化済み)を保存
  if (Array.isArray(encryptedKeysForMembers)) {
    for (const entry of encryptedKeysForMembers) {
      if (!isEncKeyEntry(entry) || !addedMembers.includes(entry.userId)) continue; // メンバー以外宛の鍵は保存しない
      await db.run(
        'INSERT INTO group_key_distributions (id, group_id, user_id, key_version, encrypted_group_key) VALUES (?, ?, ?, 1, ?)',
        [uuidv4(), groupId, entry.userId, entry.encryptedGroupKey]
      );
    }
  }

  res.json({ groupId, name, keyVersion: 1, members: addedMembers });
}));

// --- メンバー招待 ---
// クライアント側が新グループ鍵を生成し、暗号化した鍵を全メンバー分アップロードする想定。
// body: { groupId, targetUserId | targetUsername(=ユーザーIDコード), encryptedKeysForMembers: [{userId, encryptedGroupKey}] }
router.post('/invite', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, targetUserId, targetUsername, encryptedKeysForMembers } = req.body || {};
  if (typeof groupId !== 'string') return res.status(400).json({ error: 'グループが見つかりません' });

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });

  // 呼び出し元がこのグループの現メンバーかどうかのチェック。
  // これが無いと、groupIdさえ知っていれば部外者でも勝手に他人をグループへ
  // 追加でき、しかも鍵ローテーション(key_version更新)まで引き起こせてしまう
  // 重大な権限バグになる。
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  // 招待できるのは自分の友だちだけ(同意の無い追加を防ぐ)。
  // 以前はメールアドレス(username)で引いていたため、「そのユーザーは見つかりません」の出し分けで
  // 好きなメールアドレスが登録済みかどうかを調べられた。しかも画面はユーザーIDコードを送っており、
  // メールで引く仕様と食い違って招待自体が通らなかった。
  // 存在しない・友だちでない、はどちらも同じ応答にする。
  let targetUser = null;
  if (typeof targetUserId === 'string' && targetUserId) {
    targetUser = await db.get('SELECT id FROM users WHERE id = ?', [targetUserId]);
  } else if (typeof targetUsername === 'string' && targetUsername) {
    targetUser = await db.get('SELECT id FROM users WHERE user_id = ?', [targetUsername.trim()]);
  }
  if (!targetUser || !(await areFriends(req.user.userId, targetUser.id)) || await isBlockedEither(req.user.userId, targetUser.id)) {
    return res.status(404).json({ error: '招待できるのは友だちだけです' });
  }

  const already = await db.get('SELECT * FROM group_members WHERE group_id=? AND user_id=? AND left_at IS NULL', [groupId, targetUser.id]);
  if (already) return res.status(409).json({ error: 'すでにメンバーです' });

  // 鍵ラチェット: バージョンを上げる (前方秘匿性 - 新メンバーは過去メッセージを読めない)
  const newVersion = group.key_version + 1;
  await db.run('UPDATE groups SET key_version = ? WHERE id = ?', [newVersion, groupId]);
  // 前に抜けた(外された)人を招待し直す時は、行が残っているので INSERT すると主キーが重複して失敗していた
  const formerRow = await db.get('SELECT 1 AS ok FROM group_members WHERE group_id=? AND user_id=?', [groupId, targetUser.id]);
  if (formerRow) {
    await db.run('UPDATE group_members SET left_at = NULL, joined_at = CURRENT_TIMESTAMP WHERE group_id = ? AND user_id = ?', [groupId, targetUser.id]);
  } else {
    await db.run('INSERT INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, targetUser.id]);
  }

  // クライアントが生成した「メンバーごとに暗号化した新グループ鍵」を保存・配布
  if (Array.isArray(encryptedKeysForMembers)) {
    for (const entry of encryptedKeysForMembers) {
      // メンバー以外宛の鍵を保存したり、無関係な人へ通知を飛ばしたりさせない
      if (!isEncKeyEntry(entry)) continue;
      if (!(await isGroupMember(groupId, entry.userId))) continue;
      await db.run(
        'INSERT INTO group_key_distributions (id, group_id, user_id, key_version, encrypted_group_key) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), groupId, entry.userId, newVersion, entry.encryptedGroupKey]
      );
      broadcastToUser(entry.userId, {
        type: 'group_key_rotated',
        groupId,
        keyVersion: newVersion,
        reason: 'member_joined',
      });
    }
  }

  res.json({ ok: true, groupId, keyVersion: newVersion, invitedUserId: targetUser.id });
}));

// --- メンバー削除・脱退 ---
// 脱退が確定した瞬間に鍵を更新 (後方秘匿性 - 抜けた人は以後のメッセージを読めない)
// body: { groupId, removeUserId, encryptedKeysForRemainingMembers: [{userId, encryptedGroupKey}] }
router.post('/remove-member', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, removeUserId, encryptedKeysForRemainingMembers } = req.body;

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });

  // 権限チェック: オーナー本人による削除、または本人による自主脱退のみ許可する。
  // (このチェックが無いと、メンバーであれば誰でも他人を削除できてしまう
  //  重大な権限バグになるため必須)
  if (!removeUserId || typeof removeUserId !== 'string') {
    return res.status(400).json({ error: 'removeUserId が必要です' });
  }
  // 対象が現役メンバーでない場合は何もしない。以前は素通りして鍵の版だけが上がり、
  // 新しい版の鍵が誰にも配られず、以降のメッセージが全員復号できなくなっていた。
  const target = await db.get(
    'SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL',
    [groupId, removeUserId]
  );
  if (!target) return res.status(404).json({ error: '対象のメンバーが見つかりません' });

  const isOwner = group.owner_id === req.user.userId;
  const isSelfLeaving = removeUserId === req.user.userId;
  if (!isOwner && !isSelfLeaving) {
    return res.status(403).json({ error: 'メンバーを削除する権限がありません' });
  }
  // オーナー自身の脱退は、グループが空になり誰も管理できなくなるため禁止
  if (isSelfLeaving && group.owner_id === removeUserId) {
    return res.status(400).json({ error: 'オーナーはグループから脱退できません。グループを削除するか、オーナー権限を譲渡してください' });
  }

  await db.run(
    'UPDATE group_members SET left_at = CURRENT_TIMESTAMP WHERE group_id = ? AND user_id = ?',
    [groupId, removeUserId]
  );

  const newVersion = group.key_version + 1;
  await db.run('UPDATE groups SET key_version = ? WHERE id = ?', [newVersion, groupId]);

  // 自分で抜ける人が作った「新しい鍵」は受け取らない。作った本人が中身を知っているので、
  // それを残りのメンバーに配ると、抜けた後のメッセージも読める鍵を握らせることになる。
  // この場合は新しい版の鍵が誰にも無い状態になり、残ったメンバーの端末が自動で作り直す(key-status)。
  if (!isSelfLeaving && Array.isArray(encryptedKeysForRemainingMembers)) {
    for (const entry of encryptedKeysForRemainingMembers) {
      // 抜けた本人や部外者宛の新しい鍵は保存しない(抜けた人が以後のメッセージを読めてしまう)
      if (!isEncKeyEntry(entry) || entry.userId === removeUserId) continue;
      if (!(await isGroupMember(groupId, entry.userId))) continue;
      await db.run(
        'INSERT INTO group_key_distributions (id, group_id, user_id, key_version, encrypted_group_key) VALUES (?, ?, ?, ?, ?)',
        [uuidv4(), groupId, entry.userId, newVersion, entry.encryptedGroupKey]
      );
      broadcastToUser(entry.userId, {
        type: 'group_key_rotated',
        groupId,
        keyVersion: newVersion,
        reason: 'member_left',
      });
    }
  }

  broadcastToUser(removeUserId, { type: 'removed_from_group', groupId });
  // グループ通話に入っていたら、そこからも外す
  try { require('../ws/wsServer').kickFromGroupCall(groupId, removeUserId); require('../ws/wsServer').kickFromLive(groupId, removeUserId); } catch (_) {}
  if (isSelfLeaving) {
    // 新しい鍵が誰にも無いので、開いている残りのメンバーに作り直してもらう
    const rest = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
    rest.forEach(m => broadcastToUser(m.user_id, { type: 'group_key_rotated', groupId, keyVersion: newVersion, reason: 'member_left' }));
  }

  res.json({ ok: true, groupId, keyVersion: newVersion });
}));

// --- グループアイコン設定 ---
// body: { url } (先に POST /api/icons でアップロードして得たURL。空文字で削除)
router.post('/:groupId/icon', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { url } = req.body || {};
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  if (url && !isValidIconUrl(url, req)) return res.status(400).json({ error: 'アイコンのURLが不正です' });
  await db.run('UPDATE groups SET avatar_url = ? WHERE id = ?', [url || null, groupId]);
  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  for (const m of members) {
    if (m.user_id !== req.user.userId) broadcastToUser(m.user_id, { type: 'group_updated', groupId });
  }
  res.json({ ok: true, avatarUrl: url || null });
}));

// --- 現行バージョンの鍵をまだ受け取っていないメンバーがいるグループ一覧 ---
// 自分がその現行鍵を持っている(=配れる)グループだけを返す。
// 暗号鍵をまだ作っていないメンバーがいても先にグループを作れるようにするための仕組み。
router.get('/pending-keys', verifyToken, asyncHandler(async (req, res) => {
  const mine = await db.all(
    `SELECT g.id, g.key_version
     FROM groups g
     JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ? AND gm.left_at IS NULL
     JOIN group_key_distributions d ON d.group_id = g.id AND d.user_id = ? AND d.key_version = g.key_version`,
    [req.user.userId, req.user.userId]
  );
  const groups = [];
  for (const g of mine) {
    const rows = await db.all(
      `SELECT gm.user_id
       FROM group_members gm
       WHERE gm.group_id = ? AND gm.left_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM group_key_distributions d
           WHERE d.group_id = gm.group_id AND d.user_id = gm.user_id AND d.key_version = ?
         )`,
      [g.id, g.key_version]
    );
    if (rows.length) groups.push({ groupId: g.id, keyVersion: g.key_version, userIds: rows.map(r => r.user_id) });
  }
  res.json({ groups });
}));

// --- 鍵の作り直し ---
// 誰も今の鍵を読めなくなった(端末の入れ替えなどで鍵が合わなくなった)グループを立て直す。
// 現メンバーなら誰でも、新しい鍵を作って全メンバー宛に配れる。これ以降のメッセージは全員読める。
// 以前のメッセージは、元の鍵を持っている端末でだけ読める(鍵が無ければ復元できない)。
// body: { expectedVersion, encryptedKeysForMembers: [{userId, encryptedGroupKey}] }
router.post('/:groupId/rotate-key', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { expectedVersion, encryptedKeysForMembers } = req.body || {};
  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  // 同時に誰かが作り直していたら、二重に版が進まないようにする
  if (Number(expectedVersion) !== group.key_version) {
    return res.status(409).json({ error: '鍵のバージョンが変わっています。開き直してください', keyVersion: group.key_version });
  }
  if (!Array.isArray(encryptedKeysForMembers) || !encryptedKeysForMembers.length) {
    return res.status(400).json({ error: '配布データが不正です' });
  }
  const mine = encryptedKeysForMembers.find(e => e && e.userId === req.user.userId && typeof e.encryptedGroupKey === 'string');
  if (!mine) return res.status(400).json({ error: '自分宛の鍵が含まれていません' });

  const newVersion = group.key_version + 1;
  // 版の更新は「期待した版のときだけ」。先に取った人が勝つ
  const upd = await db.run('UPDATE groups SET key_version = ? WHERE id = ? AND key_version = ?', [newVersion, groupId, group.key_version]);
  const again = await db.get('SELECT key_version FROM groups WHERE id = ?', [groupId]);
  if (!again || again.key_version !== newVersion) {
    return res.status(409).json({ error: '鍵のバージョンが変わっています。開き直してください' });
  }
  let delivered = 0;
  for (const entry of encryptedKeysForMembers) {
    if (!isEncKeyEntry(entry)) continue;
    if (!(await isGroupMember(groupId, entry.userId))) continue;
    await db.run(
      'INSERT INTO group_key_distributions (id, group_id, user_id, key_version, encrypted_group_key) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), groupId, entry.userId, newVersion, entry.encryptedGroupKey]
    );
    delivered++;
    if (entry.userId !== req.user.userId) {
      broadcastToUser(entry.userId, { type: 'group_key_rotated', groupId, keyVersion: newVersion, reason: 'rekey' });
    }
  }
  res.json({ ok: true, groupId, keyVersion: newVersion, delivered });
}));

// --- 後から鍵を配る ---
// body: { keyVersion, encryptedKeysForMembers: [{userId, encryptedGroupKey}] }
// 現行バージョンの鍵を持つ現メンバーだけが、まだ鍵を持っていない現メンバー宛にのみ配れる(上書き不可)。
router.post('/:groupId/distribute-keys', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { keyVersion, encryptedKeysForMembers } = req.body;
  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  if (Number(keyVersion) !== group.key_version) {
    return res.status(409).json({ error: '鍵のバージョンが古くなっています', keyVersion: group.key_version });
  }
  const holds = await db.get(
    'SELECT 1 FROM group_key_distributions WHERE group_id=? AND user_id=? AND key_version=?',
    [groupId, req.user.userId, group.key_version]
  );
  if (!holds) return res.status(403).json({ error: 'このグループの現在の鍵を持っていません' });
  if (!Array.isArray(encryptedKeysForMembers)) return res.status(400).json({ error: '配布データが不正です' });

  let delivered = 0;
  for (const entry of encryptedKeysForMembers) {
    if (!isEncKeyEntry(entry)) continue;
    if (!(await isGroupMember(groupId, entry.userId))) continue;
    const exists = await db.get(
      'SELECT 1 FROM group_key_distributions WHERE group_id=? AND user_id=? AND key_version=?',
      [groupId, entry.userId, group.key_version]
    );
    if (exists) continue;
    await db.run(
      'INSERT INTO group_key_distributions (id, group_id, user_id, key_version, encrypted_group_key) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), groupId, entry.userId, group.key_version, entry.encryptedGroupKey]
    );
    delivered++;
    broadcastToUser(entry.userId, { type: 'group_key_rotated', groupId, keyVersion: group.key_version, reason: 'key_delivered' });
  }
  res.json({ ok: true, delivered });
}));

// --- 自分宛の最新グループ鍵を取得 ---
// --- 今の版の鍵を誰か持っているか ---
// 誰も持っていない(本人が抜けた直後など)なら、残ったメンバーの端末が新しい鍵を作って配る。
router.get('/:groupId/key-status', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  const group = await db.get('SELECT key_version FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
  const holder = await db.get(
    `SELECT 1 AS ok FROM group_key_distributions d
       JOIN group_members gm ON gm.group_id = d.group_id AND gm.user_id = d.user_id AND gm.left_at IS NULL
      WHERE d.group_id = ? AND d.key_version = ? LIMIT 1`,
    [groupId, group.key_version]
  );
  res.json({ keyVersion: group.key_version, orphaned: !holder });
}));

router.get('/:groupId/my-key', verifyToken, asyncHandler(async (req, res) => {
  const wantVer = parseInt(req.query.version, 10);
  const row = Number.isInteger(wantVer)
    ? await db.get(
        `SELECT * FROM group_key_distributions WHERE group_id=? AND user_id=? AND key_version=? LIMIT 1`,
        [req.params.groupId, req.user.userId, wantVer]
      )
    : await db.get(
        `SELECT * FROM group_key_distributions WHERE group_id=? AND user_id=? ORDER BY key_version DESC LIMIT 1`,
        [req.params.groupId, req.user.userId]
      );
  if (!row) return res.status(404).json({ error: '鍵が見つかりません' });
  res.json({ keyVersion: row.key_version, encryptedGroupKey: row.encrypted_group_key });
}));

// --- グループメッセージ送信 ---
// body: { content, mediaType?, mediaData?, encrypted? }
// mediaType: 'image' | 'video' | null（テキスト）
// mediaData: base64エンコードされたデータ
router.post('/:groupId/messages/send', messageSendLimiter, verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  // 暗号化されていない(平文で届いた)時だけサーバーで調べられる。暗号文は送る側の端末が調べる
  if (!req.body?.encrypted) censorBodyAndBanAfter(req, res, ['content'], { groupId });
  const { content, mediaType, mediaData, mediaUrl, mediaPublicId, encryptedMetadata, chunkCount, encrypted, keyVersion } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  // 個人チャットと同じ基準(本文の形と長さ、メディアの種類、mediaUrlはCloudinaryのみ)
  const badInput = validateMessageInput(req.body);
  if (badInput) return res.status(badInput === 'メッセージが長すぎます' ? 413 : 400).json({ error: badInput });

  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const msgType = mediaType || 'text';
  // 画像・動画の場合、個人チャットと同じ形式でJSONとして保存する。
  // Cloudinary方式(mediaUrl)とBase64直送り方式(mediaData)の両方に対応する。
  let finalContent = content;
  if (mediaUrl) {
    finalContent = JSON.stringify({
      text: content,
      mediaType,
      mediaUrl,
      mediaPublicId: mediaPublicId || null,
      encryptedMetadata: encryptedMetadata || null,
      chunkCount: chunkCount || null,
    });
  } else if (mediaData) {
    finalContent = JSON.stringify({ text: content, media: mediaData, mediaType });
  }

  const msgId = uuidv4();
  await db.run(
    'INSERT INTO group_messages (id, group_id, sender_id, content, msg_type, encrypted, key_version) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [msgId, groupId, req.user.userId, finalContent, msgType, !!encrypted, (Number.isInteger(keyVersion) && keyVersion >= 1 && keyVersion <= group.key_version) ? keyVersion : group.key_version]
  );

  const msg = await db.get('SELECT * FROM group_messages WHERE id = ?', [msgId]);

  // グループメンバー全員にWebSocket通知
  const members = await db.all(
    'SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL',
    [groupId]
  );
  const { broadcastToUser, isUserOnline } = require('../ws/wsServer');
  const sender = await db.get('SELECT display_name FROM users WHERE id = ?', [req.user.userId]);
  const { sendPushToUser } = require('../utils/webPush');

  members.forEach(m => {
    const isSelf = m.user_id === req.user.userId;
    broadcastToUser(m.user_id, {
      type: 'group_message',
      groupId,
      message: {
        id: msg.id,
        groupId: msg.group_id,
        senderId: msg.sender_id,
        content: msg.content,
        msgType: msg.msg_type,
        encrypted: !!msg.encrypted,
        keyVersion: msg.key_version,
        createdAt: msg.created_at,
      }
    });

    // 自分自身はスキップ(送信元端末には既に表示済み)、Push通知も不要
    if (isSelf) return;

    require('../utils/fcm').sendMessageNotification(
      m.user_id, `${sender?.display_name || 'ユーザー'} (${group.name})`,
      mediaType ? `[${mediaType === 'image' ? '画像' : '動画'}]` : 'メッセージが届きました',
      'group', { senderId: req.userId, chatId: groupId }
    ).catch(err => console.error('[fcm] group message failed:', err.message));

    // オフラインのメンバーにはPush通知。E2E暗号化のためcontentは復号できないので、
    // 通知には「誰から・どのグループに届いたか」だけを載せる。
    if (!isUserOnline(m.user_id)) {
      sendPushToUser(m.user_id, {
        type: 'new_group_message',
        groupId,
        groupName: group.name,
        senderName: sender?.display_name || 'ユーザー',
        preview: mediaType ? `[${mediaType === 'image' ? '画像' : '動画'}]` : 'メッセージが届きました',
      }).catch(err => console.error('[push] group message send failed:', err.message));
    }
  });

  res.json({ ok: true, message: msg });
}));

// --- グループメッセージ履歴取得 ---
router.get('/:groupId/messages', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const group = await db.get('SELECT * FROM groups WHERE id = ?', [groupId]);
  if (!group) return res.status(404).json({ error: 'グループが見つかりません' });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  // before: これより前を読む(上にスクロールした時)。日時として読めない値は無視する
  const before = typeof req.query.before === 'string' && req.query.before.length < 40 && !isNaN(Date.parse(req.query.before)) ? req.query.before : null;
  // 参加する前のメッセージは出さない(LINEと同じ。鍵も配られていないので、出しても「復号に失敗」が並ぶだけだった)
  const mem = await db.get('SELECT joined_at FROM group_members WHERE group_id = ? AND user_id = ? AND left_at IS NULL', [groupId, req.user.userId]);
  const params = [groupId];
  let where = 'gm.group_id = ? AND gm.deleted_at IS NULL';
  if (mem && mem.joined_at) { where += ' AND gm.created_at >= ?'; params.push(mem.joined_at); }
  if (before) { where += ' AND gm.created_at < ?'; params.push(before); }
  const messages = await db.all(
    `SELECT gm.*, u.display_name FROM group_messages gm
     LEFT JOIN users u ON u.id = gm.sender_id
     WHERE ${where}
     ORDER BY gm.created_at DESC LIMIT 100`,
    params
  );

  // 誰が読んだか(既読アイコン用)。以前は読まれた瞬間のリアルタイム通知でしか表示されず、
  // 画面を開き直すと既読アイコンが全部消えていた。
  const readersBy = new Map();
  if (messages.length) {
    const ids = messages.map(m => m.id);
    const reads = await db.all(
      `SELECT message_id, user_id FROM group_message_reads WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY read_at ASC`,
      ids
    );
    for (const r of reads) {
      if (!readersBy.has(r.message_id)) readersBy.set(r.message_id, []);
      readersBy.get(r.message_id).push(r.user_id);
    }
  }
  for (const m of messages) m.reader_ids = readersBy.get(m.id) || [];
  // リアクション(絵文字ごとに押した人の一覧)
  if (messages.length) {
    const ids = messages.map(m => m.id);
    const rx = await db.all(
      `SELECT message_id, emoji, user_id FROM group_message_reactions WHERE message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`,
      ids
    );
    const byMsg = new Map();
    for (const r of rx) {
      if (!byMsg.has(r.message_id)) byMsg.set(r.message_id, new Map());
      const em = byMsg.get(r.message_id);
      if (!em.has(r.emoji)) em.set(r.emoji, []);
      em.get(r.emoji).push(r.user_id);
    }
    for (const m of messages) {
      const em = byMsg.get(m.id);
      m.reactions = em ? [...em].map(([emoji, userIds]) => ({ emoji, userIds })) : [];
    }
  }

  res.json(messages.reverse());
}));

// --- グループを開いた(未読を0にする) ---
router.post('/:groupId/seen', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  await db.run('UPDATE group_members SET last_read_at = CURRENT_TIMESTAMP WHERE group_id = ? AND user_id = ? AND left_at IS NULL', [groupId, req.user.userId]);
  res.json({ ok: true });
}));

// --- グループメッセージのリアクション(押す/もう一度押すと外す) ---
// body: { emoji }
router.post('/:groupId/messages/:msgId/react', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, msgId } = req.params;
  const me = req.user.userId;
  const emoji = req.body && req.body.emoji;
  if (typeof emoji !== 'string' || !emoji || emoji.length > 10) return res.status(400).json({ error: '不正なemojiです' });
  if (!(await isGroupMember(groupId, me))) return res.status(403).json({ error: 'このグループのメンバーではありません' });
  const msg = await db.get('SELECT id FROM group_messages WHERE id = ? AND group_id = ? AND deleted_at IS NULL', [msgId, groupId]);
  if (!msg) return res.status(404).json({ error: 'メッセージが見つかりません' });
  const existing = await db.get('SELECT 1 AS ok FROM group_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [msgId, me, emoji]);
  if (existing) {
    await db.run('DELETE FROM group_message_reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', [msgId, me, emoji]);
  } else {
    // 1人が付けられる種類は12まで(連打でDBを埋められないように)
    const cnt = await db.get('SELECT COUNT(*) AS c FROM group_message_reactions WHERE message_id = ? AND user_id = ?', [msgId, me]);
    if (Number(cnt && cnt.c) >= 12) return res.status(429).json({ error: 'リアクションが多すぎます' });
    await db.run('INSERT INTO group_message_reactions (message_id, user_id, emoji) VALUES (?, ?, ?)', [msgId, me, emoji]);
  }
  const rows = await db.all('SELECT emoji, user_id FROM group_message_reactions WHERE message_id = ? ORDER BY created_at ASC', [msgId]);
  const em = new Map();
  for (const r of rows) { if (!em.has(r.emoji)) em.set(r.emoji, []); em.get(r.emoji).push(r.user_id); }
  const reactions = [...em].map(([e, userIds]) => ({ emoji: e, userIds }));
  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => broadcastToUser(m.user_id, { type: 'group_message_reaction', groupId, messageId: msgId, reactions }));
  res.json({ ok: true, reactions });
}));

// --- グループメッセージ既読マーク ---
// body: { messageIds: [id, ...] } (まとめて既読にする)
router.post('/:groupId/messages/read', verifyToken, asyncHandler(async (req, res) => {
  const { groupId } = req.params;
  const { messageIds } = req.body;
  if (!Array.isArray(messageIds) || messageIds.length === 0) {
    return res.status(400).json({ error: 'messageIds required' });
  }
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);

  for (const msgId of messageIds) {
    const msg = await db.get('SELECT sender_id FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
    if (!msg) continue;
    if (msg.sender_id === req.user.userId) continue; // 自分の送信メッセージは既読対象外
    const already = await db.get('SELECT * FROM group_message_reads WHERE message_id = ? AND user_id = ?', [msgId, req.user.userId]);
    if (already) continue;
    await db.run('INSERT INTO group_message_reads (message_id, user_id) VALUES (?, ?)', [msgId, req.user.userId]);

    // 何人が既読したかをメンバー全員に通知(自分のアイコンを表示するのではなく人数ベースで良い)
    const readCount = await db.get('SELECT COUNT(*) as cnt FROM group_message_reads WHERE message_id = ?', [msgId]);
    members.forEach(m => {
      broadcastToUser(m.user_id, {
        type: 'group_message_read',
        groupId,
        messageId: msgId,
        readerUserId: req.user.userId,
        readCount: Number(readCount.cnt),
        totalMembers: members.length,
      });
    });
  }

  res.json({ ok: true });
}));

// --- グループメッセージの既読者一覧取得 ---
router.get('/:groupId/messages/:msgId/reads', verifyToken, asyncHandler(async (req, res) => {
  if (!(await isGroupMember(req.params.groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  const reads = await db.all(
    `SELECT gmr.user_id, gmr.read_at, u.display_name FROM group_message_reads gmr
     JOIN users u ON u.id = gmr.user_id
     WHERE gmr.message_id = ?`,
    [req.params.msgId]
  );
  res.json({ reads: reads.map(r => ({ userId: r.user_id, displayName: r.display_name, readAt: r.read_at })) });
}));

// --- グループメッセージ編集 ---
router.post('/:groupId/messages/:msgId/edit', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, msgId } = req.params;
  if (!req.body?.encrypted) censorBodyAndBanAfter(req, res, ['content'], { groupId });
  const { content, encrypted, keyVersion } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });
  const badEdit = validateMessageInput(req.body, { allowMedia: false });
  if (badEdit) return res.status(badEdit === 'メッセージが長すぎます' ? 413 : 400).json({ error: badEdit });
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const msg = await db.get('SELECT * FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
  if (!msg) return res.status(404).json({ error: 'メッセージが見つかりません' });
  if (msg.sender_id !== req.user.userId) return res.status(403).json({ error: '権限がありません' });
  if (msg.msg_type === 'notice') return res.status(400).json({ error: 'この種類のメッセージは編集できません' });

  const now = new Date().toISOString();
  const grp = await db.get('SELECT key_version FROM groups WHERE id = ?', [groupId]);
  const newKv = (Number.isInteger(keyVersion) && keyVersion >= 1 && keyVersion <= (grp?.key_version || 1)) ? keyVersion : (grp?.key_version || msg.key_version);
  await db.run('UPDATE group_messages SET content = ?, encrypted = ?, key_version = ?, edited_at = ? WHERE id = ?', [content, !!encrypted, newKv, now, msgId]);

  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => {
    broadcastToUser(m.user_id, {
      type: 'group_message_edited',
      groupId,
      messageId: msgId,
      content,
      encrypted: !!encrypted,
      keyVersion: newKv,
      editedAt: now,
    });
  });

  res.json({ ok: true });
}));

// --- グループメッセージのピン留め切り替え ---
router.post('/:groupId/messages/:msgId/pin', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, msgId } = req.params;
  const { pinned } = req.body;
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }

  const msg = await db.get('SELECT * FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
  if (!msg) return res.status(404).json({ error: 'メッセージが見つかりません' });

  const now = pinned ? new Date().toISOString() : null;
  await db.run('UPDATE group_messages SET pinned_at = ? WHERE id = ?', [now, msgId]);

  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => {
    broadcastToUser(m.user_id, { type: 'group_message_pinned', groupId, messageId: msgId, pinned: !!pinned });
  });

  res.json({ ok: true, pinned: !!pinned });
}));

// --- グループのピン留めメッセージ一覧取得 ---
router.get('/:groupId/pinned', verifyToken, asyncHandler(async (req, res) => {
  if (!(await isGroupMember(req.params.groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  const rows = await db.all(
    `SELECT gm.*, u.display_name FROM group_messages gm
     LEFT JOIN users u ON u.id = gm.sender_id
     WHERE gm.group_id = ? AND gm.pinned_at IS NOT NULL AND gm.deleted_at IS NULL
     ORDER BY gm.pinned_at DESC`,
    [req.params.groupId]
  );
  res.json(rows);
}));

// --- グループメッセージ削除 ---
router.post('/:groupId/messages/:msgId/delete', verifyToken, asyncHandler(async (req, res) => {
  const { groupId, msgId } = req.params;
  if (!(await isGroupMember(groupId, req.user.userId))) {
    return res.status(403).json({ error: 'このグループのメンバーではありません' });
  }
  const msg = await db.get('SELECT * FROM group_messages WHERE id = ? AND group_id = ?', [msgId, groupId]);
  if (!msg) return res.status(404).json({ error: 'メッセージが見つかりません' });
  if (msg.sender_id !== req.user.userId) return res.status(403).json({ error: '権限がありません' });

  const now = new Date().toISOString();
  await db.run('UPDATE group_messages SET deleted_at = ? WHERE id = ?', [now, msgId]);

  // グループメンバーに通知
  const { broadcastToUser } = require('../ws/wsServer');
  const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
  members.forEach(m => {
    broadcastToUser(m.user_id, {
      type: 'group_message_deleted',
      groupId,
      messageId: msgId,
    });
  });

  res.json({ ok: true });
}));

module.exports = router;
