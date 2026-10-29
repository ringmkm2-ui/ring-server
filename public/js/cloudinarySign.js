// js/cloudinarySign.js
// Cloudinaryへ置く前に、サーバーから「この場所に置いてよい」署名をもらう(routes/media.js の /api/media/sign)。
// 以前は署名なしプリセット(brochat_upload)だけで送っていて、公開ソースを見た誰でも勝手にファイルを置けた。
// サーバーが署名を出せない時(未設定・通信失敗)だけ、今まで通り署名なしで送る(プリセットを止めるまでの移行用)。
(function () {
  const cache = new Map(); // folder -> { data, at }
  const TTL = 40 * 60 * 1000; // Cloudinaryの署名は1時間有効。余裕を見て40分で取り直す

  async function get(folder) {
    const c = cache.get(folder);
    if (c && Date.now() - c.at < TTL) return c.data;
    let r;
    try {
      r = await fetch('/api/media/sign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (localStorage.getItem('ring_token') || '') },
        body: JSON.stringify({ folder }),
      });
    } catch (e) { return null; }
    if (r.status === 403) { const e = new Error('この場所にはアップロードできません'); e.code = 'FORBIDDEN'; throw e; }
    if (!r.ok) return null;
    const d = await r.json().catch(() => null);
    if (!d || !d.signature) return null;
    cache.set(folder, { data: d, at: Date.now() });
    return d;
  }

  // FormData に署名(または移行用の署名なしプリセット)を入れる。folder は呼び出し側で fd に入れる値と同じにする
  async function apply(fd, folder, opts) {
    const d = (opts && opts.unsigned) ? null : await get(folder);
    if (d) {
      fd.append('api_key', d.apiKey);
      fd.append('timestamp', String(d.timestamp));
      fd.append('signature', d.signature);
      return true;
    }
    fd.append('upload_preset', 'brochat_upload');
    return false;
  }

  window.bcCloudinarySign = { get, apply, forget: f => cache.delete(f) };
})();
