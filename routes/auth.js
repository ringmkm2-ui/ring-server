// routes/auth.js
// UserAuthenticator: 登録・ログイン・JWT発行
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db/db');
const { JWT_SECRET } = require('../utils/jwtSecret');
const { loginLimiter, registerLimiter, inviteSignupLimiter, guestUpgradeLimiter } = require('../utils/rateLimits');
const { sendServerError } = require('../utils/errorResponse');
const { verifyToken, verifyTokenWithRevocation } = require('../utils/authMiddleware');
const { isMailConfigured, sendMail } = require('../utils/mailer');
const { generateSecret, verifyTotp, otpauthUri } = require('../utils/totp');
const { validatePassword } = require('../utils/passwordPolicy');
const secretBox = require('../utils/secretBox');
const { createSession } = require('../utils/sessions');
const sessionEvents = require('../utils/sessionEvents');

const router = express.Router();

// 表示用のユーザーID(U3K7F9のような形)。推測されにくいよう暗号用の乱数で作る。
const ID_CHARS = '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ';
function newUserIdCode() {
  const bytes = require('crypto').randomBytes(6);
  let out = 'U';
  for (let i = 0; i < 6; i++) out += ID_CHARS[bytes[i] % ID_CHARS.length];
  return out;
}
async function uniqueUserIdCode() {
  for (let i = 0; i < 8; i++) {
    const c = newUserIdCode();
    const taken = await db.get('SELECT 1 AS x FROM users WHERE user_id = ?', [c]);
    if (!taken) return c;
  }
  return newUserIdCode();
}

const JWT_EXPIRES_IN = '30d';

// Google Sign-In (Google Identity Services) のクライアントID。
// public/auth.html に埋め込まれているものと同じ値でなければ検証が常に失敗する。
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '253097251071-qsajqnr9l71vjma3hlg8d91hmh7m6c9l.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);


// ---------------------------------------------------------------------
// メール認証 + 2段階認証(TOTP)
// ---------------------------------------------------------------------
const EMAIL_RE = /^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]+$/;
const EMAIL_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;
const EMAIL_CODE_MAX_ATTEMPTS = 5;
// 2FA途中トークンは通常のセッションJWTとは別の鍵で署名する。
// 同じ鍵だと、パスワードだけ通った段階のトークンが verifyToken を通ってしまい2FAを丸ごと迂回される。
const TWOFA_SECRET = JWT_SECRET + ':2fa-pending';
const TWOFA_TOKEN_TTL = '5m';

// ログインと同じく、大文字を混ぜて打ったメールアドレスでも見つける(ゲストから変えたものは小文字で保存している)
async function findByLoginName(name, cols = '*') {
  let u = await db.get(`SELECT ${cols} FROM users WHERE username = ?`, [name]);
  if (!u && name.includes('@') && name !== name.toLowerCase()) u = await db.get(`SELECT ${cols} FROM users WHERE username = ?`, [name.toLowerCase()]);
  return u;
}
const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const truthy = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true';

// リクエストから端末情報(User-Agent / IP)を取り出す
const reqMeta = (req) => ({ ua: req.headers['user-agent'], ip: req.ip });

// 端末ごとのセッションを作ってJWTに sid を入れる(端末単位のサインアウトのため)
async function issueToken(user, meta) {
  const sid = await createSession(user.id, meta || {});
  const payload = { userId: user.id, username: user.username };
  if (sid) payload.sid = sid;
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

async function sessionResponse(user, extra = {}, meta) {
  const token = await issueToken(user, meta);
  return {
    userId: user.id,
    userIdCode: user.user_id,
    username: user.username,
    displayName: user.display_name,
    token,
    ...extra,
  };
}

// パスワード(またはGoogle)を通過した後の分岐: 2FAが有効なら途中トークンだけ返す。
async function finishLogin(user, extra = {}, meta) {
  if (truthy(user.totp_enabled)) {
    const twoFaToken = jwt.sign({ userId: user.id, purpose: '2fa' }, TWOFA_SECRET, { expiresIn: TWOFA_TOKEN_TTL });
    return { needs2fa: true, twoFaToken };
  }
  return sessionResponse(user, extra, meta);
}

async function sendEmailCode(username) {
  const row = await db.get('SELECT last_sent_ms FROM email_codes WHERE username = ?', [username]);
  const now = Date.now();
  if (row && now - Number(row.last_sent_ms || 0) < EMAIL_CODE_COOLDOWN_MS) {
    const e = new Error('cooldown');
    e.cooldown = true;
    throw e;
  }
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await db.run(
    `INSERT INTO email_codes (username, code_hash, expires_ms, attempts, last_sent_ms) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(username) DO UPDATE SET code_hash = excluded.code_hash, expires_ms = excluded.expires_ms, attempts = 0, last_sent_ms = excluded.last_sent_ms`,
    [username, sha256(code), now + EMAIL_CODE_TTL_MS, now]
  );
  await sendMail({
    to: username,
    subject: 'Bro Chat 認証コード',
    text: `Bro Chat の認証コードです。\n\n${code}\n\n10分以内に入力してください。心当たりがない場合はこのメールを無視してください。`,
  });
}

// 2FA総当たり対策: ユーザー単位で5回失敗したら15分ロック(IP単位のレート制限とは別)。
const twoFaFails = new Map();
function twoFaLocked(userId) {
  const f = twoFaFails.get(userId);
  return !!(f && f.until && f.until > Date.now());
}
function twoFaFail(userId) {
  const f = twoFaFails.get(userId) || { count: 0, until: 0 };
  f.count += 1;
  if (f.count >= 5) { f.until = Date.now() + 15 * 60 * 1000; f.count = 0; }
  twoFaFails.set(userId, f);
}
function twoFaOk(userId) { twoFaFails.delete(userId); }

// パスワード総当たり対策(アカウント単位)。IP単位のレート制限だけだと、IPを散らされたら素通りになる。
// 連続8回失敗で15分ロック。成功したらカウントを戻す。
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
// 存在しないユーザーでもbcryptを1回走らせて、応答時間でアカウントの有無を探られないようにする
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing-only', 12);

async function recordLoginFailure(userId) {
  await db.run('UPDATE users SET failed_login_count = COALESCE(failed_login_count, 0) + 1 WHERE id = ?', [userId]);
  const row = await db.get('SELECT failed_login_count FROM users WHERE id = ?', [userId]);
  if (row && Number(row.failed_login_count) >= LOGIN_MAX_FAILS) {
    await db.run('UPDATE users SET failed_login_count = 0, locked_until = ? WHERE id = ?', [Date.now() + LOGIN_LOCK_MS, userId]);
  }
}
async function clearLoginFailures(user) {
  if (Number(user.failed_login_count || 0) > 0 || Number(user.locked_until || 0) > 0) {
    await db.run('UPDATE users SET failed_login_count = 0, locked_until = 0 WHERE id = ?', [user.id]);
  }
}

function normalizeBackup(code) {
  return String(code || '').toLowerCase().replace(/[^a-f0-9]/g, '');
}
function generateBackupCodes() {
  const plain = [];
  for (let i = 0; i < 8; i++) {
    const h = crypto.randomBytes(5).toString('hex');
    plain.push(h.slice(0, 5) + '-' + h.slice(5));
  }
  return { plain, hashes: plain.map(c => sha256(normalizeBackup(c))) };
}

// TOTPまたは予備コードを検証する。成功なら true(予備コードは消費、TOTPはステップを記録)。
async function checkSecondFactor(user, rawCode) {
  const code = String(rawCode || '').trim();
  if (/^\d{3}\s?\d{3}$/.test(code) && user.totp_secret) {
    const plainSecret = secretBox.decrypt(user.totp_secret);
    if (!plainSecret) return false;
    const step = verifyTotp(plainSecret, code);
    if (step === null) return false;
    // 旧バージョンで平文のまま保存されていた秘密鍵は、使われたタイミングで暗号化し直す
    if (!secretBox.isEncrypted(user.totp_secret)) {
      await db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secretBox.encrypt(plainSecret), user.id]);
    }
    if (step <= Number(user.totp_last_step || 0)) return false; // 同じコードの再利用を拒否
    await db.run('UPDATE users SET totp_last_step = ? WHERE id = ?', [step, user.id]);
    return true;
  }
  const norm = normalizeBackup(code);
  if (norm.length === 10) {
    let list = [];
    try { list = JSON.parse(user.backup_codes || '[]'); } catch {}
    const h = sha256(norm);
    if (list.includes(h)) {
      await db.run('UPDATE users SET backup_codes = ? WHERE id = ?', [JSON.stringify(list.filter(x => x !== h)), user.id]);
      return true;
    }
  }
  return false;
}

