// cloudinaryE2EUpload.js
// ブラウザ → Cloudinary 直接アップロード + E2E暗号化 + チャンク処理

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
const CLOUDINARY_UPLOAD_URL = 'https://api.cloudinary.com/v1_1/a6rxinoz/upload';
const CLOUDINARY_UNSIGNED_PRESET = 'brochat_upload'; // Unsigned Upload Preset (設定必須)

class CloudinaryE2EUploader {
  constructor() {
    this.uploadingFiles = new Map(); // { fileId: { progress, chunks, encrypted } }
  }

  /**
   * ファイルをE2E暗号化してCloudinaryにチャンク送信
   * @param {File} file - アップロードするファイル
   * @param {Uint8Array} sharedKey - E2E暗号化用の共有鍵
   * @param {string} folder - Cloudinaryフォルダ
   * @param {Function} onProgress - 進捗コールバック
   */
  async uploadEncryptedChunked(file, sharedKey, folder = 'brochat', onProgress) {
    const fileId = this.generateFileId();
    const chunks = Math.ceil(file.size / CHUNK_SIZE);

    this.uploadingFiles.set(fileId, {
      progress: 0,
      chunks: chunks,
      encrypted: [],
      metadata: {
        fileName: file.name,
        fileType: file.type,
        fileSize: file.size,
        chunkCount: chunks
      }
    });

    try {
      const encryptedChunks = [];

      // ファイルをチャンク単位で読み込んで暗号化
      for (let i = 0; i < chunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);
        const arrayBuffer = await chunk.arrayBuffer();

        // TweetNaCl で暗号化
        const encrypted = await this.encryptChunk(
          new Uint8Array(arrayBuffer),
          sharedKey,
          fileId,
          i
        );

        encryptedChunks.push(encrypted);

        // 進捗更新
        const progress = Math.round(((i + 1) / chunks) * 50); // 0-50%
        if (onProgress) onProgress(progress);
      }

      // 暗号化チャンクを結合して Blob に
      const encryptedBlob = new Blob(encryptedChunks, { type: 'application/octet-stream' });

      // Cloudinary に直接アップロード
      const cloudinaryUrl = await this.uploadToCloudinary(
        encryptedBlob,
        `${folder}/${fileId}`,
        onProgress
      );

      // メタデータも暗号化して保存
      const metadata = {
        fileId,
        cloudinaryUrl,
        cloudinaryPublicId: this.extractPublicId(cloudinaryUrl),
        encryptedMetadata: await this.encryptMetadata(
          this.uploadingFiles.get(fileId).metadata,
          sharedKey
        ),
        chunkCount: chunks
      };

      this.uploadingFiles.delete(fileId);

      return metadata;
    } catch (e) {
      console.error('[cloudinaryE2E] Upload error:', e);
      this.uploadingFiles.delete(fileId);
      throw e;
    }
  }

  /**
   * チャンクを暗号化
   */
  async encryptChunk(data, key, fileId, chunkIndex) {
    if (!window.nacl) {
      throw new Error('TweetNaCl not loaded');
    }

    // nonce生成（ファイルID + チャンク番号 + ランダム）
    const nonce = new Uint8Array(24);
    const encoder = new TextEncoder();
    const prefix = encoder.encode(fileId + ':' + chunkIndex);
    nonce.set(prefix.slice(0, Math.min(16, prefix.length)));
    window.crypto.getRandomValues(nonce.slice(prefix.length));

    // 秘密鍵から暗号化キー生成
    const encryptKey = window.nacl.box.keyPair.fromSecretKey(key).secretKey;

    // チャンク + メタデータ（nonce）を結合
    const chunkWithMeta = new Uint8Array(data.length + 24);
    chunkWithMeta.set(nonce);
    chunkWithMeta.set(data, 24);

    // 暗号化
    const encrypted = window.nacl.secretbox(chunkWithMeta, nonce, encryptKey);

    return encrypted;
  }

  /**
   * メタデータを暗号化
   */
  async encryptMetadata(metadata, key) {
    const json = JSON.stringify(metadata);
    const data = new TextEncoder().encode(json);
    const nonce = window.nacl.randomBytes(24);

    const encryptKey = window.nacl.box.keyPair.fromSecretKey(key).secretKey;
    const encrypted = window.nacl.secretbox(data, nonce, encryptKey);

    return {
      encrypted: window.nacl.util.encodeBase64(encrypted),
      nonce: window.nacl.util.encodeBase64(nonce)
    };
  }

  /**
   * Cloudinary に直接アップロード
   */
  async uploadToCloudinary(blob, path, onProgress) {
    const formData = new FormData();
    formData.append('file', blob);
    formData.append('upload_preset', CLOUDINARY_UNSIGNED_PRESET);
    formData.append('folder', path);
    formData.append('resource_type', 'auto');

    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const progress = 50 + Math.round((e.loaded / e.total) * 50); // 50-100%
          if (onProgress) onProgress(progress);
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(new Error(`Upload failed: ${xhr.status}`));
          return;
        }

        const response = JSON.parse(xhr.responseText);
        resolve(response.secure_url);
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });

      xhr.open('POST', CLOUDINARY_UPLOAD_URL);
      xhr.send(formData);
    });
  }

  /**
   * Cloudinary URL から Public ID を抽出
   */
  extractPublicId(url) {
    const match = url.match(/\/([^\/]+?)(?:\.[^\.]+)?$/);
    return match ? match[1] : null;
  }

  /**
   * ファイルID生成
   */
  generateFileId() {
    return 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  /**
   * 暗号化されたメディアをダウンロード・復号化
   */
  async downloadAndDecryptMedia(cloudinaryUrl, encryptedMetadata, key) {
    try {
      const response = await fetch(cloudinaryUrl);
      const encryptedData = await response.arrayBuffer();
      const encrypted = new Uint8Array(encryptedData);

      // nonce を最初の24バイトから抽出
      const nonce = encrypted.slice(0, 24);
      const ciphertext = encrypted.slice(24);

      // TweetNaCl で復号化
      const decryptKey = window.nacl.box.keyPair.fromSecretKey(key).secretKey;
      const decrypted = window.nacl.secretbox.open(ciphertext, nonce, decryptKey);

      if (!decrypted) {
        throw new Error('Decryption failed');
      }

      return new Blob([decrypted], { type: 'application/octet-stream' });
    } catch (e) {
      console.error('[cloudinaryE2E] Decrypt error:', e);
      throw e;
    }
  }
}

const cloudinaryE2EUploader = new CloudinaryE2EUploader();
window.cloudinaryE2EUploader = cloudinaryE2EUploader;
