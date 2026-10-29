// blurhash.js
// 画像/動画の「ぼかしプレビュー」(BlurHash)を作る・描く。標準のBlurHashアルゴリズムの自前実装(外部ライブラリなし)。
// 目的: メディアの復号が終わるまで、灰色の箱ではなく画像の色合いと正しい縦横比を先に見せて、レイアウトが跳ねないようにする。
//
// PRIVACY(重要): blurhash と幅/高さは「暗号化メタデータの中」にだけ入れる(cloudinaryE2EUpload.js が暗号化前の
//   metadata に足す)。メッセージJSONの平文フィールドやサーバーに送るリクエストには絶対に出さない。
//   ぼかしは元画像の粗い写しなので、平文で置くとサーバーに内容が漏れる。
//
// 使い方:
//   BroBlurhash.encode(canvasかImageData, 4, 3)            -> 'LEHV6nWB2yk8...'
//   BroBlurhash.decode(hash, w, h)                          -> <canvas>(w×h)。{url:true} なら dataURL
//   BroBlurhash.describe(File|Blob|<img>|<canvas>)          -> Promise<{blurhash,w,h}|null>  (<=32px に縮小してから計算)
//   BroBlurhash.fromEncryptedMetadata(encMeta, keyOrKeys)   -> {blurhash,w,h}|null  (メタデータだけ復号。本体のダウンロード不要。
//                                                              古いメッセージで blurhash が無ければ null)
//   BroBlurhash.paint(el, {blurhash,w,h}, {maxH})           -> boolean  プレースホルダーにぼかし背景+aspect-ratioを付ける
//   BroBlurhash.clear(el)                                    -> 本物が出たらぼかしを外す
//
// ページ側の組み込み例(admin.html の lazyメディア):
//   const info = BroBlurhash.fromEncryptedMetadata(parsed.encryptedMetadata, keys);  // keys: 共有鍵(Uint8Array) か その配列
//   if (info) BroBlurhash.paint(placeholder, info);
//   ...復号後に画像を差し替える時: BroBlurhash.clear(placeholder)
(function () {
  if (window.BroBlurhash) return;

  const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
  const B83IDX = {};
  for (let i = 0; i < B83.length; i++) B83IDX[B83[i]] = i;

  function enc83(n, len) {
    let s = '';
    for (let i = 1; i <= len; i++) s += B83[Math.floor(n / Math.pow(83, len - i)) % 83];
    return s;
  }
  function dec83(str) {
    let v = 0;
    for (let i = 0; i < str.length; i++) {
      const d = B83IDX[str[i]];
      if (d === undefined) return NaN;
      v = v * 83 + d;
    }
    return v;
  }

  // sRGB <-> 線形。256段階しかないので表にしておく(毎ピクセルpowを呼ばない = 低スペック端末でも軽い)
  const S2L = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    S2L[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }
  function l2s(v) {
    v = Math.max(0, Math.min(1, v));
    return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255);
  }
  const signPow = (v, e) => (v < 0 ? -1 : 1) * Math.pow(Math.abs(v), e);

  // ---- encode ----
  function encodePixels(px, w, h, cx, cy) {
    if (cx < 1 || cx > 9 || cy < 1 || cy > 9) throw new Error('blurhash: components must be 1..9');
    if (px.length !== w * h * 4) throw new Error('blurhash: pixel size mismatch');
    const factors = [];
    // cos表を先に作ってピクセルごとの三角関数計算をなくす
    const cosX = [], cosY = [];
    for (let i = 0; i < cx; i++) { const a = new Float32Array(w); for (let x = 0; x < w; x++) a[x] = Math.cos(Math.PI * i * x / w); cosX.push(a); }
    for (let j = 0; j < cy; j++) { const a = new Float32Array(h); for (let y = 0; y < h; y++) a[y] = Math.cos(Math.PI * j * y / h); cosY.push(a); }
    for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
      let r = 0, g = 0, b = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const bs = cosX[i][x] * cosY[j][y], o = 4 * (y * w + x);
        r += bs * S2L[px[o]]; g += bs * S2L[px[o + 1]]; b += bs * S2L[px[o + 2]];
      }
      const sc = (i === 0 && j === 0 ? 1 : 2) / (w * h);
      factors.push([r * sc, g * sc, b * sc]);
    }
    const dc = factors[0], ac = factors.slice(1);
    let out = enc83((cx - 1) + (cy - 1) * 9, 1);
    let maxV;
    if (ac.length) {
      let actual = 0;
      for (const f of ac) actual = Math.max(actual, Math.abs(f[0]), Math.abs(f[1]), Math.abs(f[2]));
      const q = Math.max(0, Math.min(82, Math.floor(actual * 166 - 0.5)));
      maxV = (q + 1) / 166;
      out += enc83(q, 1);
    } else { maxV = 1; out += enc83(0, 1); }
    out += enc83((l2s(dc[0]) << 16) + (l2s(dc[1]) << 8) + l2s(dc[2]), 4);
    const q18 = v => Math.max(0, Math.min(18, Math.floor(signPow(v / maxV, 0.5) * 9 + 9.5)));
    for (const f of ac) out += enc83(q18(f[0]) * 361 + q18(f[1]) * 19 + q18(f[2]), 2);
    return out;
  }

  function encode(src, cx, cy) {
    cx = cx || 4; cy = cy || 3;
    let id = src;
    if (src && src.getContext) {            // canvas: 大きければ32px以下に縮めて読む(全画素を舐めない)
      const sw = src.width, sh = src.height;
      const k = Math.min(1, 32 / Math.max(sw, sh));
      const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(src, 0, 0, w, h);
      id = x.getImageData(0, 0, w, h);
    }
    if (!id || !id.data) throw new Error('blurhash: need canvas or ImageData');
    return encodePixels(id.data, id.width, id.height, cx, cy);
  }

  // ---- decode ----
  function valid(hash) {
    if (typeof hash !== 'string' || hash.length < 6) return false;
    const sf = dec83(hash[0]);
    if (isNaN(sf)) return false;
    const cx = (sf % 9) + 1, cy = Math.floor(sf / 9) + 1;
    return hash.length === 4 + 2 * cx * cy && !isNaN(dec83(hash));
  }

  function decodePixels(hash, w, h, punch) {
    if (!valid(hash)) throw new Error('blurhash: invalid hash');
    punch = punch || 1;
    const sf = dec83(hash[0]), cx = (sf % 9) + 1, cy = Math.floor(sf / 9) + 1;
    const maxV = ((dec83(hash[1]) + 1) / 166) * punch;
    const cols = [];
    for (let i = 0; i < cx * cy; i++) {
      if (i === 0) {
        const v = dec83(hash.substring(2, 6));
        cols.push([S2L[v >> 16], S2L[(v >> 8) & 255], S2L[v & 255]]);
      } else {
        const v = dec83(hash.substring(4 + i * 2, 6 + i * 2));
        cols.push([signPow(((Math.floor(v / 361)) - 9) / 9, 2) * maxV, signPow(((Math.floor(v / 19) % 19) - 9) / 9, 2) * maxV, signPow(((v % 19) - 9) / 9, 2) * maxV]);
      }
    }
    const px = new Uint8ClampedArray(w * h * 4);
    const cosX = [], cosY = [];
    for (let i = 0; i < cx; i++) { const a = new Float32Array(w); for (let x = 0; x < w; x++) a[x] = Math.cos(Math.PI * x * i / w); cosX.push(a); }
    for (let j = 0; j < cy; j++) { const a = new Float32Array(h); for (let y = 0; y < h; y++) a[y] = Math.cos(Math.PI * y * j / h); cosY.push(a); }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
        const bs = cosX[i][x] * cosY[j][y], c = cols[j * cx + i];
        r += c[0] * bs; g += c[1] * bs; b += c[2] * bs;
      }
      const o = 4 * (y * w + x);
      px[o] = l2s(r); px[o + 1] = l2s(g); px[o + 2] = l2s(b); px[o + 3] = 255;
    }
    return px;
  }

  function decode(hash, w, h, opts) {
    w = Math.max(1, Math.min(128, w | 0 || 32)); h = Math.max(1, Math.min(128, h | 0 || 32));
    const px = decodePixels(hash, w, h, opts && opts.punch);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').putImageData(new ImageData(px, w, h), 0, 0);
    return opts && opts.url ? c.toDataURL() : c;
  }

  // ---- 画像/動画 -> {blurhash,w,h} ----
  function loadImg(blobOrImg) {
    return new Promise((res, rej) => {
      if (blobOrImg && blobOrImg.tagName === 'IMG') { blobOrImg.complete && blobOrImg.naturalWidth ? res({ el: blobOrImg, w: blobOrImg.naturalWidth, h: blobOrImg.naturalHeight }) : rej(new Error('img not ready')); return; }
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(blobOrImg).then(b => res({ el: b, w: b.width, h: b.height, bmp: b }), rej);
        return;
      }
      const u = URL.createObjectURL(blobOrImg), im = new Image();
      im.onload = () => { URL.revokeObjectURL(u); res({ el: im, w: im.naturalWidth, h: im.naturalHeight }); };
      im.onerror = () => { URL.revokeObjectURL(u); rej(new Error('decode')); };
      im.src = u;
    });
  }
  // 動画は最初のほうの1コマ(黒いことが多い0秒は避ける)。数秒で取れなければ諦める(送信を遅らせない)
  function videoFrame(file) {
    return new Promise((res, rej) => {
      const u = URL.createObjectURL(file), v = document.createElement('video');
      let done = false;
      const fin = (ok, val) => { if (done) return; done = true; clearTimeout(tm); v.removeAttribute('src'); try { v.load(); } catch (e) {} URL.revokeObjectURL(u); ok ? res(val) : rej(val); };
      const tm = setTimeout(() => fin(false, new Error('timeout')), 4000);
      v.muted = true; v.playsInline = true; v.preload = 'metadata';
      v.onerror = () => fin(false, new Error('video'));
      v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.1, (v.duration || 1) / 2); } catch (e) { fin(false, e); } };
      v.onseeked = () => fin(true, { el: v, w: v.videoWidth, h: v.videoHeight });
      v.src = u;
    });
  }

  async function describe(src) {
    try {
      let L;
      if (src && src.getContext) L = { el: src, w: src.width, h: src.height };
      else if (src && src.type && String(src.type).indexOf('video/') === 0) L = await videoFrame(src);
      else if (src && src.type && (String(src.type).indexOf('image/') !== 0 || /svg/.test(src.type))) return null;
      else L = await loadImg(src);
      if (!L.w || !L.h) return null;
      const k = Math.min(1, 32 / Math.max(L.w, L.h));
      const cw = Math.max(1, Math.round(L.w * k)), ch = Math.max(1, Math.round(L.h * k));
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(L.el, 0, 0, cw, ch);
      const hash = encodePixels(x.getImageData(0, 0, cw, ch).data, cw, ch, 4, 3);
      if (L.bmp && L.bmp.close) L.bmp.close();
      return { blurhash: hash, w: L.w, h: L.h };
    } catch (e) { return null; }
  }

  // ---- 復号済みメタデータから取り出す(本体は落とさない) ----
  const metaCache = new Map();   // nonce -> info|null  (同じメッセージを何度も復号しない)
  function fromEncryptedMetadata(encMeta, keyOrKeys) {
    try {
      const up = window.cloudinaryE2EUploader;
      if (!up || !up.peekMetadata) return null;
      const nonce = encMeta && (typeof encMeta === 'string' ? encMeta.slice(0, 64) : encMeta.nonce);
      if (nonce && metaCache.has(nonce)) return metaCache.get(nonce);
      const m = up.peekMetadata(encMeta, keyOrKeys);
      const info = m && m.blurhash && valid(m.blurhash) ? { blurhash: m.blurhash, w: m.w, h: m.h } : null;
      if (nonce && (info || m)) metaCache.set(nonce, info);   // 復号に失敗(m=null)した時は覚えない(鍵が後で揃うかも)
      if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
      return info;
    } catch (e) { return null; }
  }

  // ---- 描画 ----
  const urlCache = new Map();
  function paint(el, info, opts) {
    try {
      if (!el || !info || !valid(info.blurhash)) return false;
      const w = +info.w, h = +info.h;
      const hasDim = w > 0 && h > 0 && isFinite(w) && isFinite(h);
      const ratio = hasDim ? w / h : 1;
      const dw = ratio >= 1 ? 32 : Math.max(8, Math.round(32 * ratio));
      const dh = ratio >= 1 ? Math.max(8, Math.round(32 / ratio)) : 32;
      const key = info.blurhash + ':' + dw + 'x' + dh;
      let url = urlCache.get(key);
      if (!url) {
        url = decode(info.blurhash, dw, dh, { url: true });
        urlCache.set(key, url);
        if (urlCache.size > 200) urlCache.delete(urlCache.keys().next().value);
      }
      const s = el.style;
      s.backgroundImage = 'url(' + url + ')';
      s.backgroundSize = '100% 100%';
      s.backgroundRepeat = 'no-repeat';
      if (hasDim) {
        s.aspectRatio = w + ' / ' + h;
        if (opts && opts.maxH) s.maxHeight = opts.maxH;
      }
      el.setAttribute('data-bh', '1');
      return true;
    } catch (e) { return false; }
  }
  function clear(el) {
    if (!el || !el.getAttribute || !el.getAttribute('data-bh')) return;
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundRepeat = '';
    el.removeAttribute('data-bh');
  }

  window.BroBlurhash = { encode, decode, describe, fromEncryptedMetadata, paint, clear, _valid: valid };
})();
