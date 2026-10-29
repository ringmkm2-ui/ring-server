// テスト用: Googleドライブにつながずに routes/drive.js を動かすための偽物。
// NODE_OPTIONS="--require tests/stub_gdrive.js" でサーバーより先に読み込ませる(テストの中だけ)。
const path = require('path');
const target = path.join(__dirname, '..', 'utils', 'gdrive.js');
let n = 0;
const fake = {
  isConfigured: () => true,
  isConnected: async () => true,
  authUrl: () => 'https://example.invalid/',
  exchangeCode: async () => ({}),
  newState: () => 'state',
  folderId: async () => 'folder',
  quota: async () => ({ used: 0, limit: 0 }),
  remove: async () => true,
  openDownload: async () => { throw new Error('not in test'); },
  // 本文を最後まで読み捨てて、受け取ったバイト数を返す
  uploadStream: async (webStream, size) => {
    let got = 0;
    const reader = webStream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; }
    return { id: 'stub' + Date.now().toString(36) + (n++), size: got || size };
  },
};
require.cache[target] = { id: target, filename: target, loaded: true, exports: fake };
