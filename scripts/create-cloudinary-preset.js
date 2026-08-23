#!/usr/bin/env node
// scripts/create-cloudinary-preset.js
// -----------------------------------------------------------------------
// Bro Chatが動画・画像アップロードに使う Unsigned Upload Preset
// ("brochat_upload") をCloudinary Admin API経由で作成するワンタイムスクリプト。
//
// 【重要】このスクリプトはRingの手元のPC等、ネットワーク制限のない環境で
// 1回だけ実行してください。Renderのコンテナ内や、ネットワークが制限された
// 環境からは api.cloudinary.com への接続がブロックされるため実行できません。
//
// 使い方:
//   1. Node.jsがインストールされたPCにこのファイルをコピー
//   2. 環境変数 CLOUDINARY_URL をセットして実行:
//
//      # Mac/Linux:
//      CLOUDINARY_URL="cloudinary://<API_KEY>:<API_SECRET>@a6rxinoz" node create-cloudinary-preset.js
//
//      # Windows (PowerShell):
//      $env:CLOUDINARY_URL="cloudinary://<API_KEY>:<API_SECRET>@a6rxinoz"; node create-cloudinary-preset.js
//
//   3. "✅ Preset created" と表示されれば成功。既に存在する場合は
//      "already exists" と表示され、正常終了する(エラーにはしない)。
//
// 【セキュリティ注意】
// - CLOUDINARY_URL にはAPI Secretが含まれる。このファイルやコマンド履歴を
//   絶対にGitやSlack等の共有先にコミット・貼り付けしないこと。
// - 実行後、ターミナルの履歴をクリアすることを推奨 (history -c など)。
// -----------------------------------------------------------------------

const https = require('https');

const CLOUDINARY_URL = process.env.CLOUDINARY_URL;
if (!CLOUDINARY_URL) {
  console.error('❌ 環境変数 CLOUDINARY_URL が設定されていません。');
  console.error('   例: CLOUDINARY_URL="cloudinary://KEY:SECRET@a6rxinoz" node create-cloudinary-preset.js');
  process.exit(1);
}

// cloudinary://<api_key>:<api_secret>@<cloud_name> をパースする
const match = CLOUDINARY_URL.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
if (!match) {
  console.error('❌ CLOUDINARY_URL の形式が正しくありません。');
  process.exit(1);
}
const [, apiKey, apiSecret, cloudName] = match;

const PRESET_NAME = 'brochat_upload';

const postData = new URLSearchParams({
  name: PRESET_NAME,
  unsigned: 'true',
  // resource_type は 'auto' のままにして image/video/raw いずれのアップロードでも
  // このpresetが使えるようにする(cloudinaryE2EUpload.jsはresource_type:rawを
  // アップロード時に明示的に指定するため、preset側では固定しない)
}).toString();

const options = {
  hostname: 'api.cloudinary.com',
  path: `/v1_1/${cloudName}/upload_presets`,
  method: 'POST',
  auth: `${apiKey}:${apiSecret}`,
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postData),
  },
};

const req = https.request(options, (res) => {
  let body = '';
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch (e) { parsed = { raw: body }; }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log('✅ Preset created:', PRESET_NAME);
      console.log(parsed);
    } else if (
      parsed.error &&
      typeof parsed.error.message === 'string' &&
      parsed.error.message.toLowerCase().includes('already exists')
    ) {
      console.log('ℹ️  Preset already exists (this is fine):', PRESET_NAME);
    } else {
      console.error('❌ Failed to create preset. Status:', res.statusCode);
      console.error(parsed);
      process.exit(1);
    }
  });
});

req.on('error', (e) => {
  console.error('❌ Request error:', e.message);
  process.exit(1);
});

req.write(postData);
req.end();
