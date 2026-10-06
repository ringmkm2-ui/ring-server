// utils/moderation.js
// 禁止語(Fワード)を使ったら、そのアカウントを自動で3日間利用停止にする。
//
// 個人チャットとグループのメッセージはE2E暗号化されていてサーバーには中身が見えないので、
// 送る側の端末が送信前に調べ、引っかかったら送らずに /api/moderation/self-report で
// 自分の停止をサーバーに伝える(他人を停止させることはできない。自分のアカウントだけ)。
// 投稿・コメント・コミュニティ・名前など平文で届く物は、サーバーがここで直接調べる。
// 判定の中身は public/js/profanity.js と同じにしておくこと。
const db = require('../db/db');

const BAN_MS = 3 * 24 * 60 * 60 * 1000;

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '$': 's', '!': 'i', '|': 'i', '©': 'c', '(': 'c', '¢': 'c', '@': '*', '#': '*', '%': '*' };

function containsBannedWord(text) {
  if (typeof text !== 'string' || !text) return false;
  const base = text.normalize('NFKC').toLowerCase();
  // カタカナ・ひらがな
  // (「ファクト」「ファックス」は普通の言葉なので除く)
  if (/ファ[ー・\s]*ッ+[ー・\s]*ク(?!ス)|ふぁ[ー・\s]*っ+[ー・\s]*く(?!す)/.test(base)) return true;
  // 英字: 記号置き換え(f@ck, fu(k 等)を戻し、空白や記号の区切り(f u c k / f.u.c.k)を詰め、
  // 同じ文字の連続(fuuuuck)を1文字にしてから見る。* は伏せ字としてそのまま残す
  const latin = base
    .split('').map(c => LEET[c] || c).join('')
    .replace(/[^a-z*]/g, '')
    .replace(/(.)\1+/g, '$1');
  // fuck / fack / fvck / fxck / f*ck / f*k / fck / phuck。
  // 「fuk」単体はローマ字(fukuoka・fuku 等)とぶつかるので含めない
  return /f[uvxa*]ck|f\*k|fck|ph[ua]ck|phuk/.test(latin);
}

// 禁止語の部分だけを「f***」に置き換える(前後の文はそのまま)。
// 判定と同じ読み替え(記号・区切り・連続文字)をしながら、元の文字の位置を覚えておき、
// 引っかかった範囲を元の文字列で置き換える。
const LATIN_RE = /f[uvxa*]ck|f\*k|fck|ph[ua]ck|phuk/g;
const KANA_RE = /ファ[ー・\s]*ッ+[ー・\s]*ク(?!ス)|ふぁ[ー・\s]*っ+[ー・\s]*く(?!す)/g;
function censor(text) {
  if (typeof text !== 'string' || !text || !containsBannedWord(text)) return text;
  // 1文字ずつ正規化し、英字(と伏せ字の*)だけを位置付きで拾う
  const stream = []; // { c, start, end }  元の文字列での [start, end)
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i), len = cp > 0xffff ? 2 : 1;
    const n = String.fromCodePoint(cp).normalize('NFKC').toLowerCase();
    for (const ch of n) {
      const m = LEET[ch] || ch;
      if (/[a-z*]/.test(m)) stream.push({ c: m, start: i, end: i + len });
    }
    i += len;
  }
  // 同じ文字の連続をまとめる(範囲は伸ばす)
  const col = [];
  for (const t of stream) {
    const last = col[col.length - 1];
    if (last && last.c === t.c) last.end = t.end; else col.push({ ...t });
  }
  const str = col.map(t => t.c).join('');
  const ranges = [];
  let m;
  LATIN_RE.lastIndex = 0;
  while ((m = LATIN_RE.exec(str))) ranges.push([col[m.index].start, col[m.index + m[0].length - 1].end]);
  const nfk = text; // カナは元の文字列のまま探す
  KANA_RE.lastIndex = 0;
  while ((m = KANA_RE.exec(nfk))) ranges.push([m.index, m.index + m[0].length]);
  ranges.sort((x, y) => x[0] - y[0]);
  let out = '', pos = 0;
  for (const [st, en] of ranges) {
    if (st < pos) continue;
    out += text.slice(pos, st) + 'f***';
    pos = en;
  }
  return out + text.slice(pos);
}

async function banUser(userId, reason) {
  const until = Date.now() + BAN_MS;
  await db.run(
    'UPDATE users SET banned_until = ?, ban_reason = ? WHERE id = ? AND (banned_until IS NULL OR banned_until < ?)',
    [until, String(reason || 'profanity').slice(0, 100), userId, until]
  );
  // 繋がっているWebSocketにも知らせて切る(循環requireを避けるため遅延読み込み)
  try { require('../ws/wsServer').disconnectBanned(userId, until); } catch (e) {}
  console.log(`[moderation] user ${userId} banned until ${new Date(until).toISOString()} (${reason})`);
  return until;
}