// --- 新規登録 ---
// body: { username, password, displayName }
// 本名のチェック。表示名と違ってほかの人には出さない(本人と運営だけ)
function cleanRealName(v) {
  if (typeof v !== 'string') return { error: '本名を入力してください' };
  const s = v.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!s) return { error: '本名を入力してください' };
  if (s.length > 50) return { error: '本名が長すぎます' };
  if (/[<>"'`\u0000-\u001f]/.test(s) || /\d|@|https?:/i.test(s)) return { error: '本名に使えない文字が含まれています' };
  return { value: s };
}

router.post('/register', registerLimiter, async (req, res) => {
  const { username, password, displayName } = req.body;
  const rn = cleanRealName(req.body.realName);
  if (rn.error) return res.status(400).json({ error: rn.error });
  // 登録前なので停止する相手がいない。名前に禁止語があれば登録自体を断る
  if (require('../utils/moderation').containsBannedWord(typeof displayName === 'string' ? displayName : '')) {
    return res.status(400).json({ error: 'その名前は使えません' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'username と password は必須です' });
  }
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username と password は文字列で指定してください' });
  }
  // 8文字以上・上限128(bcryptは重いのでDoS防止)に加え、よくあるパスワード/ユーザー名と同じものを弾く
  const pwErr = validatePassword(password, username);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (username.length > 254) {
    return res.status(400).json({ error: 'ユーザー名が長すぎます' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'ユーザー名は3文字以上にしてください' });
  }
  // guest_ で始まる名前は、招待コードで作るアカウント専用(メールでもパスワードでもログインできない名前)
  if (/^(guest|deleted)_/i.test(username)) {
    return res.status(400).json({ error: 'そのユーザー名は使えません' });
  }
  // HTMLタグ・スクリプトインジェクション防止。英数字・日本語・一般的な記号のみ許可。
  // < > " ' はXSSに悪用されるため禁止。
  if (/[<>"'`]/.test(username)) {
    return res.status(400).json({ error: 'ユーザー名に使用できない文字が含まれています' });
  }

  const mailOn = isMailConfigured();
  if (mailOn && !EMAIL_RE.test(username)) {
    return res.status(400).json({ error: 'メールアドレスの形式で登録してください' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await db.get('SELECT id, email_verify_required, email_verified_at FROM users WHERE username = ?', [username]);
  let userId;
  let userIdCode;
  let createdNew = false;

  if (existing) {
    // 認証前のまま放置された登録は、その人しか知らないパスワードで作られただけで、
    // トークンも発行されていない。本物のメール所有者が登録し直せるよう上書きを許す
    // (そうしないとメールアドレスを先に押さえられただけで本人が登録できなくなる)。
    const stale = truthy(existing.email_verify_required) && !existing.email_verified_at;
    if (!stale) {
      return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
    }
    userId = existing.id;
    await db.run('UPDATE users SET password_hash = ?, display_name = ?, real_name = ? WHERE id = ?', [passwordHash, displayName || username, rn.value, userId]);
  } else {
    // bcryptのコスト係数: 10→12に引き上げ。総当たり耐性が上がる一方、
    // ハッシュ化にかかる時間は数十ms程度の増加に留まりログイン体感には影響しない。
    userId = uuidv4();
    userIdCode = await uniqueUserIdCode(); // User ID like U3K7F9
    await db.run(
      'INSERT INTO users (id, user_id, username, password_hash, display_name, email_verify_required, real_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [userId, userIdCode, username, passwordHash, displayName || username, mailOn ? 1 : 0, rn.value]
    );
    createdNew = true;
  }

  if (mailOn) {
    try {
      await sendEmailCode(username);
    } catch (e) {
      if (!e.cooldown) {
        console.error('[auth] 認証メール送信失敗:', e.message);
        if (createdNew) await db.run('DELETE FROM users WHERE id = ?', [userId]);
        return res.status(502).json({ error: '認証メールを送信できませんでした。メールアドレスを確認してもう一度試してください' });
      }
    }
    // トークンは認証が済むまで発行しない
    return res.json({ needsVerification: true, username });
  }

  if (createdNew) await require('../utils/officialFriend').befriendOfficial(userId);
  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  res.json(await sessionResponse(user, {}, reqMeta(req)));
});

// --- 招待コードだけで始める(メールもパスワードも要らない) ---
// body: { code, displayName, realName }
// 招待コードを使うと、メールアドレスとパスワード無しでアカウントができ、コードの持ち主と承認待ちなしで友だちになる。
// Googleログインと同じ password_hash = '' のアカウントで、ユーザー名は guest_ + 乱数(メールではない)。
// パスワードでは入れず、この端末のトークンだけで使う(ログアウトすると戻れない)。
router.post('/register-invite', registerLimiter, inviteSignupLimiter, async (req, res) => {
  try {
    const { normalizeCode, loadInvite, claimInvite, releaseInvite, makeFriends, notifyFriendChange, INVALID } = require('../utils/inviteCore');
    const body = req.body || {};
    // 入力の確認はコードを消費する前に済ませる(名前の入れ間違いで人数を減らさない)
    const rn = cleanRealName(body.realName);
    if (rn.error) return res.status(400).json({ error: rn.error });
    const displayName = typeof body.displayName === 'string' ? body.displayName.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
    if (!displayName) return res.status(400).json({ error: '表示名を入力してください' });
    if (displayName.length > 50) return res.status(400).json({ error: '表示名は50文字以内にしてください' });
    if (/[<>"'`\u0000-\u001f\u202a-\u202e\u2066-\u2069]/.test(displayName)) return res.status(400).json({ error: '表示名に使えない文字が含まれています' });
    // ゼロ幅・空白に見える文字だけの名前は、誰か分からなくなるので断る
    if (!displayName.replace(/[\u00ad\u034f\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g, '').trim()) return res.status(400).json({ error: '表示名を入力してください' });
    if (require('../utils/moderation').containsBannedWord(displayName)) {
      return res.status(400).json({ error: 'その名前は使えません' });
    }

    const code = normalizeCode(body.code);
    if (!code) return res.status(404).json(INVALID);
    const found = await loadInvite(code);
    if (!found) return res.status(404).json(INVALID);
    const { inv, owner } = found;

    const userId = uuidv4();
    const got = await claimInvite(inv, userId); // 新しい人なので必ず 'claimed' か null
    if (!got) return res.status(404).json(INVALID);

    let userIdCode;
    try {
      userIdCode = await uniqueUserIdCode();
      const guestName = 'guest_' + crypto.randomBytes(9).toString('hex');
      await db.run(
        'INSERT INTO users (id, user_id, username, password_hash, display_name, email_verified_at, real_name) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)',
        [userId, userIdCode, guestName, '', displayName, rn.value]
      );
      await makeFriends(userId, owner.id);
    } catch (e) {
      await releaseInvite(code, userId);
      await db.run('DELETE FROM friendships WHERE user_a_id = ? OR user_b_id = ?', [userId, userId]).catch(() => {});
      await db.run('DELETE FROM users WHERE id = ?', [userId]).catch(() => {});
      throw e;
    }
    await require('../utils/officialFriend').befriendOfficial(userId);
    notifyFriendChange(userId, owner.id);
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const friend = { userId: owner.id, userIdCode: owner.user_id, displayName: owner.display_name, profilePic: owner.profile_pic };
    res.json(await sessionResponse(user, { friend }, reqMeta(req)));
  } catch (e) {
    sendServerError(res, e, 'register-invite');
  }
});

// --- ゲスト(招待コードで始めた人)に、あとからメールとパスワードを付ける ---
// 2段階: start でメールとパスワードを預かってコードを送り、confirm でコードが合えば反映する。
// メールの持ち主だと確かめるまでは何も変えない(他人のメールアドレスを先に押さえられないように)。
// ゲストとは「ユーザー名が guest_ で始まり、パスワードが空」のアカウント。反映後はふつうのメール+パスワードのアカウントになる。
const GUEST_SEND_MAX_PER_DAY = 10;    // 1人が1日に送れる確認メールの数(他人のアドレスにメールを送り付ける悪用を止める)
const GUEST_MISS_MAX_PER_DAY = 15;     // 1人が1日に外せる確認コードの回数
const GUEST_MAIL_MAX_PER_ADDRESS = 3;  // 1つのメールアドレス宛に、1日に送る確認メールの数(使い捨てゲストを大量に作って、同じ人にメールを送り付ける悪用を止める)
const GUEST_SEND_MAX_PER_IP = 200;     // 1つのIPから1日に送れる確認メールの数(教室など同じWi-Fiの全員が同じ日に設定できる広さ)

async function loadGuest(userId) {
  const u = await db.get('SELECT id, username, password_hash FROM users WHERE id = ?', [userId]);
  if (!u || !/^guest_/.test(String(u.username || '')) || u.password_hash) return null;
  return u;
}
const NOT_GUEST = { error: 'このアカウントはメールとパスワードを設定する対象ではありません' };

// いまゲストか(別の端末で設定済みなら false)。画面が「設定する」の表示を出すか決めるのに使う
router.get('/guest/status', verifyToken, async (req, res) => {
  try {
    const guest = !!(await loadGuest(req.user.userId));
    const row = guest ? await db.get('SELECT email, expires_ms FROM guest_upgrades WHERE user_id = ?', [req.user.userId]) : null;
    const pending = row && Number(row.expires_ms) > Date.now() ? { email: row.email } : null;
    res.json({ guest, mailConfigured: isMailConfigured(), pending });
  } catch (e) { sendServerError(res, e, 'guest-status'); }
});

// body: { email, password }
router.post('/guest/upgrade/start', verifyToken, guestUpgradeLimiter, (req, res) => require('../utils/keyedLock').withLock('gup-start:' + req.user.userId, () => guestUpgradeStart(req, res)));
async function guestUpgradeStart(req, res) {
  try {
    const userId = req.user.userId;
    if (!(await loadGuest(userId))) return res.status(403).json(NOT_GUEST);
    const { email: rawEmail, password } = req.body || {};
    if (typeof rawEmail !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'メールアドレスとパスワードを入力してください' });
    const email = rawEmail.trim().toLowerCase();
    if (email.length > 254 || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'メールアドレスの形式が正しくありません' });
    if (/^(guest|deleted)_/.test(email)) return res.status(400).json({ error: 'そのメールアドレスは使えません' });
    const pwErr = validatePassword(password, email);
    if (pwErr) return res.status(400).json({ error: pwErr });
    // 認証コードを送れない環境では、持ち主を確かめられないので進めない
    if (!isMailConfigured()) return res.status(503).json({ error: '今はメールを送れないため設定できません。あとでもう一度お試しください' });

    // 大文字小文字が違うだけのものも同じ扱い。認証前のまま放置された登録だけは、持ち主が現れた時に譲る(/register と同じ考え方)
    const taken = await db.get('SELECT id, username, email_verify_required, email_verified_at FROM users WHERE LOWER(username) = ? AND id <> ?', [email, userId]);
    if (taken && !(truthy(taken.email_verify_required) && !taken.email_verified_at)) {
      return res.status(409).json({ error: 'そのメールアドレスは既に使われています' });
    }

    const now = Date.now();
    const prev = await db.get('SELECT last_sent_ms FROM guest_upgrades WHERE user_id = ?', [userId]);
    if (prev && now - Number(prev.last_sent_ms || 0) < EMAIL_CODE_COOLDOWN_MS) {
      const wait = Math.ceil((EMAIL_CODE_COOLDOWN_MS - (now - Number(prev.last_sent_ms))) / 1000);
      return res.status(429).json({ error: `コードを送ったばかりです。${wait}秒ほど待ってからもう一度お試しください`, retryAfter: wait });
    }
    if ((await resetMissCount('gupsend:' + userId)) >= GUEST_SEND_MAX_PER_DAY) {
      return res.status(429).json({ error: '今日はもう送れません。明日もう一度お試しください' });
    }
    // 宛先のアドレスごと・IPごとの上限(人ごとの上限だけだと、ゲストを作り直すたびに同じ被害者へ送れてしまう)
    const mailKey = 'gupmail:' + email, ipKey = 'gupip:' + (req.ip || '');
    if ((await resetMissCount(mailKey)) >= GUEST_MAIL_MAX_PER_ADDRESS || (await resetMissCount(ipKey)) >= GUEST_SEND_MAX_PER_IP) {
      return res.status(429).json({ error: '今日はもう送れません。明日もう一度お試しください' });
    }

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const hash = await bcrypt.hash(password, 12);
    await db.run(
      `INSERT INTO guest_upgrades (user_id, email, password_hash, code_hash, expires_ms, attempts, last_sent_ms) VALUES (?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, password_hash = excluded.password_hash, code_hash = excluded.code_hash,
         expires_ms = excluded.expires_ms, attempts = 0, last_sent_ms = excluded.last_sent_ms`,
      [userId, email, hash, sha256(code), now + EMAIL_CODE_TTL_MS, now]
    );
    await resetMiss('gupsend:' + userId);
    await resetMiss(mailKey); await resetMiss(ipKey);
    try {
      await sendMail({
        to: email,
        subject: 'Bro Chat 認証コード',
        text: `Bro Chat のアカウントにこのメールアドレスを設定するための認証コードです。\n\n${code}\n\n10分以内に入力してください。心当たりがない場合はこのメールを無視してください(何も変わりません)。`,
      });
    } catch (e) {
      console.error('[auth] ゲスト設定の確認メール送信失敗:', e.message);
      await db.run('DELETE FROM guest_upgrades WHERE user_id = ?', [userId]);
      return res.status(502).json({ error: '確認メールを送信できませんでした。メールアドレスを確認してもう一度試してください' });
    }
    res.json({ ok: true, email, retryAfter: Math.round(EMAIL_CODE_COOLDOWN_MS / 1000) });
  } catch (e) { sendServerError(res, e, 'guest-upgrade-start'); }
}

// body: { code }  合えば、ユーザー名をメールアドレスに、パスワードを設定したものにして、新しいトークンを返す
router.post('/guest/upgrade/confirm', verifyToken, guestUpgradeLimiter, async (req, res) => {
  try {
    const userId = req.user.userId;
    if (!(await loadGuest(userId))) return res.status(403).json(NOT_GUEST);
    const code = req.body && req.body.code;
    if (typeof code !== 'string') return res.status(400).json({ error: 'コードを入力してください' });
    const invalid = () => res.status(400).json({ error: 'コードが正しくないか、期限切れです' });
    const row = await db.get('SELECT * FROM guest_upgrades WHERE user_id = ?', [userId]);
    if (!row) return invalid();
    if ((await resetMissCount('gup:' + userId)) >= GUEST_MISS_MAX_PER_DAY) {
      return res.status(429).json({ error: '失敗が続いたため、今日はこれ以上試せません。明日もう一度お試しください' });
    }
    if (Date.now() > Number(row.expires_ms)) return invalid();
    // 試行の消費を、確かめる前に1文で行う。「読んで→比べて→加算」だと、同時に何本も送られた時に全部が上限の手前で通ってしまう
    const claim = await db.run('UPDATE guest_upgrades SET attempts = attempts + 1 WHERE user_id = ? AND attempts < ?', [userId, EMAIL_CODE_MAX_ATTEMPTS]);
    if (!claim || !claim.changes) return invalid();
    const given = Buffer.from(sha256(code.replace(/\s/g, '')));
    const real = Buffer.from(row.code_hash);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
      await resetMiss('gup:' + userId);
      return invalid();
    }

    // コードを待つ間に、そのメールを別の人が使い始めていないか確かめ直す
    const taken = await db.get('SELECT id, username, email_verify_required, email_verified_at FROM users WHERE LOWER(username) = ? AND id <> ?', [row.email, userId]);
    if (taken) {
      if (!(truthy(taken.email_verify_required) && !taken.email_verified_at)) {
        await db.run('DELETE FROM guest_upgrades WHERE user_id = ?', [userId]);
        return res.status(409).json({ error: 'そのメールアドレスは既に使われています' });
      }
      // 認証されないまま放置された登録(トークンも友だちも無い)は、メールの持ち主が確かめられたので譲ってもらう
      try {
        await db.run('DELETE FROM email_codes WHERE username = ?', [taken.username || row.email]);
        await db.run('DELETE FROM users WHERE id = ?', [taken.id]);
      } catch (e) {
        await db.run('DELETE FROM guest_upgrades WHERE user_id = ?', [userId]);
        return res.status(409).json({ error: 'そのメールアドレスは既に使われています' });
      }
    }
    try {
      // guest のままの時だけ書き換える(同時に2回押されても、勝つのは1回だけ)
      const r = await db.run(
        `UPDATE users SET username = ?, password_hash = ?, email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP),
           failed_login_count = 0, locked_until = 0
         WHERE id = ? AND password_hash = '' AND username LIKE 'guest\\_%' ESCAPE '\\'`,
        [row.email, row.password_hash, userId]
      );
      if (!r || !r.changes) return res.status(403).json(NOT_GUEST);
    } catch (e) {
      if (/unique|constraint|duplicate/i.test(String(e && e.message))) {
        await db.run('DELETE FROM guest_upgrades WHERE user_id = ?', [userId]);
        return res.status(409).json({ error: 'そのメールアドレスは既に使われています' });
      }
      throw e;
    }
    await db.run('DELETE FROM guest_upgrades WHERE user_id = ?', [userId]);
    await db.run("DELETE FROM auth_misses WHERE key IN (?, ?)", ['gup:' + userId, 'gupsend:' + userId]).catch(() => {});
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    // ユーザー名が変わったので、トークンも作り直して返す(今の端末のセッションはそのまま使える)
    const out = await sessionResponse(user, { upgraded: true }, reqMeta(req));
    // ここから先は正規のアカウント。トークンだけが資格情報だった頃に持ち出された可能性のある、ほかの端末のセッションは失効させる
    // (今の端末は、いま返す新しいトークンで続けられる)
    try {
      const sid = (jwt.decode(out.token) || {}).sid;
      if (sid) await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [userId, sid]);
    } catch (e) { console.warn('[auth] guest upgrade: session cleanup failed:', e.message); }
    res.json(out);
  } catch (e) { sendServerError(res, e, 'guest-upgrade-confirm'); }
});

// --- メール認証コードの確認 ---
// body: { username, code, password }  成功したらそのままログイン状態(トークン発行)にする
// password も必須: 認証前のアカウントは登録し直しで上書きできるため、他人が同じメールで
// 自分のパスワードに書き換えた後に本人がコードを入れると、他人のパスワードのまま認証が通り乗っ取られていた。
// 認証を通すのは「今のパスワードを知っている人」+「メールを受け取れる人」が同じ場合だけにする
router.post('/verify-email', loginLimiter, async (req, res) => {
  try {
    const { username, code, password } = req.body || {};
    if (typeof username !== 'string' || typeof code !== 'string') return res.status(400).json({ error: 'メールアドレスとコードを入力してください' });
    if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'パスワードを入力してください', needsPassword: true });
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    const row = await db.get('SELECT * FROM email_codes WHERE username = ?', [username]);
    const invalid = () => res.status(400).json({ error: 'コードが正しくないか、期限切れです' });
    if (!user || !row) return invalid();
    // ここもパスワードの当てずっぽうに使えるので、ログインと同じアカウント単位のロックを共有する
    if (Number(user.locked_until || 0) > Date.now()) {
      return res.status(429).json({ error: 'ログインの失敗が続いたため、一時的にロックしています。15分ほど待ってからもう一度試してください' });
    }
    if (!user.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      await recordLoginFailure(user.id);
      return res.status(401).json({ error: 'パスワードが違います。もう一度登録し直してください', needsPassword: true });
    }
    // 認証コードの当てずっぽうが続いたら、そのアカウントの認証を24時間止める
    // (以前はパスワード再設定の失敗回数を見ていて、無関係な再設定の失敗で認証が止まり、再設定コードまで消えていた)
    if ((await resetMissCount('verify:' + username)) >= RESET_MISS_MAX_PER_DAY) {
      await db.run('DELETE FROM email_codes WHERE username = ?', [username]);
      return res.status(429).json({ error: '失敗が続いたため、このアカウントの認証を24時間止めました' });
    }
    if (Date.now() > Number(row.expires_ms) || Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) {
      await db.run('DELETE FROM email_codes WHERE username = ?', [username]);
      return invalid();
    }
    const given = Buffer.from(sha256(String(code).replace(/\s/g, '')));
    const real = Buffer.from(row.code_hash);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
      await db.run('UPDATE email_codes SET attempts = attempts + 1 WHERE username = ?', [username]);
      await resetMiss('verify:' + username);
      return invalid();
    }
    await db.run('DELETE FROM email_codes WHERE username = ?', [username]);
    if (!user.email_verified_at) await require('../utils/officialFriend').befriendOfficial(user.id);
    await db.run('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    res.json(await finishLogin({ ...user, email_verified_at: true }, {}, reqMeta(req)));
  } catch (e) {
    sendServerError(res, e, 'verify-email');
  }
});

// --- 認証コードの再送 ---
// 存在しない/認証済みのアカウントでも同じ応答を返す(アカウントの有無を探られないように)
router.post('/resend-code', loginLimiter, async (req, res) => {
  try {
    const { username } = req.body;
    if (username && isMailConfigured()) {
      const user = await db.get('SELECT email_verify_required, email_verified_at FROM users WHERE username = ?', [username]);
      if (user && truthy(user.email_verify_required) && !user.email_verified_at) {
        try { await sendEmailCode(username); } catch (e) { if (!e.cooldown) console.error('[auth] 再送失敗:', e.message); }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e, 'resend-code');
  }
});

// --- ログイン ---
// body: { username, password }
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username と password は必須です' });
  }
  if (typeof username !== 'string' || typeof password !== 'string' || password.length > 128) {
    return res.status(400).json({ error: 'ユーザー名またはパスワードが違います' });
  }

  let user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  // ゲストから変えたメールアドレスは小文字で保存している。大文字を混ぜて打っても入れるようにする
  if (!user && username.includes('@') && username !== username.toLowerCase()) {
    user = await db.get('SELECT * FROM users WHERE username = ?', [username.toLowerCase()]);
  }
  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }

  if (Number(user.locked_until || 0) > Date.now()) {
    return res.status(429).json({ error: 'ログインの失敗が続いたため、一時的にロックしています。15分ほど待ってからもう一度試してください' });
  }

  // Google連携アカウント(password_hashが空)にはパスワードログインを通さない
  const match = await bcrypt.compare(password, user.password_hash || DUMMY_HASH) && !!user.password_hash;
  if (!match) {
    await recordLoginFailure(user.id);
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }
  await clearLoginFailures(user);

  if (truthy(user.email_verify_required) && !user.email_verified_at) {
    if (isMailConfigured()) {
      try { await sendEmailCode(user.username); } catch (e) { if (!e.cooldown) console.error('[auth] 認証メール送信失敗:', e.message); }
    }
    return res.status(403).json({ needsVerification: true, username: user.username, error: 'メールアドレスの認証が済んでいません。届いたコードを入力してください' });
  }

  res.json(await finishLogin(user, {}, reqMeta(req)));
});

