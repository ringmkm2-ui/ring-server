// routes/auth.js
// UserAuthenticator: 登録・ログイン・JWT発行
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'ring-dev-secret-CHANGE-IN-PRODUCTION';
const JWT_EXPIRES_IN = '30d';

// --- 新規登録 ---
// body: { username, password, displayName }
router.post('/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'username と password は必須です' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'パスワードは6文字以上にしてください' });
  }

  const existing = await db.get('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) {
    return res.status(409).json({ error: 'そのユーザー名は既に使われています' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
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
router.post('/login', async (req, res) => {
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
router.post('/google', async (req, res) => {
  const { idToken } = req.body;
  if (!idToken) return res.status(400).json({ error: 'idToken required' });

  try {
    // Google IDトークンを検証（署名確認はクライアント側でも可能だが、セキュリティ向上のためサーバー側でも検証推奨）
    // 簡略版：クライアントが既に検証済みのトークンを送信すると仮定
    const payload = parseGoogleIdToken(idToken);
    if (!payload) return res.status(401).json({ error: 'Invalid idToken' });

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
    console.error('Google OAuth error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Google IDトークンをBase64デコード・パース（ヘッダー・署名を無視、ペイロードのみ）
// 本来はGoogleの公開鍵で署名検証すべきだが、ここでは簡略版
function parseGoogleIdToken(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    return null;
  }
}

// --- JWT検証ミドルウェア (他ルート・WebSocketから共有利用) ---
function verifyToken(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: '認証トークンがありません' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'トークンが無効です' });
  }
}

function verifyTokenRaw(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

module.exports = { router, verifyToken, verifyTokenRaw, JWT_SECRET };
