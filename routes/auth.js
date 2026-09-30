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
const { loginLimiter, registerLimiter } = require('../utils/rateLimits');
const { sendServerError } = require('../utils/errorResponse');
const { verifyToken, verifyTokenWithRevocation } = require('../utils/authMiddleware');
const { isMailConfigured, sendMail } = require('../utils/mailer');
const { generateSecret, verifyTotp, otpauthUri } = require('../utils/totp');

const router = express.Router();
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

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const truthy = (v) => v === true || v === 1 || v === '1' || v === 't' || v === 'true';

function sessionResponse(user, extra = {}) {
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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
function finishLogin(user, extra = {}) {
  if (truthy(user.totp_enabled)) {
    const twoFaToken = jwt.sign({ userId: user.id, purpose: '2fa' }, TWOFA_SECRET, { expiresIn: TWOFA_TOKEN_TTL });
    return { needs2fa: true, twoFaToken };
  }
  return sessionResponse(user, extra);
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
    const step = verifyTotp(user.totp_secret, code);
    if (step === null) return false;
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
router.post('/register', registerLimiter, async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username と password は必須です' });
  }
  // 6文字は現代の基準では弱すぎる(オフライン総当たりに対して脆弱)ため8文字以上に強化。
  // 併せて、パスワードとして極端に長い文字列(bcryptはハッシュ化に時間がかかるため
  // DoS化を防ぐ意味もある)も拒否する。
  if (password.length < 8) {
    return res.status(400).json({ error: 'パスワードは8文字以上にしてください' });
  }
  if (password.length > 128) {
    return res.status(400).json({ error: 'パスワードが長すぎます' });
  }
  if (username.length > 254) {
    return res.status(400).json({ error: 'ユーザー名が長すぎます' });
  }
  if (username.length < 3) {
    return res.status(400).json({ error: 'ユーザー名は3文字以上にしてください' });
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
    await db.run('UPDATE users SET password_hash = ?, display_name = ? WHERE id = ?', [passwordHash, displayName || username, userId]);
  } else {
    // bcryptのコスト係数: 10→12に引き上げ。総当たり耐性が上がる一方、
    // ハッシュ化にかかる時間は数十ms程度の増加に留まりログイン体感には影響しない。
    userId = uuidv4();
    userIdCode = 'U' + Math.random().toString(36).substring(2, 8).toUpperCase(); // User ID like U3K7F9
    await db.run(
      'INSERT INTO users (id, user_id, username, password_hash, display_name, email_verify_required) VALUES (?, ?, ?, ?, ?, ?)',
      [userId, userIdCode, username, passwordHash, displayName || username, mailOn ? 1 : 0]
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

  const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
  res.json(sessionResponse(user));
});

// --- メール認証コードの確認 ---
// body: { username, code }  成功したらそのままログイン状態(トークン発行)にする
router.post('/verify-email', loginLimiter, async (req, res) => {
  try {
    const { username, code } = req.body;
    if (!username || !code) return res.status(400).json({ error: 'メールアドレスとコードを入力してください' });
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    const row = await db.get('SELECT * FROM email_codes WHERE username = ?', [username]);
    const invalid = () => res.status(400).json({ error: 'コードが正しくないか、期限切れです' });
    if (!user || !row) return invalid();
    if (Date.now() > Number(row.expires_ms) || Number(row.attempts) >= EMAIL_CODE_MAX_ATTEMPTS) {
      await db.run('DELETE FROM email_codes WHERE username = ?', [username]);
      return invalid();
    }
    const given = Buffer.from(sha256(String(code).replace(/\s/g, '')));
    const real = Buffer.from(row.code_hash);
    if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
      await db.run('UPDATE email_codes SET attempts = attempts + 1 WHERE username = ?', [username]);
      return invalid();
    }
    await db.run('DELETE FROM email_codes WHERE username = ?', [username]);
    await db.run('UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
    res.json(finishLogin({ ...user, email_verified_at: true }));
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

  const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
  if (!user) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
  }

  if (truthy(user.email_verify_required) && !user.email_verified_at) {
    if (isMailConfigured()) {
      try { await sendEmailCode(user.username); } catch (e) { if (!e.cooldown) console.error('[auth] 認証メール送信失敗:', e.message); }
    }
    return res.status(403).json({ needsVerification: true, username: user.username, error: 'メールアドレスの認証が済んでいません。届いたコードを入力してください' });
  }

  res.json(finishLogin(user));
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
    res.json(sessionResponse(user));
  } catch (e) {
    sendServerError(res, e, 'login-2fa');
  }
});

// --- Google OAuth ログイン ---
// POST /api/auth/google
// body: { idToken } (Google Sign-In から取得したIDトークン)
// IDトークンを検証してログイン/自動登録まで行う共通処理。{ status, body } を返す。
// expectedNonce がある場合(アプリのシステムブラウザ経由)は、トークンのnonceも一致を確認する。
async function googleLoginFromIdToken(idToken, expectedNonce) {
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

    // GoogleメールアドレスをユーザーIDの代わりに使用
    let user = await db.get('SELECT * FROM users WHERE username = ?', [email]);

    if (!user) {
      // 初回ログイン：ユーザーを自動作成
      const userId = uuidv4();
      const userIdCode = 'U' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await db.run(
        'INSERT INTO users (id, user_id, username, password_hash, display_name, profile_pic) VALUES (?, ?, ?, ?, ?, ?)',
        [userId, userIdCode, email, '', name || email, picture || '']
      );
      user = { id: userId, user_id: userIdCode, username: email, display_name: name || email, profile_pic: picture || '' };
    } else {
      // 既存ユーザー：プロフィール写真を更新
      if (picture) {
        await db.run('UPDATE users SET profile_pic = ? WHERE id = ?', [picture, user.id]);
      }
      // メール認証待ちのまま残っていた登録に、そのメールの本当の持ち主がGoogleで来た場合。
      // 認証前のパスワードは第三者が設定した可能性があるので消して、Googleで認証済みにする
      // (以前は先に他人のメールで登録しておくと、本人がGoogleログインした時に
      //  その乗っ取り側のパスワードが残ったアカウントへ入ってしまっていた)。
      if (truthy(user.email_verify_required) && !user.email_verified_at) {
        await db.run("UPDATE users SET password_hash = '', email_verified_at = CURRENT_TIMESTAMP WHERE id = ?", [user.id]);
        user.password_hash = '';
      }
    }
    return { status: 200, body: finishLogin(user, { profilePic: user.profile_pic }) };
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
  const r = await googleLoginFromIdToken(idToken, null);
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
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  return proto + '://' + req.get('host');
}

router.post('/google/app-start', loginLimiter, (req, res) => {
  const state = req.body && req.body.state;
  if (typeof state !== 'string' || !GOOGLE_STATE_RE.test(state)) return res.status(400).json({ error: 'state invalid' });
  if (googleAppPending.size > 2000) return res.status(429).json({ error: 'busy' });
  const nonce = require('crypto').randomBytes(16).toString('hex');
  googleAppPending.set(state, { nonce, ts: Date.now(), result: null });
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
  res.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + q.toString(), redirectUri });
});