// --- 2段階認証コードでログイン完了 ---
// body: { twoFaToken, code }  codeは認証アプリの6桁、または予備コード
router.post('/login/2fa', loginLimiter, async (req, res) => {
  try {
    const { twoFaToken, code } = req.body;
    if (!twoFaToken || !code) return res.status(400).json({ error: 'コードを入力してください' });
    let payload;
    try {
      payload = jwt.verify(twoFaToken, TWOFA_SECRET, { algorithms: ['HS256'] });
    } catch {
      return res.status(401).json({ error: '有効時間が切れました。最初からログインし直してください', expired: true });
    }
    if (!payload || payload.purpose !== '2fa') return res.status(401).json({ error: '無効なリクエストです' });
    const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.userId]);
    if (!user || !truthy(user.totp_enabled)) return res.status(401).json({ error: '無効なリクエストです' });
    if (twoFaLocked(user.id)) {
      return res.status(429).json({ error: '失敗が続いたため一時的にロックしました。15分後にもう一度試してください' });
    }
    const ok = await checkSecondFactor(user, code);
    if (!ok) {
      twoFaFail(user.id);
      return res.status(401).json({ error: 'コードが正しくありません' });
    }
    twoFaOk(user.id);
    res.json(await sessionResponse(user, {}, reqMeta(req)));
  } catch (e) {
    sendServerError(res, e, 'login-2fa');
  }
});

