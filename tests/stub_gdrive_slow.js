// テスト用: stub_gdrive.js に「保存に時間がかかる」「保存に失敗する」を足したもの。
// アップロードが同時に走っている間の上限と、失敗した時に枠が戻ることを確かめるために使う。
const path = require('path');
const { isMainThread } = require('worker_threads');
if (isMainThread) {
  require('./stub_gdrive.js');
  const target = path.join(__dirname, '..', 'utils', 'gdrive.js');
  const fake = require.cache[target].exports;
  const orig = fake.uploadStream;
  fake.uploadStream = async (stream, size, name, mime) => {
    const out = await orig(stream, size, name, mime);
    await new Promise(r => setTimeout(r, 400));
    if (size === 777) throw new Error('stub: upload failed'); // 777バイトは必ず失敗させる目印
    return out;
  };
}
