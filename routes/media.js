// routes/media.js
// ChunkFileUploader (サーバー側) + TTLStorageManager
// - 画像/動画をチャンク単位で受け取り、ロスレスで結合保存 (4K/8K動画対応)
// - 保存先は今はローカルディスク (uploads/) だが、本番では S3 / Supabase Storage の
//   putObject に差し替えるだけで良いように storage.js でラップしている
// - 7日で自動削除 (TTLStorageManager が cron で巡回)
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { verifyToken } = require('../utils/authMiddleware');
const storage = require('../storage/storage');
const { asyncHandler } = require('../utils/asyncHandler');

const router = express.Router();
// メモリストレージのため、上限を設けないと1リクエストで巨大なバイト列を送りつけられ
// サーバーメモリを枯渇させられる(DoS)。1チャンクあたり10MBを上限とする
// (admin.html側は50MB制限の画像/動画をBase64インラインで送る設計に切り替わっており、
//  このチャンクアップロードAPIは現在UIから使われていないが、エンドポイント自体は
//  生きているため防御的に制限しておく)。
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const TTL_DAYS = 7;

// --- チャンクアップロード開始 (メタデータ登録) ---
// body: { fileName, mimeType, sizeBytes, chunkTotal }
router.post('/init', verifyToken, asyncHandler(async (req, res) => {
  const { fileName, mimeType, sizeBytes, chunkTotal } = req.body;

  // chunkTotalに上限を設けないと、非常に大きな値を指定されてmergeChunks側で
  // 大量のファイルI/Oを引き起こされる(リソース枯渇)おそれがあるため上限を設ける。
  // 1チャンク10MB上限 x 1000チャンク = 最大10GBのファイルまで許容(通常利用では十分すぎる)。
  const total = parseInt(chunkTotal, 10) || 1;
  if (total < 1 || total > 1000) {
    return res.status(400).json({ error: 'chunkTotalが不正です' });
  }

  const fileId = uuidv4();
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86400 * 1000).toISOString();

  await db.run(
    `INSERT INTO media_files (id, owner_id, storage_key, original_name, mime_type, size_bytes, chunk_total, chunk_received, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'uploading', ?)`,
    [fileId, req.user.userId, `media/${fileId}`, fileName, mimeType, sizeBytes || 0, total, expiresAt]
  );

  storage.ensureUploadDir(fileId);
  res.json({ fileId, expiresAt, ttlDays: TTL_DAYS });
}));

// --- 1チャンク受信 ---
// multipart/form-data: chunk (binary), fileId, chunkIndex
router.post('/chunk', verifyToken, upload.single('chunk'), asyncHandler(async (req, res) => {
  const { fileId, chunkIndex } = req.body;
  if (!req.file) return res.status(400).json({ error: 'chunkファイルがありません（サイズ上限10MBを超えている可能性があります）' });

  const file = await db.get('SELECT * FROM media_files WHERE id = ?', [fileId]);
  if (!file) return res.status(404).json({ error: 'アップロードセッションが見つかりません' });
  if (file.owner_id !== req.user.userId) return res.status(403).json({ error: '権限がありません' });

  storage.writeChunk(fileId, parseInt(chunkIndex, 10), req.file.buffer);

  const received = file.chunk_received + 1;
  await db.run('UPDATE media_files SET chunk_received = ? WHERE id = ?', [received, fileId]);

  res.json({ ok: true, received, total: file.chunk_total });
}));

// --- 全チャンク結合完了 ---
router.post('/complete', verifyToken, asyncHandler(async (req, res) => {
  const { fileId } = req.body;
  const file = await db.get('SELECT * FROM media_files WHERE id = ?', [fileId]);
  if (!file) return res.status(404).json({ error: 'ファイルが見つかりません' });
  // 所有者チェック: 以前はここが欠落しており、fileIdさえ知っていれば
  // (推測・漏洩経路を問わず)他人のアップロードセッションを勝手に完了させられた
  if (file.owner_id !== req.user.userId) return res.status(403).json({ error: '権限がありません' });

  await storage.mergeChunks(fileId, file.chunk_total);
  await db.run('UPDATE media_files SET status = ? WHERE id = ?', ['ready', fileId]);

  res.json({
    ok: true,
    fileId,
    downloadUrl: `/api/media/download/${fileId}`,
    expiresAt: file.expires_at,
  });
}));