// トークの相手(個人チャット)やグループのメンバーに「OOがFワードを言ったためBanしました。」を出す。
// サーバーが作る通知(msg_type='notice')。送信APIからはこの種類を作れないので、なりすませない。
async function postBanNotice(userId, { peerId, groupId } = {}) {
  const { v4: uuidv4 } = require('uuid');
  const u = await db.get('SELECT display_name FROM users WHERE id = ?', [userId]);
  const content = JSON.stringify({ __notice__: { kind: 'ban', name: (u && u.display_name) || 'ユーザー' } });
  const { broadcastToUser } = require('../ws/wsServer');
  const id = uuidv4();
  if (peerId) {
    await db.run(
      "INSERT INTO messages (id, sender_id, recipient_id, content, msg_type, encrypted, read_at) VALUES (?, ?, ?, ?, 'notice', false, NULL)",
      [id, userId, peerId, content]
    );
    const msg = await db.get('SELECT * FROM messages WHERE id = ?', [id]);
    const payload = { type: 'new_message', message: {
      id: msg.id, senderId: msg.sender_id, recipientId: msg.recipient_id, content: msg.content,
      msgType: 'notice', encrypted: false, repliedToId: null, createdAt: msg.created_at,
    } };
    broadcastToUser(peerId, payload);
    broadcastToUser(userId, payload);
  } else if (groupId) {
    const group = await db.get('SELECT key_version FROM groups WHERE id = ?', [groupId]);
    if (!group) return;
    await db.run(
      "INSERT INTO group_messages (id, group_id, sender_id, content, msg_type, encrypted, key_version) VALUES (?, ?, ?, ?, 'notice', false, ?)",
      [id, groupId, userId, content, group.key_version]
    );
    const msg = await db.get('SELECT * FROM group_messages WHERE id = ?', [id]);
    const members = await db.all('SELECT user_id FROM group_members WHERE group_id = ? AND left_at IS NULL', [groupId]);
    members.forEach(mm => broadcastToUser(mm.user_id, { type: 'group_message', groupId, message: {
      id: msg.id, groupId, senderId: msg.sender_id, content: msg.content, msgType: 'notice',
      encrypted: false, keyVersion: msg.key_version, createdAt: msg.created_at,
    } }));
  }
}

// 平文で届く本文(投稿・コメント・コミュニティ・暗号化されていないメッセージ)用。
// 禁止語の所だけ「f***」にして、そのまま保存・送信させる。保存が成功して応答を返す時に、
// 本人を3日間停止にし(相手やグループには「OOがFワードを言ったためBanしました。」を出す)、
// 応答は 403 + 停止情報にする。req.body を書き換えるので、本文を取り出す前に呼ぶこと。
// 返り値 true = 禁止語があった
function censorBodyAndBanAfter(req, res, keys, noticeTarget) {
  let hit = false;
  const body = req.body || {};
  for (const k of keys) {
    const v = body[k];
    if (typeof v === 'string' && containsBannedWord(v)) { body[k] = censor(v); hit = true; }
  }
  if (!hit) return false;
  const origJson = res.json.bind(res);
  res.json = (data) => {
    if (res.statusCode >= 400) return origJson(data);
    (async () => {
      try {
        const nt = typeof noticeTarget === 'function' ? noticeTarget() : noticeTarget;
        if (nt) await postBanNotice(req.user.userId, nt);
      } catch (e) { console.error('[moderation] notice failed:', e.message); }
      const until = await banUser(req.user.userId, 'profanity');
      res.status(403);
      origJson({ ...(data || {}), error: '禁止されている言葉を使ったため、3日間利用停止になりました', banned: true, bannedUntil: until });
    })().catch(() => origJson(data));
    return res;
  };
  return true;
}

// 平文の入力を調べ、禁止語があれば投稿者を停止して 403 を返す。返り値 true なら呼び出し側は処理を止める
async function rejectIfProfane(req, res, ...texts) {
  if (!texts.some(containsBannedWord)) return false;
  const until = await banUser(req.user.userId, 'profanity');
  res.status(403).json({ error: '禁止されている言葉を使ったため、3日間利用停止になりました', banned: true, bannedUntil: until });
  return true;
}

module.exports = { containsBannedWord, censor, banUser, postBanNotice, rejectIfProfane, censorBodyAndBanAfter, BAN_MS };
