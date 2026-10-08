// routes/media.js
// 送信済みメディア(Cloudinary)の削除だけを担当する。
//
// 以前あった分割アップロード(init/chunk/complete/download)とサーバーディスクへの
// 保存(storage/)は、画面がBase64インライン方式に移行した時点で誰からも呼ばれなく
// なっていた。生かしておくと「ログインした誰でもサーバーのディスクを埋められる」
// 入口が残るだけなので、コードごと削除した。
// 将来また分割アップロードを使うなら、1ユーザーあたりの容量上限とチャンク番号の
// 範囲チェックを入れたうえで作り直すこと。
const express = require('express');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const { asyncHandler } = require('../utils/asyncHandler');
const { mediaUploadLimiter } = require('../utils/rateLimits');

const router = express.Router();

// 鍵はRenderの環境変数から読む(以前はソースコードにハードコードされており、
// GitHubリポジトリを閲覧できる人間には全て筒抜けだった重大な機密情報漏洩だった)。
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

function generateCloudinarySig(params) {
  const crypto = require('crypto');
  const sorted = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  return crypto.createHash('sha256').update(sorted + CLOUDINARY_API_SECRET).digest('hex');
}

// --- Cloudinary からメディアを削除 ---
router.post('/delete', verifyToken, mediaUploadLimiter, asyncHandler(async (req, res) => {
  const { publicId } = req.body || {};

  if (!publicId || typeof publicId !== 'string' || publicId.length > 300) {
    return res.status(400).json({ error: 'publicId is required' });
  }
  // Googleドライブに置いたもの(gd_<id>)は、置いた本人だけが消せる
  if (publicId.startsWith('gd_')) {
    try {
      const ok = await require('./drive').removeOwned(req.user.userId, publicId);
      return ok ? res.json({ ok: true }) : res.status(403).json({ error: 'このメディアを削除する権限がありません' });
    } catch (e) {
      return res.status(502).json({ error: '削除に失敗しました' });
    }
  }
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(500).json({ error: 'Cloudinary設定がサーバーに未設定です' });
  }

  // 置き場所でも確かめる: 自分が当事者のDM(brochat/dm/<自分>_<相手>/...)か、
  // 自分がメンバーのグループ(brochat/groups/<グループ>/...)のファイルだけ。
  // mediaPublicId は送る側が自由に書けるので、下のメッセージ照合だけでは他人のファイルを指定できた
  {
    const dm = /^brochat\/dm\/([^/]+)\//.exec(publicId);
    const gr = /^brochat\/groups\/([^/]+)\//.exec(publicId);
    let okScope = false;
    if (dm) okScope = dm[1].split('_').includes(req.user.userId);
    else if (gr) okScope = !!(await db.get('SELECT 1 AS ok FROM group_members WHERE group_id = ? AND user_id = ?', [gr[1], req.user.userId]));
    if (!okScope) return res.status(403).json({ error: 'このメディアを削除する権限がありません' });
  }

  // 認可チェック: publicIdは自分が送信者(sender_id)であるメッセージのcontentに
  // 含まれている場合のみ削除を許可する(DM・グループメッセージの両方をチェック)。
  // これが無いと、publicIdを知るだけで他人の画像/動画を消せてしまう(IDOR)。
  // LIKEのエスケープ文字は '!' にする。バックスラッシュだと、SQLiteとPostgreSQLで
  // 文字列リテラルの扱いが違い、どちらかで「ESCAPEは1文字」エラーになる。
  const escapedId = publicId.replace(/[!%_]/g, c => '!' + c);
  const likePattern = `%"mediaPublicId":"${escapedId}"%`;
  const ownDm = await db.get(
    "SELECT id FROM messages WHERE sender_id = ? AND content LIKE ? ESCAPE '!'",
    [req.user.userId, likePattern]
  );
  const ownGroupMsg = ownDm ? null : await db.get(
    "SELECT id FROM group_messages WHERE sender_id = ? AND content LIKE ? ESCAPE '!'",
    [req.user.userId, likePattern]
  );
  if (!ownDm && !ownGroupMsg) {
    return res.status(403).json({ error: 'このメディアを削除する権限がありません' });
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = { public_id: publicId, api_key: CLOUDINARY_API_KEY, timestamp };
    params.signature = generateCloudinarySig(params);

    const formData = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => formData.append(key, value));

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/image/upload`,
      { method: 'DELETE', body: formData, signal: AbortSignal.timeout(12000) }
    );

    if (!response.ok) {
      console.error('[cloudinary] Delete failed:', response.status);
      return res.status(502).json({ error: 'Delete failed' });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('[cloudinary] Delete error:', e.message);
    res.status(502).json({ error: 'Delete failed' });
  }
}));

module.exports = router;
