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
const { verifyToken } = require('./auth');
const storage = require('../storage/storage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const TTL_DAYS = 7;

// --- チャンクアップロード開始 (メタデータ登録) ---
// body: { fileName, mimeType, sizeBytes, chunkTotal }
router.post('/init', verifyToken, async (req, res) => {
  const { fileName, mimeType, sizeBytes, chunkTotal } = req.body;
  const fileId = uuidv4();
  const expiresAt = new Date(Date.now() + TTL_DAYS * 86400 * 1000).toISOString();

  await db.run(
    `INSERT INTO media_files (id, owner_id, storage_key, original_name, mime_type, size_bytes, chunk_total, chunk_received, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'uploading', ?)`,
    [fileId, req.user.userId, `media/${fileId}`, fileName, mimeType, sizeBytes || 0, chunkTotal || 1, expiresAt]
  );

  storage.ensureUploadDir(fileId);
  res.json({ fileId, expiresAt, ttlDays: TTL_DAYS });
});

// --- 1チャンク受信 ---
// multipart/form-data: chunk (binary), fileId, chunkIndex
router.post('/chunk', verifyToken, upload.single('chunk'), async (req, res) => {
  const { fileId, chunkIndex } = req.body;
  const file = await db.get('SELECT * FROM media_files WHERE id = ?', [fileId]);
  if (!file) return res.status(404).json({ error: 'アップロードセッションが見つかりません' });
  if (file.owner_id !== req.user.userId) return res.status(403).json({ error: '権限がありません' });

  storage.writeChunk(fileId, parseInt(chunkIndex, 10), req.file.buffer);

  const received = file.chunk_received + 1;
  await db.run('UPDATE media_files SET chunk_received = ? WHERE id = ?', [received, fileId]);

  res.json({ ok: true, received, total: file.chunk_total });
});

// --- 全チャンク結合完了 ---
router.post('/complete', verifyToken, async (req, res) => {
  const { fileId } = req.body;
  const file = await db.get('SELECT * FROM media_files WHERE id = ?', [fileId]);
  if (!file) return res.status(404).json({ error: 'ファイルが見つかりません' });

  await storage.mergeChunks(fileId, file.chunk_total);
  await db.run('UPDATE media_files SET status = ? WHERE id = ?', ['ready', fileId]);

  res.json({
    ok: true,
    fileId,
    downloadUrl: `/api/media/download/${fileId}`,
    expiresAt: file.expires_at,
  });
});

// --- ダウンロード (7日以内のみ有効) ---
router.get('/download/:fileId', verifyToken, async (req, res) => {
  const file = await db.get('SELECT * FROM media_files WHERE id = ?', [req.params.fileId]);
  if (!file) return res.status(404).json({ error: 'ファイルが見つかりません' });

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
});

module.exports = router;
