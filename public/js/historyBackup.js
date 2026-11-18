// public/js/historyBackup.js
// e5 の本文は端末の中にしか無いので、新しい端末へ移す手段を用意する。
// 書き出すのは本文だけ。パスフレーズ由来の鍵(PBKDF2-SHA256 + AES-256-GCM)で暗号化したファイルにして、端末の外へ渡す。
// サーバーには送らない。鍵やセッションは含めない(同じ鍵を2台で使うと前方秘匿性が壊れる)。
(function () {
  if (window.bcHistoryBackup) return;
  const MAGIC = 'BCHB1', ITER = 600000;
  const te = new TextEncoder(), td = new TextDecoder();
  const b64e = b => nacl.util.encodeBase64(b), b64d = s => nacl.util.decodeBase64(s);

  async function derive(pass, salt, iter) {
    const base = await crypto.subtle.importKey('raw', te.encode(pass.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function pack(items, pass) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await derive(pass, salt, ITER);
    const plain = te.encode(JSON.stringify(items.map(it => [it.k, b64e(it.b), it.at])));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(MAGIC) }, key, plain));
    return JSON.stringify({ magic: MAGIC, iter: ITER, salt: b64e(salt), iv: b64e(iv), data: b64e(ct) });
  }
  async function unpack(text, pass) {
    const o = JSON.parse(text);
    if (!o || o.magic !== MAGIC) throw new Error('format');
    if (!(o.iter >= 100000 && o.iter <= 10000000)) throw new Error('format');
    const key = await derive(pass, b64d(o.salt), o.iter);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(o.iv), additionalData: te.encode(MAGIC) }, key, b64d(o.data));
    return JSON.parse(td.decode(plain)).map(r => ({ k: r[0], b: b64d(r[1]), at: r[2] }));
  }
  async function exportTo(pass) {
    const items = await bcE5.get().exportPlain();
    if (!items.length) return { count: 0 };
    return { count: items.length, text: await pack(items, pass) };
  }
  async function importFrom(text, pass) {
    return bcE5.get().importPlain(await unpack(text, pass));
  }
  function download(text) {
    const d = new Date(), name = 'BroChat-history-' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0') + '.bchb';
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
  window.bcHistoryBackup = { exportTo, importFrom, download, pack, unpack };
})();
