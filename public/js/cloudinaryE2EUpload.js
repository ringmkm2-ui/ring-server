// cloudinaryE2EUpload.js
// ブラウザ → Cloudinary 直接アップロード + E2E暗号化 + チャンク処理

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks
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
        chunkCount: chunks,
        chunkLengths: [], // 各暗号化チャンクの正確なバイト長(復号時の分割に必要)
      }
    });

    try {
      const encryptedChunks = [];
      const chunkLengths = [];

      // ファイルをチャンク単位で読み込んで暗号化
      for (let i = 0; i < chunks; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunk = file.slice(start, end);
        const arrayBuffer = await chunk.arrayBuffer();

        // TweetNaCl で暗号化（戻り値は nonce(24B) + 暗号文 の結合済みバイト列）
        const encrypted = await this.encryptChunk(
          new Uint8Array(arrayBuffer),
          sharedKey,
          fileId,
          i
        );

        encryptedChunks.push(encrypted);
        chunkLengths.push(encrypted.length);

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

      // メタデータも暗号化して保存（chunkLengthsを必ず含める）
      const fullMetadata = { ...this.uploadingFiles.get(fileId).metadata, chunkLengths };
      const metadata = {
        fileId,
        cloudinaryUrl,
        cloudinaryPublicId: this.extractPublicId(cloudinaryUrl),
        encryptedMetadata: await this.encryptMetadata(fullMetadata, sharedKey),
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
   * NOTE: 過去の実装はnonceが実質固定値になっており(Uint8Array.slice()は
   * コピーを返すため元配列への乱数書き込みが反映されていなかった)、かつ
   * box.keyPair.fromSecretKey()をsecretbox用の鍵導出に誤用していた。
   * secretbox は「32バイトの共通鍵 + 毎回ユニークな24バイトnonce」が前提の
   * ため、鍵はハッシュで導出し、nonceは呼び出しごとに真の乱数で生成する。
   */
  async encryptChunk(data, key, fileId, chunkIndex) {
    if (!window.nacl) {
      throw new Error('TweetNaCl not loaded');
    }

    const encryptKey = this.deriveSecretboxKey(key);
    const nonce = window.nacl.randomBytes(24); // 呼び出しごとに真の乱数

    const encrypted = window.nacl.secretbox(data, nonce, encryptKey);

    // nonceを先頭に付けて保存し、復号時に取り出せるようにする
    const combined = new Uint8Array(24 + encrypted.length);
    combined.set(nonce);
    combined.set(encrypted, 24);
    return combined;
  }

  /**
   * E2E鍵ペアの秘密鍵(32バイト)から、secretbox用の対称鍵を導出する。
   * nacl.hashはSHA-512(64バイト)を返すため、先頭32バイトを鍵として使う。
   */
  deriveSecretboxKey(secretKey) {
    const hashed = window.nacl.hash(secretKey);
    return hashed.slice(0, 32);
  }

  /**
   * 暗号化済みチャンク(nonce+暗号文)を復号する
   */
  decryptChunk(combined, key) {
    if (!window.nacl) {
      throw new Error('TweetNaCl not loaded');
    }
    const nonce = combined.slice(0, 24);
    const box = combined.slice(24);
    const decryptKey = this.deriveSecretboxKey(key);
    const decrypted = window.nacl.secretbox.open(box, nonce, decryptKey);
    if (!decrypted) {
      throw new Error('Decryption failed (wrong key or corrupted data)');
    }
    return decrypted;
  }

  /**
   * メタデータを暗号化
   */
  async encryptMetadata(metadata, key) {
    const json = JSON.stringify(metadata);
    const data = new TextEncoder().encode(json);
    const nonce = window.nacl.randomBytes(24);

    const encryptKey = this.deriveSecretboxKey(key);
    const encrypted = window.nacl.secretbox(data, nonce, encryptKey);

    return {
      encrypted: window.nacl.util.encodeBase64(encrypted),
      nonce: window.nacl.util.encodeBase64(nonce)
    };
  }

  /**
   * 暗号化されたメタデータを復号
   */
  decryptMetadata(encryptedMetadata, key) {
    const encrypted = window.nacl.util.decodeBase64(encryptedMetadata.encrypted);
    const nonce = window.nacl.util.decodeBase64(encryptedMetadata.nonce);
    const decryptKey = this.deriveSecretboxKey(key);
    const decrypted = window.nacl.secretbox.open(encrypted, nonce, decryptKey);
    if (!decrypted) {
      throw new Error('Metadata decryption failed');
    }
    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  /**
   * Cloudinary に直接アップロード
   */
  async uploadToCloudinary(blob, path, onProgress) {
    const formData = new FormData();
    formData.append('file', blob);
    formData.append('upload_preset', CLOUDINARY_UNSIGNED_PRESET);
    formData.append('folder', path);
    // NOTE: 暗号化済みバイナリ(application/octet-stream)はCloudinary側で
    // 画像/動画として中身を解析できないため、resource_type:'auto'だと
    // 「認識できないファイル」として400 Bad Requestになる。
    // 中身を検査せずそのまま保存する 'raw' を明示的に指定する。
    formData.append('resource_type', 'raw');

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
          let detail = '';
          try { detail = JSON.parse(xhr.responseText)?.error?.message || ''; } catch {}
          console.error('[cloudinaryUpload] status', xhr.status, 'response:', xhr.responseText);
          reject(new Error(`Upload failed: ${xhr.status}${detail ? ' - ' + detail : ''}`));
          return;
        }

        const response = JSON.parse(xhr.responseText);
        resolve(response.secure_url);
      });

      xhr.addEventListener('error', () => {
        reject(new Error('Upload failed'));
      });

      xhr.open('POST', `https://api.cloudinary.com/v1_1/a6rxinoz/raw/upload`);
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
   * アップロード時、ファイルは複数チャンクに分割され各チャンクが個別に
   * (nonce 24B + 暗号文) の形で暗号化された後、単純に連結されてCloudinaryに
   * 保存されている。そのため復号時は、まずencryptedMetadataからchunkLengths
   * (各暗号化チャンクの正確なバイト長)を取り出し、それに従って正しい境界で
   * 分割してから1チャンクずつ復号し、最後に平文を結合する必要がある。
   */
  async downloadAndDecryptMedia(cloudinaryUrl, encryptedMetadata, key) {
    try {
      const metadata = this.decryptMetadata(encryptedMetadata, key);
      const chunkLengths = metadata.chunkLengths;
      if (!Array.isArray(chunkLengths) || chunkLengths.length === 0) {
        throw new Error('chunkLengths missing from metadata (old/incompatible upload format)');
      }

      const response = await fetch(cloudinaryUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch media: ${response.status}`);
      }
      const buffer = new Uint8Array(await response.arrayBuffer());

      const decryptedParts = [];
      let offset = 0;
      for (const len of chunkLengths) {
        const chunk = buffer.slice(offset, offset + len);
        offset += len;
        decryptedParts.push(this.decryptChunk(chunk, key));
      }

      const totalLength = decryptedParts.reduce((sum, p) => sum + p.length, 0);
      const combined = new Uint8Array(totalLength);
      let pos = 0;
      for (const part of decryptedParts) {
        combined.set(part, pos);
        pos += part.length;
      }

      return new Blob([combined], { type: metadata.fileType || 'application/octet-stream' });
    } catch (e) {
      console.error('[cloudinaryE2E] Decrypt error:', e);
      throw e;
    }
  }
}

const cloudinaryE2EUploader = new CloudinaryE2EUploader();
window.cloudinaryE2EUploader = cloudinaryE2EUploader;