// 画面側が「メールでの再設定が使えるか」を知るための公開情報(真偽値だけ)
router.get('/features', (req, res) => {
  // Buy Me a Coffee 等の支援ページ。https のURLだけ返す(環境変数 BUYMEACOFFEE_URL、未設定なら画面に出さない)
  let supportUrl = null;
  try {
    const u = new URL(String(process.env.BUYMEACOFFEE_URL || '').trim());
    if (u.protocol === 'https:') supportUrl = u.href;
  } catch (e) { /* 未設定または不正 */ }
  // ライブ翻訳(通話字幕)に必要なキーが揃っているか(真偽値だけ。キー自体は出さない)
  let liveTranslate = false;
  try {
    liveTranslate = require('../ws/callAssistProxy').isDeepgramConfigured() && require('./callAssist').isConfigured();
  } catch (e) { /* 読めなければ無効扱い */ }
  res.json({ passwordReset: isMailConfigured(), supportUrl, liveTranslate });
});

// --- パスワードを忘れた場合の再設定(メール) ---
// メール送信の設定(SMTP)がある時だけ動く。ユーザー名がメールアドレスのアカウントが対象。
// 存在しないアカウントでも同じ応答を返す(アカウントの有無を探られないように)。
router.post('/forgot-password', loginLimiter, async (req, res) => {
  try {
    let username = req.body && req.body.username;
    if (typeof username !== 'string' || !EMAIL_RE.test(username) || username.length > 254) {
      return res.json({ ok: true });
    }
    if (isMailConfigured()) {
      const user = await findByLoginName(username, 'id, username');
      // 外れが上限に達したアカウントには新しいコードを作らない(メールの連打も止まる)
      if (user) username = user.username; // ゲストから変えたアドレスは小文字で保存している。大文字を混ぜて打っても同じ人として扱う
      if (user && (await resetMissCount('reset:' + username)) < RESET_MISS_MAX_PER_DAY) {
        const now = Date.now();
        const row = await db.get('SELECT last_sent_ms FROM password_resets WHERE username = ?', [username]);
        if (!row || now - Number(row.last_sent_ms || 0) >= EMAIL_CODE_COOLDOWN_MS) {
          const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
          await db.run(
            `INSERT INTO password_resets (username, code_hash, expires_ms, attempts, last_sent_ms) VALUES (?, ?, ?, 0, ?)
             ON CONFLICT(username) DO UPDATE SET code_hash = excluded.code_hash, expires_ms = excluded.expires_ms, attempts = 0, last_sent_ms = excluded.last_sent_ms`,
            [username, sha256(code), now + EMAIL_CODE_TTL_MS, now]
          );
          try {
            await sendMail({
              to: username,
              subject: 'Bro Chat パスワード再設定コード',
              text: `Bro Chat のパスワード再設定コードです。\n\n${code}\n\n10分以内に入力してください。心当たりがない場合はこのメールを無視してください(パスワードは変わりません)。`,
            });
          } catch (e) {
            console.error('[auth] 再設定メール送信失敗:', e.message);
          }
        }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e, 'forgot-password');
  }
});

// body: { username, code, newPassword, totpCode? }  2段階認証が有効なアカウントは totpCode も必要
// パスワード再設定コードの外れ回数(アカウントごと、24時間)。IPを変えながら
// 「1分ごとに新しいコード→5回ずつ当てずっぽう」を繰り返されると、IP単位の制限では止まらなかった
const RESET_MISS_MAX_PER_DAY = 15;
const MISS_WINDOW_MS = 24 * 3600 * 1000;
// 以前はメモリのMapで数えていたが、(1)再設定の側では数えるだけで判定しておらず上限が効いていなかった
// (2)Renderの再起動で消える。DBに置いて、再設定・メール認証の両方で判定する
async function resetMissCount(key) {
  const r = await db.get('SELECT n, since_ms FROM auth_misses WHERE key = ?', [key]);
  if (!r || Date.now() - Number(r.since_ms) > MISS_WINDOW_MS) return 0;
  return Number(r.n);
}
async function resetMiss(key) {
  const now = Date.now();
  const r = await db.get('SELECT n, since_ms FROM auth_misses WHERE key = ?', [key]);
  if (!r || now - Number(r.since_ms) > MISS_WINDOW_MS) {
    await db.run(`INSERT INTO auth_misses (key, n, since_ms) VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET n = 1, since_ms = excluded.since_ms`, [key, now]);
  } else {
    await db.run('UPDATE auth_misses SET n = n + 1 WHERE key = ?', [key]);
  }
}

router.post('/reset-password', loginLimiter, async (req, res) => {
  try {
    let { username, code, newPassword, totpCode } = req.body || {};
    if (typeof username !== 'string' || typeof code !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: '入力内容が正しくありません' });
    }
    { const u0 = await findByLoginName(username, 'username'); if (u0) username = u0.username; }
    const invalid = () => res.status(400).json({ error: 'コードが正しくないか、期限切れです' });
    const pwErr = validatePassword(newPassword, username);
    if (pwErr) return res.status(400).json({ error: pwErr });

    // 「1分ごとに新しいコード→5回ずつ当てずっぽう」をIPを変えながら続けられないよう、アカウント単位で24時間止める
    if ((await resetMissCount('reset:' + username)) >= RESET_MISS_MAX_PER_DAY) {
      await db.run('DELETE FROM password_resets WHERE username = ?', [username]);
      return res.status(429).json({ error: '失敗が続いたため、このアカウントの再設定を24時間止めました' });
    }
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    const row = await db.get('SELECT * FROM password_resets WHERE username = ?', [username]);
    if (!user || !row) return invalid();
    if (Date.now() > Number(row.expires_ms) || Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) {
      await db.run('DELETE FROM password_resets WHERE username = ?', [username]);
      return invalid();
    }
    const given = Buffer.from(sha256(code.replace(/\s/g, '')));
    const real = Buffer.from(row.code_hash);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
      await db.run('UPDATE password_resets SET attempts = attempts + 1 WHERE username = ?', [username]);
      await resetMiss('reset:' + username);
      return invalid();
    }
    // メールを押さえられただけで2段階認証を迂回されないよう、2FAが有効なら認証アプリのコードも必須にする
    if (truthy(user.totp_enabled)) {
      if (twoFaLocked(user.id)) return res.status(429).json({ error: '失敗が続いたため一時的にロックしました。15分後にもう一度試してください' });
      if (!totpCode || !(await checkSecondFactor(user, totpCode))) {
        twoFaFail(user.id);
        return res.status(401).json({ error: '2段階認証のコードが正しくありません', needs2fa: true });
      }
      twoFaOk(user.id);
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.run(
      'UPDATE users SET password_hash = ?, token_revoked_at = CURRENT_TIMESTAMP, failed_login_count = 0, locked_until = 0, email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP) WHERE id = ?',
      [newHash, user.id]
    );
    await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
    await db.run('DELETE FROM password_resets WHERE username = ?', [username]);
    // 盗まれた時の再設定なら、盗んだ人が足した端末の鍵に送り続けないようにする。本人の端末は開いた時に戻る
    await require('../utils/deviceKeys').clearAll(user.id);
    sessionEvents.emit('revoked', { userId: user.id });
    res.json({ ok: true, message: 'パスワードを変更しました。新しいパスワードでログインしてください。' });
  } catch (e) {
    sendServerError(res, e, 'reset-password');
  }
});