// --- ダウンロード (7日以内のみ有効) ---
router.get('/download/:fileId', verifyToken, asyncHandler(async (req, res) => {
  const file = await db.get('SELECT * FROM media_files WHERE id = ?', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'ファイルが見つかりません' });

  // 認可チェック: 以前はここに一切のアクセス制御が無く、有効なJWTさえ持っていれば
  // (=Bro Chatの誰であっても) fileIdを知るだけで他人がアップロードしたファイルを
  // ダウンロードできてしまう重大な機密性の欠陥があった。
  // media_filesテーブルには受信者情報を紐付ける仕組みが無いため、現時点で安全に
  // 判定できるのは「アップロードした本人かどうか」のみ。そのため所有者のみ許可する。
  // 注意: このチャンクアップロードAPI自体は現在フロントエンド(admin.html等)の
  // 画像送信フローからは使われていない(実際の送信はメッセージ本文への
  // インラインBase64方式)。将来この経路を実際の受信者への配送に使う場合は、
  // messages.recipient_id 等とfileIdを紐付けて、送信者・受信者双方に
  // ダウンロードを許可するロジックへ拡張する必要がある。
  if (file.owner_id !== req.user.userId) {
    return res.status(403).json({ error: '権限がありません' });
  }

  if (new Date(file.expires_at) < new Date()) {
    return res.status(410).json({ error: 'このファイルは保存期間 (7日) を過ぎたため削除されました。もう一度送信してください。' });
  }
  if (file.status !== 'ready') {
    return res.status(409).json({ error: 'アップロードがまだ完了していません' });
  }

  const filePath = storage.getFinalPath(req.params.fileId);
  if (!fs.existsSync(filePath)) {
    return res.status(410).json({ error: 'ファイル実体が見つかりません（期限切れの可能性）' });
  }

  res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.original_name || 'file')}"`);
  fs.createReadStream(filePath).pipe(res);
}));

// --- Cloudinary からメディアを削除 ---
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

router.post('/delete', verifyToken, asyncHandler(async (req, res) => {
  const { publicId } = req.body;

  if (!publicId) {
    return res.status(400).json({ error: 'publicId is required' });
  }
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return res.status(500).json({ error: 'Cloudinary設定がサーバーに未設定です' });
  }

  // 認可チェック: 以前はここに一切のアクセス制御が無く、有効なJWTさえ持っていれば
  // (=Bro Chatの誰であっても) publicIdを知るだけで他人がアップロードした画像/動画を
  // 勝手に削除できてしまう重大な脆弱性(IDOR)があった。
  // publicIdは自分が送信者(sender_id)であるメッセージのcontentに含まれている場合のみ
  // 削除を許可する(DM・グループメッセージの両方をチェック)。
  const escapedId = publicId.replace(/[%_]/g, c => '\\' + c); // LIKE用エスケープ
  const ownDm = await db.get(
    "SELECT id FROM messages WHERE sender_id = ? AND content LIKE ? ESCAPE '\\\\'",
    [req.user.userId, `%"mediaPublicId":"${escapedId}"%`]
  );
  const ownGroupMsg = await db.get(
    "SELECT id FROM group_messages WHERE sender_id = ? AND content LIKE ? ESCAPE '\\\\'",
    [req.user.userId, `%"mediaPublicId":"${escapedId}"%`]
  );
  if (!ownDm && !ownGroupMsg) {
    return res.status(403).json({ error: 'このメディアを削除する権限がありません' });
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const params = {
      public_id: publicId,
      api_key: CLOUDINARY_API_KEY,
      timestamp: timestamp
    };
    params.signature = generateCloudinarySig(params);

    const formData = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      formData.append(key, value);
    });

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/resources/image/upload`,
      {
        method: 'DELETE',
        body: formData
      }
    );

    if (!response.ok) {
      console.error('[cloudinary] Delete failed:', response.status);
      return res.status(500).json({ error: 'Delete failed' });
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('[cloudinary] Delete error:', e);
    res.status(500).json({ error: 'Delete failed' });
  }
}));

module.exports = router;