router.post('/google/app-relay', loginLimiter, async (req, res) => {
  const { state, idToken } = req.body || {};
  const pend = typeof state === 'string' ? googleAppPending.get(state) : null;
  if (!pend || !idToken) return res.status(400).json({ error: '有効時間が切れました。アプリからやり直してください' });
  if (pend.result) return res.json({ ok: true });
  const r = await googleLoginFromIdToken(idToken, pend.nonce);
  pend.result = r;
  res.status(r.status === 200 ? 200 : r.status).json(r.status === 200 ? { ok: true } : r.body);
});

router.get('/google/app-poll', (req, res) => {
  const state = String(req.query.state || '');
  const pend = GOOGLE_STATE_RE.test(state) ? googleAppPending.get(state) : null;
  if (!pend) return res.status(404).json({ error: 'expired' });
  if (!pend.result) return res.json({ pending: true });
  googleAppPending.delete(state); // 結果は1回だけ渡す
  res.status(pend.result.status).json(pend.result.body);
});

// --- Google連絡先同期（Google People API） ---
// 認証必須: 以前はbody.userIdをクライアントの自己申告のまま信用しており、
// 誰でも任意のuserIdを指定して他人のアカウントへ大量の友達申請を
// 送りつけられる状態だった。JWTから取得した本人のuserIdのみを使う。
router.post('/google-contacts/sync', verifyToken, async (req, res) => {
  const { accessToken } = req.body;
  const userId = req.user.userId;
  if (!accessToken) return res.status(400).json({ error: 'accessToken required' });

  try {
    // Google People API から連絡先取得
    const fetch = require('node-fetch');
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
      'SELECT * FROM friendships WHERE (user_a_id = ? OR user_b_id = ?) AND status IN ("accepted", "pending")',
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
          'INSERT INTO friendships (id, user_a_id, user_b_id, status, requested_by, requested_at) VALUES (?, ?, ?, "pending", ?, ?)',
          [uuidv4(), userId, newFriendId, userId, new Date().toISOString()]
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
    if (newPassword.length < 8) {
      return res.status(400).json({ error: '新しいパスワードは8文字以上にしてください' });
    }
    if (newPassword.length > 128) {
      return res.status(400).json({ error: 'パスワードが長すぎます' });
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
    await db.run('UPDATE users SET password_hash = ?, token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newHash, req.user.userId]);

    // 新しいトークンを発行(変更直後に再ログインさせないため)
    const token = jwt.sign({ userId: req.user.userId, username: req.user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
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
    await db.run('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, req.user.userId]);
    res.json({ secret, uri: otpauthUri(secret, user.username) });
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
    const step = verifyTotp(user.totp_secret, req.body.code);
    if (step === null) return res.status(400).json({ error: 'コードが正しくありません' });
    const { plain, hashes } = generateBackupCodes();
    await db.run('UPDATE users SET totp_enabled = 1, totp_last_step = ?, backup_codes = ? WHERE id = ?',
      [step, JSON.stringify(hashes), user.id]);
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
    await db.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = 0, backup_codes = NULL WHERE id = ?', [user.id]);
    res.json({ ok: true });
  } catch (e) {
    sendServerError(res, e, '2fa-disable');
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
    // ユーザー情報の匿名化(外部キー制約のため行自体は残す)
    await db.run(
      "UPDATE users SET username = ?, password_hash = '', display_name = '退会済みユーザー', profile_pic = '', bio = '', public_key = NULL, token_revoked_at = CURRENT_TIMESTAMP WHERE id = ?",
      [`deleted_${userId}`, userId]
    );

    res.json({ ok: true, message: 'アカウントを削除しました' });
  } catch (e) {
    sendServerError(res, e, 'delete-account');
  }
});

module.exports = { router, verifyToken, verifyTokenRaw, JWT_SECRET };