// --- Google OAuth ログイン ---
// POST /api/auth/google
// body: { idToken } (Google Sign-In から取得したIDトークン)
// IDトークンを検証してログイン/自動登録まで行う共通処理。{ status, body } を返す。
// expectedNonce がある場合(アプリのシステムブラウザ経由)は、トークンのnonceも一致を確認する。
async function googleLoginFromIdToken(idToken, expectedNonce, meta) {
  try {
    // Google IDトークンの署名・発行者・有効期限・audience(このアプリ向けに
    // 発行されたものか)をすべてGoogleの公開鍵で検証する。
    // 以前はペイロードをBase64デコードするだけで署名を一切確認していなかったため、
    // 誰でも任意のメールアドレスを名乗る偽トークンを作ってなりすませる状態だった。
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) return { status: 401, body: { error: 'Invalid idToken' } };
    if (expectedNonce && payload.nonce !== expectedNonce) return { status: 401, body: { error: 'Google認証に失敗しました' } };
    // メールアドレスがGoogle側で検証済みであることも確認する
    // (未検証メールアドレスでのなりすまし登録を防ぐ)
    if (payload.email_verified === false) return { status: 401, body: { error: 'メールアドレスが未検証です' } };

    const { email, name, picture } = payload;
    // Googleで初めて来た人は、Googleアカウントの氏名を本名の初期値にする(あとで設定から直せる)
    const googleReal = cleanRealName([payload.family_name, payload.given_name].filter(Boolean).join(' ') || name || '').value || null;

    // GoogleメールアドレスをユーザーIDの代わりに使用
    let user = await db.get('SELECT * FROM users WHERE username = ?', [email]);

    if (!user) {
      // 初回ログイン：ユーザーを自動作成
      const userId = uuidv4();
      const userIdCode = await uniqueUserIdCode();
      await db.run(
        'INSERT INTO users (id, user_id, username, password_hash, display_name, profile_pic, email_verified_at, real_name) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)',
        [userId, userIdCode, email, '', name || email, picture || '', googleReal]
      );
      await require('../utils/officialFriend').befriendOfficial(userId);
      user = { id: userId, user_id: userIdCode, username: email, display_name: name || email, profile_pic: picture || '' };
    } else {
      // 既存ユーザー：プロフィール写真を更新。ただし自分で設定した画像は上書きしない
      // (以前はGoogleでログインし直すたびに、設定したアイコンがGoogleの写真に戻っていた)
      if (picture && (!user.profile_pic || /^https:\/\/[^/]*googleusercontent\.com\//.test(String(user.profile_pic)))) {
        await db.run('UPDATE users SET profile_pic = ? WHERE id = ?', [picture, user.id]);
        user.profile_pic = picture;
      }
      // メール認証待ちのまま残っていた登録に、そのメールの本当の持ち主がGoogleで来た場合。
      // 認証前のパスワードは第三者が設定した可能性があるので消して、Googleで認証済みにする
      // (以前は先に他人のメールで登録しておくと、本人がGoogleログインした時に
      //  その乗っ取り側のパスワードが残ったアカウントへ入ってしまっていた)。
      if (truthy(user.email_verify_required) && !user.email_verified_at) {
        await db.run("UPDATE users SET password_hash = '', email_verified_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
        user.password_hash = '';
      } else if (!user.email_verified_at && user.password_hash) {
        // メール送信(SMTP)が未設定の時期に作られたパスワード登録は、メールの持ち主かを一度も確かめていない。
        // 他人のGmailアドレスで先に登録しておけば、本人が後からGoogleでログインした時に
        // 乗っ取り側がパスワードを知っているアカウントへ本人を入らせ、以後の会話を読めてしまう。
        // Googleで本人確認が取れたこの時点で、未確認のパスワードと既存の全セッションを無効にする
        // (本人のパスワードだった場合は、パスワード再設定で付け直せる)。
        await db.run(
          "UPDATE users SET password_hash = '', email_verified_at = CURRENT_TIMESTAMP, token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
          [user.id]
        );
        await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [user.id]);
        sessionEvents.emit('revoked', { userId: user.id });
        user.password_hash = '';
      } else if (!user.email_verified_at) {
        await db.run('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
      }
    }
    return { status: 200, body: await finishLogin(user, { profilePic: user.profile_pic }, meta) };
  } catch (e) {
    // verifyIdTokenは署名不正・期限切れ・audience不一致などで例外を投げる。
    // これらは全て「なりすまし試行または壊れたトークン」として一律401にする
    // (詳細なエラー内容を返すと、攻撃者に検証ロジックの手がかりを与えるため)
    console.error('Google OAuth verification failed:', e.message);
    return { status: 401, body: { error: 'Google認証に失敗しました' } };
  }
}

router.post('/google', loginLimiter, async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });
  const r = await googleLoginFromIdToken(idToken, null, reqMeta(req));
  res.status(r.status).json(r.body);
});

