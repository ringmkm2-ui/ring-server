// routes/auth.js
// UserAuthenticator: 登録・ログイン・JWT発行
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db/db');
const { JWT_SECRET } = require('../utils/jwtSecret');
const { loginLimiter, registerLimiter } = require('../utils/rateLimits');
const { sendServerError } = require('../utils/errorResponse');
const { verifyToken, verifyTokenWithRevocation } = require('../utils/authMiddleware');

const router = express.Router();
const JWT_EXPIRES_IN = '30d';

// Google Sign-In (Google Identity Services) のクライアントID。
// public/auth.html に埋め込まれているものと同じ値でなければ検証が常に失敗する。
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '253097251071-qsajqnr9l71vjma3hlg8d91hmh7m6c9l.apps.googleusercontent.com';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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

  const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) {
    return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
  }

  // bcryptのコスト係数: 10→12に引き上げ。総当たり耐性が上がる一方、
  // ハッシュ化にかかる時間は数十ms程度の増加に留まりログイン体感には影響しない。
  const passwordHash = await bcrypt.hash(password, 12);
  const userId = uuidv4();
  const userIdCode = 'U' + Math.random().toString(36).substring(2, 8).toUpperCase(); // User ID like U3K7F9

  await db.run(
    'INSERT INTO users (id, user_id, username, password_hash, display_name) VALUES (?, ?, ?, ?, ?)',
    [userId, userIdCode, username, passwordHash, displayName || username]
  );

  const token = jwt.sign({ userId, username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  res.json({
    userId,
    userIdCode,
    username,
    displayName: displayName || username,
    token,
  });
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

  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  res.json({
    userId: user.id,
    userIdCode: user.user_id,
    username: user.username,
    displayName: user.display_name,
    token,
  });
});

// --- Google OAuth ログイン ---
// POST /api/auth/google
// body: { idToken } (Google Sign-In から取得したIDトークン)
router.post('/google', loginLimiter, async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  try {
    // Google IDトークンの署名・発行者・有効期限・audience(このアプリ向けに
    // 発行されたものか)をすべてGoogleの公開鍵で検証する。
    // 以前はペイロードをBase64デコードするだけで署名を一切確認していなかったため、
    // 誰でも任意のメールアドレスを名乗る偽トークンを作ってなりすませる状態だった。
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(401).json({ error: 'Invalid idToken' });
    }
    // メールアドレスがGoogle側で検証済みであることも確認する
    // (未検証メールアドレスでのなりすまし登録を防ぐ)
    if (payload.email_verified === false) {
      return res.status(401).json({ error: 'メールアドレスが未検証です' });
    }

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
    }

    const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.json({
      userId: user.id,
      userIdCode: user.user_id,
      username: user.username,
      displayName: user.display_name,
      profilePic: user.profile_pic,
      token,
    });
  } catch (e) {
    // verifyIdTokenは署名不正・期限切れ・audience不一致などで例外を投げる。
    // これらは全て「なりすまし試行または壊れたトークン」として一律401にする
    // (詳細なエラー内容を返すと、攻撃者に検証ロジックの手がかりを与えるため)
    console.error('Google OAuth verification failed:', e.message);
    res.status(401).json({ error: 'Google認証に失敗しました' });
  }
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

module.exports = { router, verifyToken, verifyTokenRaw, JWT_SECRET };
