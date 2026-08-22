// utils/cloudinaryUpload.js
// Cloudinary へのメディアアップロード処理

const CLOUDINARY_CLOUD_NAME = 'a6rxinoz';
const CLOUDINARY_API_KEY = '312198856948918';
const CLOUDINARY_API_SECRET = '1ZwGejRa5kqG4AfEbEancn1N7Ag';
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/upload`;

/**
 * メディア（画像・動画）をCloudinaryにアップロード
 * @param {File|Blob} file - アップロードするファイル
 * @param {string} folder - Cloudinary内のフォルダ（'brochat/messages', 'brochat/posts'等）
 * @returns {Promise<{url, publicId, format}>}
 */
async function uploadToCloudinary(file, folder = 'brochat') {
  try {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', 'brochat_upload'); // Unsigned upload preset
    formData.append('folder', folder);
    formData.append('resource_type', 'auto'); // 自動判定: image/video/raw

    const response = await fetch(CLOUDINARY_UPLOAD_URL, {
      method: 'POST',
      body: formData
    });

    if (!response.ok) {
      throw new Error(`Upload failed: ${response.status}`);
    }

    const data = await response.json();
    
    return {
      url: data.secure_url,
      publicId: data.public_id,
      format: data.format,
      resourceType: data.resource_type,
      width: data.width,
      height: data.height,
      duration: data.duration, // 動画の場合
      bytes: data.bytes
    };
  } catch (error) {
    console.error('[cloudinary] Upload error:', error);
    throw error;
  }
}

/**
 * Cloudinary URL から最適化された画像/動画 URL を生成
 * @param {string} publicId - Cloudinary public ID
 * @param {Object} options - オプション
 */
function getOptimizedUrl(publicId, options = {}) {
  const {
    width = 800,
    height = 600,
    crop = 'limit',
    quality = 'auto',
    format = 'auto',
    resourceType = 'image'
  } = options;

  // 動画の場合は width/height は無視
  if (resourceType === 'video') {
    return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/video/upload/q_${quality}/v1/${publicId}`;
  }

  // 画像の場合は最適化
  return `https://res.cloudinary.com/${CLOUDINARY_CLOUD_NAME}/image/upload/w_${width},h_${height},c_${crop},q_${quality},f_${format}/v1/${publicId}`;
}

/**
 * Cloudinary から削除
 * @param {string} publicId - Cloudinary public ID
 */
async function deleteFromCloudinary(publicId) {
  try {
    // Unsigned delete は非対応のため、バックエンド経由で削除
    // サーバー側の /api/media/delete エンドポイントを使用
    const response = await fetch('/api/media/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicId })
    });

    return response.ok;
  } catch (error) {
    console.error('[cloudinary] Delete error:', error);
    return false;
  }
}

// グローバル export
window.cloudinaryUpload = {
  upload: uploadToCloudinary,
  getOptimizedUrl,
  delete: deleteFromCloudinary
};