// --- アプリ(Capacitor WebView)用のGoogleログイン ---
// GoogleはWebView内でのログイン画面表示をブロックするため、アプリはシステムのブラウザでGoogleを開き、
// 結果をサーバー経由でアプリが受け取る(ポーリング)。アプリ本体のAPK変更は不要。
//   1) POST /google/app-start {state}  -> Googleの認証URLを返す(アプリがシステムブラウザで開く)
//   2) ブラウザ側 /google-callback.html が id_token を POST /google/app-relay {state, idToken}
//   3) アプリが GET /google/app-poll?state= を繰り返し、結果(1回だけ)を受け取る
const googleAppPending = new Map(); // state -> { nonce, ts, result }
const GOOGLE_APP_TTL_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of googleAppPending) if (now - v.ts > GOOGLE_APP_TTL_MS) googleAppPending.delete(k);
}, 60 * 1000).unref();
const GOOGLE_STATE_RE = /^[A-Za-z0-9_-]{22,64}$/;

function publicBase(req) {
  const known = require('../utils/siteHosts').knownBase(req);
  if (known) return known; // 独自ドメインで開いている時は、そのドメインに戻す(元のURLに飛ばすと学校では開けない)
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return proto + '://' + req.get('host');
}

router.post('/google/app-start', loginLimiter, (req, res) => {
  // state はサーバーが作る。以前はクライアントが好きな値を送れ、app-poll にも認証が無かったため、
  // 攻撃者が自分で決めた state で app-start を叩いて、その認証URLを相手に踏ませれば、
  // 相手がGoogleでログインした結果(= そのアカウントのトークン)を app-poll で受け取れてしまった。
  // 併せて、結果を受け取るための合言葉(pollKey)を app-start の呼び出し元にだけ返す。
  if (googleAppPending.size > 2000) return res.status(429).json({ error: 'busy' });
  const crypto = require('crypto');
  const state = crypto.randomBytes(24).toString('base64url');
  const pollKey = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  // 確認番号: アプリの画面とブラウザの画面の両方に出して、同じか見比べてもらう。
  // 他人が始めたログインのURLを踏まされた人は、アプリ側の番号を見ていないので気づける
  const code = String(crypto.randomInt(1000, 10000));
  googleAppPending.set(state, { nonce, ts: Date.now(), result: null, pollKey, code });
  const redirectUri = publicBase(req) + '/google-callback.html';
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'id_token',
    scope: 'openid email profile',
    nonce,
    state,
    prompt: 'select_account',
  });
  res.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString(), redirectUri, state, pollKey, code });
});

// ブラウザ側(google-callback.html)に確認番号を出すため
router.get('/google/app-code', loginLimiter, (req, res) => {
  const state = String(req.query.state || '');
  const pend = GOOGLE_STATE_RE.test(state) ? googleAppPending.get(state) : null;
  if (!pend) return res.status(404).json({ error: '有効時間が切れました。アプリからやり直してください' });
  res.json({ code: pend.code || null });
});

router.post('/google/app-relay', loginLimiter, async (req, res) => {
  const { state, idToken } = req.body || {};
  const pend = typeof state === 'string' ? googleAppPending.get(state) : null;
  if (!pend || !idToken) return res.status(400).json({ error: '有効時間が切れました。アプリからやり直してください' });
  if (pend.result) return res.json({ ok: true });
  const r = await googleLoginFromIdToken(idToken, pend.nonce, reqMeta(req));
  pend.result = r;
  res.status(r.status === 200 ? 200 : r.status).json(r.status === 200 ? { ok: true } : r.body);
});

router.get('/google/app-poll', (req, res) => {
  const state = String(req.query.state || '');
  const pend = GOOGLE_STATE_RE.test(state) ? googleAppPending.get(state) : null;
  if (!pend) return res.status(404).json({ error: 'expired' });
  // app-start を呼んだ本人だけが結果(トークン)を受け取れる
  const given = Buffer.from(sha256(String(req.query.key || '')), 'hex');
  const want = Buffer.from(sha256(pend.pollKey || ''), 'hex');
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return res.status(404).json({ error: 'expired' });
  }
  if (!pend.result) return res.json({ pending: true });
  googleAppPending.delete(state); // 結果は1回だけ渡す
  res.status(pend.result.status).json(pend.result.body);
});

// --- Google連絡先同期（Google People API） ---
// 認証必須: 以前はbody.userIdをクライアントの自己申告のまま信用しており、
// 誰でも任意のuserIdを指定して他人のアカウントへ大量の友達申請を
// 送りつけられる状態だった。JWTから取得した本人のuserIdのみを使う。
// 本名: 本人だけが見て直せる(ほかの人のプロフィールには出ない)
router.get('/real-name', verifyToken, async (req, res) => {
  const r = await db.get('SELECT real_name FROM users WHERE id = ?', [req.userId]);
  res.json({ realName: (r && r.real_name) || '' });
});
router.put('/real-name', verifyToken, async (req, res) => {
  const rn = cleanRealName(req.body && req.body.realName);
  if (rn.error) return res.status(400).json({ error: rn.error });
  await db.run('UPDATE users SET real_name = ? WHERE id = ?', [rn.value, req.userId]);
  res.json({ ok: true, realName: rn.value });
});

