// storage/storage.js
// -----------------------------------------------------------------------
// ローカルディスク実装。本番では同じ関数シグネチャのまま
// AWS S3 (@aws-sdk/client-s3) や Supabase Storage の呼び出しに差し替える。
// これにより routes/media.js 側のコードは一切変更不要。
// -----------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const UPLOAD_ROOT = path.join(__dirname, '..', 'uploads');
const CHUNK_ROOT = path.join(UPLOAD_ROOT, '_chunks');
const FINAL_ROOT = path.join(UPLOAD_ROOT, 'media');

[UPLOAD_ROOT, CHUNK_ROOT, FINAL_ROOT].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function ensureUploadDir(fileId) {
  const dir = path.join(CHUNK_ROOT, fileId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function writeChunk(fileId, chunkIndex, buffer) {
  const dir = path.join(CHUNK_ROOT, fileId);
  const chunkPath = path.join(dir, String(chunkIndex).padStart(6, '0'));
  fs.writeFileSync(chunkPath, buffer); // ロスレス: バイト列そのまま保存
}

async function mergeChunks(fileId, totalChunks) {
  const dir = path.join(CHUNK_ROOT, fileId);
  const finalPath = path.join(FINAL_ROOT, fileId);
  const writeStream = fs.createWriteStream(finalPath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(dir, String(i).padStart(6, '0'));
    const data = fs.readFileSync(chunkPath); // 順番通りに結合 = ロスレス
    writeStream.write(data);
  }
  await new Promise((resolve, reject) => {
    writeStream.end(err => (err ? reject(err) : resolve()));
  });

  // チャンク断片は結合後に削除
  fs.rmSync(dir, { recursive: true, force: true });
  return finalPath;
}

function getFinalPath(fileId) {
  return path.join(FINAL_ROOT, fileId);
}

function deleteFinal(fileId) {
  const p = getFinalPath(fileId);
  if (fs.existsSync(p)) fs.rmSync(p, { force: true });
}

module.exports = { ensureUploadDir, writeChunk, mergeChunks, getFinalPath, deleteFinal };
