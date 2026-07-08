// chunkfileuploader.js
// -----------------------------------------------------------------------
// ブラウザ側: 画像・動画をチャンク分割してサーバー(routes/media.js)にロスレスアップロード。
// 4K/8K動画のような巨大ファイルでもメモリを圧迫しないよう、Blob.slice()で
// 少しずつ読み込んで送信する。
// -----------------------------------------------------------------------
(function (root) {
  const CHUNK_SIZE = 1024 * 1024 * 2; // 2MBずつ (ネットワーク環境に応じて調整可)

  class ChunkFileUploader {
    constructor(apiBase, token) {
      this.apiBase = apiBase; // 例: 'http://localhost:3000'
      this.token = token;
    }

    // file: <input type="file"> から取得した File オブジェクト
    // onProgress: (受信済みチャンク数, 総チャンク数) => void
    async upload(file, onProgress) {
      const chunkTotal = Math.ceil(file.size / CHUNK_SIZE);

      // 1. アップロードセッション開始
      const initRes = await fetch(`${this.apiBase}/api/media/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({
          fileName: file.name,
          mimeType: file.type,
          sizeBytes: file.size,
          chunkTotal,
        }),
      });
      const { fileId, expiresAt } = await initRes.json();

      // 2. チャンクを順番に送信 (ロスレス: Blob.sliceでバイト単位そのまま切り出す)
      for (let i = 0; i < chunkTotal; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end); // バイト単位で正確にスライス = 劣化なし

        const form = new FormData();
        form.append('fileId', fileId);
        form.append('chunkIndex', String(i));
        form.append('chunk', chunkBlob);

        const res = await fetch(`${this.apiBase}/api/media/chunk`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${this.token}` },
          body: form,
        });
        if (!res.ok) throw new Error(`チャンク ${i} のアップロードに失敗しました`);

        if (onProgress) onProgress(i + 1, chunkTotal);
      }

      // 3. 結合完了を通知
      const completeRes = await fetch(`${this.apiBase}/api/media/complete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.token}` },
        body: JSON.stringify({ fileId }),
      });
      const result = await completeRes.json();

      return {
        fileId,
        downloadUrl: `${this.apiBase}${result.downloadUrl}`,
        expiresAt,
      };
    }

    // ダウンロード (7日以内のみ有効。期限切れの場合は410エラーが返る)
    async download(fileId) {
      const res = await fetch(`${this.apiBase}/api/media/download/${fileId}`, {
        headers: { 'Authorization': `Bearer ${this.token}` },
      });
      if (res.status === 410) {
        throw new Error('このファイルは保存期間(7日)を過ぎたため削除されました。もう一度送ってもらってください。');
      }
      if (!res.ok) throw new Error('ダウンロードに失敗しました');
      return await res.blob(); // 受け取ったバイト列そのまま = ロスレス
    }
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = ChunkFileUploader;
  } else {
    root.RingChunkFileUploader = ChunkFileUploader;
  }
})(typeof self !== 'undefined' ? self : this);