router.post('/google-contacts/sync', verifyToken, async (req, res) => {
  // 今のアプリはこの機能を使っていない。どのアプリ向けのGoogleトークンでも受け付け、
  // 「そのメールの人がBro Chatにいるか」を調べられ、ブロックも無視して友だち申請を
  // まとめて送れる状態だったので、作り直すまで止めておく
  return res.status(410).json({ error: 'この機能は現在止めています' });
  // eslint-disable-next-line no-unreachable
  const { accessToken } = req.body;
  const userId = req.user.userId;
  if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

  try {
    // Google People API から連絡先取得
    const response = await fetch('https://people.googleapis.com/v1/people/me/connections?personFields=names,emailAddresses&pageSize=1000', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();

    if (!data.connections) return res.json({ ok: true, count: 0 });

    // 連絡先のメールアドレスを抽出
    const emails = new Set();
    data.connections.forEach(person => {
      if (person.emailAddresses) {
        person.emailAddresses.forEach(e => emails.add(e.value.toLowerCase()));
      }
    });

    // 連絡先が1件も無い場合、IN()という不正なSQLになるため早期return
    if (emails.size === 0) return res.json({ ok: true, count: 0, totalFound: 0 });

    // Bro Chatユーザーと照合
    const users = await db.all('SELECT id, username FROM users WHERE LOWER(username) IN (' + Array(emails.size).fill('?').join(',') + ')', Array.from(emails));
    const foundUserIds = new Set(users.map(u => u.id));

    // 既存の友達を取得
    const existingFriends = await db.all(
      "SELECT * FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status IN ('accepted', 'pending')",
      [userId, userId]
    );
    const existingIds = new Set();
    existingFriends.forEach(f => {
      if (f.user_a_id === userId) existingIds.add(f.user_b_id);
      else existingIds.add(f.user_a_id);
    });

    // 新規友達申請（既存除外）
    let count = 0;
    for (const newFriendId of foundUserIds) {
      if (newFriendId !== userId && !existingIds.has(newFriendId)) {
        await db.run(
          'INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)',
          [uuidv4(), ...[userId, newFriendId].sort(), 'pending', userId, new Date().toISOString()]
        );
        count++;
      }
    }

    res.json({ ok: true, count, totalFound: foundUserIds.size });
  } catch (e) {
    sendServerError(res, e, 'google-contacts/sync');
  }
});

// --- JWT検証ミドルウェア (他ルート・WebSocketから共有利用) ---
// 実体は utils/authMiddleware.js に一元化されている(トークン失効チェック込み)。
// 既存コードが `require('./auth')` 経由で verifyToken / verifyTokenRaw を
// 参照しているため、後方互換のためここから再エクスポートする。
// verifyTokenRaw は WebSocket認証(ws/wsServer.js)向けに残しているが、
// DBの失効チェックを含むため非同期関数になっている点に注意
// (呼び出し側は await する必要がある)。
async function verifyTokenRaw(token) {
  return verifyTokenWithRevocation(token);
}

// --- パスワード変更 ---
// body: { currentPassword, newPassword }
// 変更後、既存の全セッションを自動的に失効させる(トークン漏洩対策)。
router.post('/change-password', verifyToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: '現在のパスワードと新しいパスワードは必須です' });
    }
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      return res.status(400).json({ error: 'パスワードが正しくありません' });
    }
    const pwErr = validatePassword(newPassword, req.user.username);
    if (pwErr) return res.status(400).json({ error: pwErr });
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: '今のパスワードと同じです。別のパスワードにしてください' });
    }

    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.userId]);
    if (!user || !user.password_hash) {
      return res.status(400).json({ error: 'パスワードが設定されていないアカウントです（Google連携アカウント）' });
    }

    const match = await bcrypt.compare(currentPassword, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: '現在のパスワードが違います' });
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await db.run('UPDATE users SET password_hash = ?, token_revoked_at = CURRENT_TIMESTAMP, failed_login_count = 0, locked_until = 0 WHERE id = ?',
      [newHash, req.user.userId]);
    await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [req.user.userId]);

    // 新しいトークンを発行(変更直後に再ログインさせないため)。
    // token_revoked_at とiatが同じ秒だと失効扱いになるので、sid付き(セッション有効判定)で発行する。
    const token = await issueToken({ id: req.user.userId, username: req.user.username }, reqMeta(req));
    await require('../utils/deviceKeys').clearAll(req.user.userId); // 盗まれた端末の鍵にはもう送らない。本人の端末は開いた時に戻る
    sessionEvents.emit('revoked', { userId: req.user.userId }); // 旧セッションのWebSocketを全て切る(この端末は新トークンで繋ぎ直す)
    res.json({ ok: true, token, message: 'パスワードを変更しました。他の全端末からサインアウトされます。' });
  } catch (e) {
    sendServerError(res, e, 'change-password');
  }
});

// 全端末からサインアウト: 今このリクエストを送っているトークン以外も含め、
// これまで発行された全てのJWTを即座に無効化する。
// 端末紛失・トークン漏洩が疑われる場合に、パスワード変更を待たずに使える。
router.post('/revoke-all-sessions', verifyToken, async (req, res) => {
  try {
    await db.run('UPDATE users SET token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?', [req.user.userId]);
    await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [req.user.userId]);
    // ほかの端末の暗号鍵にも、これからは送らない(次に開いた端末が自分の鍵を登録し直す)
    await require('../utils/deviceKeys').clearAll(req.user.userId);
    sessionEvents.emit('revoked', { userId: req.user.userId });
    res.json({ ok: true, message: '全端末のセッションを無効化しました。再度ログインしてください。' });
  } catch (e) {
    sendServerError(res, e, 'revoke-all-sessions');
  }
});

// --- 2段階認証の管理(要ログイン) ---
router.get('/2fa/status', verifyToken, async (req, res) => {
  try {
    const user = await db.get('SELECT totp_enabled, backup_codes FROM users WHERE id = ?', [req.user.userId]);
    let left = 0;
    try { left = JSON.parse(user.backup_codes || '[]').length; } catch {}
    res.json({ enabled: truthy(user && user.totp_enabled), backupCodesLeft: left });
  } catch (e) {
    sendServerError(res, e, '2fa-status');
  }
});

// 設定開始: 秘密鍵を作って返す(有効化はコード確認後)
router.post('/2fa/setup', verifyToken, async (req, res) => {
  try {
    const user = await db.get('SELECT username, totp_enabled FROM users WHERE id = ?', [req.user.userId]);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    if (truthy(user.totp_enabled)) return res.status(400).json({ error: 'すでに有効です' });
    const secret = generateSecret();
    await db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secretBox.encrypt(secret), req.user.userId]);
    const pwRow = await db.get('SELECT password_hash FROM users WHERE id = ?', [req.user.userId]);
    res.json({ secret, uri: otpauthUri(secret, user.username), needsPassword: !!(pwRow && pwRow.password_hash) });
  } catch (e) {
    sendServerError(res, e, '2fa-setup');
  }
});

// 有効化: 認証アプリの6桁コードで確認できたら有効にして、予備コードを1回だけ返す
router.post('/2fa/enable', verifyToken, loginLimiter, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!user || !user.totp_secret) return res.status(400).json({ error: '先に設定を開始してください' });
    if (truthy(user.totp_enabled)) return res.status(400).json({ error: 'すでに有効です' });
    // トークンだけで有効にできると、盗んだ人が2FAを入れて本人を締め出せる。パスワードがある人には確認する
    if (user.password_hash) {
      const pw = req.body && req.body.password;
      if (typeof pw !== 'string' || !pw || pw.length > 200 || !(await bcrypt.compare(pw, user.password_hash))) {
        return res.status(403).json({ error: 'パスワードが正しくありません', code: 'PASSWORD_REQUIRED' });
      }
    }
    const plainSecret = secretBox.decrypt(user.totp_secret);
    const step = plainSecret ? verifyTotp(plainSecret, req.body.code) : null;
    if (step === null) return res.status(400).json({ error: 'コードが正しくありません' });
    const { plain, hashes } = generateBackupCodes();
    await db.run('UPDATE users SET totp_enabled = ?, totp_last_step = ?, backup_codes = ? WHERE id = ?',
      [true, step, JSON.stringify(hashes), user.id]);
    res.json({ ok: true, backupCodes: plain });
  } catch (e) {
    sendServerError(res, e, '2fa-enable');
  }
});

