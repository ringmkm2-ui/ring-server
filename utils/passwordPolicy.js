// utils/passwordPolicy.js
// パスワードの強さチェック。エラーメッセージ(日本語)を返す。問題なければ null。
const COMMON = new Set([
  'password', 'password1', 'password123', 'passw0rd', '12345678', '123456789', '1234567890', '11111111',
  '00000000', 'qwertyui', 'qwerty123', 'qwertyuiop', 'abc12345', 'abcd1234', 'iloveyou', 'admin123',
  'letmein1', 'welcome1', 'monkey123', 'dragon123', 'football', 'baseball', 'sunshine', 'princess',
  'asdfghjk', 'zxcvbnm1', '1q2w3e4r', '1qaz2wsx', 'aaaaaaaa', 'bro12345', 'brochat1', 'brochat123',
  'sakura123', 'tanaka123', 'yamada123', 'minecraft', 'minecraft1', 'minecraft123',
]);

function validatePassword(password, username) {
  if (typeof password !== 'string') return 'パスワードが正しくありません';
  if (password.length < 8) return 'パスワードは8文字以上にしてください';
  if (password.length > 128) return 'パスワードが長すぎます';
  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'よくあるパスワードは使えません。別のものにしてください';
  if (/^(.)\1+$/.test(password)) return '同じ文字だけのパスワードは使えません';
  if (username) {
    const u = String(username).toLowerCase();
    const local = u.split('@')[0];
    if (lower === u || (local.length >= 3 && lower === local)) return 'ユーザー名と同じパスワードは使えません';
  }
  return null;
}

module.exports = { validatePassword };