// 無効化: パスワード(あれば) + 現在のコードが必要。ログインしっぱなしの端末を拾われても外せないように。
router.post('/2fa/disable', verifyToken, loginLimiter, async (req, res) => {
  try {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.userId]);
    if (!user || !truthy(user.totp_enabled)) return res.status(400).json({ error: '有効になっていません' });
    if (twoFaLocked(user.id)) return res.status(429).json({ error: '失敗が続いたため一時的にロックしました。15分後にもう一度試してください' });
    if (user.password_hash) {
      const okPw = req.body.password && await bcrypt.compare(req.body.password, user.password_hash);
      if (!okPw) return res.status(401).json({ error: 'パスワードが違います' });
    }
    const ok = await checkSecondFactor(user, req.body.code);
    if (!ok) { twoFaFail(user.id); return res.status(401).json({ error: 'コードが正しくありません' }); }
    twoFaOk(user.id);
    await db.run('UPDATE users SET totp_enabled = ?, totp_secret = NULL, totp_last_step = 0, backup_codes = NULL WHERE id = ?', [false, user.id]);
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e, '2fa-disable');
  }
});

// --- ログイン中の端末(セッション)の一覧と、端末ごとのサインアウト ---
router.get('/sessions', verifyToken, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT id, device, ip, created_at, last_seen_at FROM user_sessions
        WHERE user_id = ? AND revoked_at IS NULL ORDER BY last_seen_at DESC LIMIT 30`,
      [req.user.userId]
    );
    res.json({
      sessions: rows.map(r => ({
        id: r.id,
        device: r.device || '不明な端末',
        ip: r.ip || '',
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        current: !!req.user.sid && r.id === req.user.sid,
      })),
    });
  } catch (e) {
    sendServerError(res, e, 'sessions-list');
  }
});

// body: { id }  自分のセッションだけ失効できる。今の端末を指定すればサインアウトになる。
router.post('/sessions/revoke', verifyToken, async (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (typeof id !== 'string' || !id) return res.status(400).json({ error: 'id が必要です' });
    await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL', [id, req.user.userId]);
    sessionEvents.emit('revoked', { userId: req.user.userId, sid: id });
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e, 'sessions-revoke');
  }
});

// ログアウト: この端末のセッションだけ失効させる(sid無しの古いトークンは何もしない)
router.post('/logout', verifyToken, async (req, res) => {
  try {
    // この端末のプッシュ宛先も外す。残すと、ログアウトした後もこの端末に通知・着信が届き、
    // 同じ端末で別アカウントを使うと、そのアカウントとの通話で自分の端末が鳴ってしまう
    const fcmToken = req.body && req.body.fcmToken;
    if (typeof fcmToken === 'string' && fcmToken.length > 20 && fcmToken.length < 4096) {
      try { await require('../utils/fcm').removeToken(req.user.userId, fcmToken); } catch (e) { console.error('[auth] fcm removeToken:', e.message); }
    }
    if (req.user.sid) {
      await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?', [req.user.sid, req.user.userId]);
      sessionEvents.emit('revoked', { userId: req.user.userId, sid: req.user.sid });
    }
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e, 'logout');
  }
});

// --- アカウント削除 ---
// body: { password } (Google連携アカウントの場合は不要)
// ユーザーデータを完全に削除する。メッセージのcontent列は空文字に置換し、
// メタデータ(sender_id/recipient_id等)は外部キー制約の関係でnullにできないため
// そのまま残る(相手側の会話画面で「退会済みユーザー」と表示する想定)。
router.post('/delete-account', verifyToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const user = await db.get('SELECT password_hash FROM users WHERE id = ?', [userId]);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    // パスワードがあるアカウント(非Google)は現在のパスワードで本人確認
    if (user.password_hash) {
      const { password } = req.body;
      if (!password) return res.status(400).json({ error: '確認のため現在のパスワードを入力してください' });
      const match = await bcrypt.compare(password, user.password_hash);
      if (!match) return res.status(401).json({ error: 'パスワードが違います' });
    }

    // メッセージ内容を消去(メタデータは残す)
    await db.run("UPDATE messages SET content = '', deleted_at = CURRENT_TIMESTAMP WHERE sender_id = ?", [userId]);
    await db.run("UPDATE group_messages SET content = '', deleted_at = CURRENT_TIMESTAMP WHERE sender_id = ?", [userId]);
    // 関連データ削除
    await db.run('DELETE FROM push_subscriptions WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM one_time_prekeys WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM identity_keys WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM message_reactions WHERE user_id = ?', [userId]);
    await db.run('DELETE FROM offline_queue WHERE sender_id = ? OR recipient_id = ?', [userId, userId]);
    await db.run('DELETE FROM call_notes WHERE owner_id = ?', [userId]);
    await db.run('DELETE FROM call_summaries WHERE owner_id = ?', [userId]);
    // ログイン関連の残り(2FA秘密鍵・予備コード・認証コード・端末セッション・プッシュ宛先)も消す
    await db.run('UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL', [userId]);
    await db.run('DELETE FROM email_codes WHERE username = (SELECT username FROM users WHERE id = ?)', [userId]);
    try { await db.run('DELETE FROM fcm_tokens WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] fcm_tokens cleanup:', e.message); }
    try { await db.run('DELETE FROM key_backups WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] key_backups cleanup:', e.message); }
    try { await db.run('DELETE FROM user_pubkeys WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] user_pubkeys cleanup:', e.message); }
    try { await db.run('DELETE FROM guest_upgrades WHERE user_id = ?', [userId]); } catch (e) { console.error('[auth] guest_upgrades cleanup:', e.message); }
    // 自分が作った招待コード(と、そのコードの使用記録)・自分が使った記録も消す
    try {
      await db.run('DELETE FROM invite_redemptions WHERE code IN (SELECT code FROM invite_codes WHERE owner_id = ?) OR user_id = ?', [userId, userId]);
      await db.run('DELETE FROM invite_codes WHERE owner_id = ?', [userId]);
    } catch (e) { console.error('[auth] invite cleanup:', e.message); }
    // 投稿とコメントも消す(以前は退会後も「退会済みユーザー」の名前で公開のまま残っていた)
    try {
      await db.run('UPDATE posts SET deleted_at = CURRENT_TIMESTAMP WHERE author_id = ? AND deleted_at IS NULL', [userId]);
      await db.run('UPDATE post_comments SET deleted_at = CURRENT_TIMESTAMP WHERE author_id = ? AND deleted_at IS NULL', [userId]);
    } catch (e) { console.error('[auth] posts cleanup:', e.message); }
    // 入っていたグループから抜ける(以前は退会後もメンバーのまま残り、オーナーだった場合は誰も管理できないグループになった)
    try {
      const mine = await db.all(
        'SELECT g.id, g.owner_id FROM groups g JOIN group_members gm ON gm.group_id = g.id WHERE gm.user_id = ? AND gm.left_at IS NULL',
        [userId]
      );
      for (const g of mine) {
        if (g.owner_id !== userId) continue;
        const next = await db.get(
          'SELECT user_id FROM group_members WHERE group_id = ? AND user_id <> ? AND left_at IS NULL ORDER BY joined_at ASC LIMIT 1',
          [g.id, userId]
        );
        if (next) await db.run('UPDATE groups SET owner_id = ? WHERE id = ?', [next.user_id, g.id]);
      }
      await db.run('UPDATE group_members SET left_at = CURRENT_TIMESTAMP WHERE user_id = ? AND left_at IS NULL', [userId]);
    } catch (e) { console.error('[auth] group cleanup:', e.message); }
    // ユーザー情報の匿名化(外部キー制約のため行自体は残す)。本名も消す
    await db.run('UPDATE users SET real_name = NULL WHERE id = ?', [userId]);
    await db.run(
      "UPDATE users SET username = ?, password_hash = '', display_name = '退会済みユーザー', profile_pic = '', bio = '', public_key = NULL, totp_secret = NULL, totp_enabled = ?, backup_codes = NULL, token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
      [`deleted_${userId}`, false, userId]
    );
    sessionEvents.emit('revoked', { userId }); // 繋がったままのWebSocketも切る

    res.json({ ok: true, message: 'アカウントを削除しました' });
  } catch (e) {
    sendServerError(res, e, 'delete-account');
  }
});

module.exports = { router, verifyToken, verifyTokenRaw, JWT_SECRET };
