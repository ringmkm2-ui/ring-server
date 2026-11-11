// public/js/stripMeta.js
// 送る画像から撮影情報(位置情報=GPS、機種、撮影日時、編集ソフトなど)を消す。Signal と同じく、画像は必ず消してから送る。
// 再圧縮はしない(画質を落とさない)。バイト列から不要な部分だけを取り除く。
//  - JPEG: APP1(EXIF/XMP)・APP3〜APP13・APP15・COM・MPF と、終わり(EOI)の後ろに付いた余分なデータ
//          (Galaxy のモーションフォトの動画や独自の撮影情報)を消す。
//          向き(Orientation)だけは消すと写真が横倒しになるので、その1項目だけの最小の EXIF を作り直して残す。
//          色の情報(ICC)と JFIF/Adobe は表示に必要なので残す。
//  - PNG : tEXt/zTXt/iTXt/eXIf/tIME を消す。
//  - WebP: EXIF/XMP を消して VP8X のフラグと RIFF の長さを直す。
//  - GIF・HEIC・動画などは扱わない(そのまま返す)。
// 形式が壊れていて読めない時は、Canvas で描き直して情報を全部落とす(位置情報を残したまま送るよりまし)。
(function (root) {
  'use strict';

  function u16be(b, i) { return (b[i] << 8) | b[i + 1]; }
  function u32be(b, i) { return ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]; }
  function u32le(b, i) { return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + ((b[i + 3] << 24) >>> 0); }
  function eqStr(b, i, s) { for (let k = 0; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) return false; return true; }
  function concat(parts) {
    let n = 0; for (const p of parts) n += p.length;
    const out = new Uint8Array(n); let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function kind(b) {
    if (b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b.length > 8 && b[0] === 0x89 && eqStr(b, 1, 'PNG\r\n\x1a\n')) return 'png';
    if (b.length > 12 && eqStr(b, 0, 'RIFF') && eqStr(b, 8, 'WEBP')) return 'webp';
    return null;
  }

  // ---- JPEG ----
  // EXIF(TIFF)の中から向き(0x0112)だけを読む。読めなければ 1(そのまま)
  function readOrientation(seg) {
    // seg は APP1 の中身("Exif\0\0" から)
    if (!eqStr(seg, 0, 'Exif\0\0')) return 1;
    const t = 6;
    if (seg.length < t + 8) return 1;
    const le = seg[t] === 0x49 && seg[t + 1] === 0x49;
    const rd16 = i => le ? (seg[i] | (seg[i + 1] << 8)) : u16be(seg, i);
    const rd32 = i => le ? u32le(seg, i) : u32be(seg, i);
    const ifd = t + rd32(t + 4);
    if (ifd + 2 > seg.length) return 1;
    const n = rd16(ifd);
    for (let k = 0; k < n; k++) {
      const e = ifd + 2 + k * 12;
      if (e + 12 > seg.length) break;
      if (rd16(e) === 0x0112) {
        const v = rd16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
    return 1;
  }
  // 向きだけを持つ最小の EXIF(APP1 セグメント全体、マーカー込み)
  function orientationApp1(o) {
    const body = new Uint8Array([
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,             // "Exif\0\0"
      0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // big endian TIFF, IFD0 は 8 バイト目
      0x00, 0x01,                                     // 項目は1つ
      0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, 1個
      0x00, o, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00,                         // 次の IFD は無し
    ]);
    const len = body.length + 2;
    return concat([new Uint8Array([0xFF, 0xE1, len >> 8, len & 0xFF]), body]);
  }

  function stripJpeg(b) {
    const out = [b.subarray(0, 2)]; // SOI
    let i = 2, orientation = 1, insertedAt = -1;
    while (i < b.length) {
      if (b[i] !== 0xFF) throw new Error('jpeg: marker expected');
      let m = b[i + 1];
      if (m === 0xFF) { i++; continue; }           // 詰め物
      if (m === 0xD9) { out.push(b.subarray(i, i + 2)); return { bytes: concat(fixOrientation(out, insertedAt, orientation)), orientation }; }
      if (m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { out.push(b.subarray(i, i + 2)); i += 2; continue; }
      if (i + 4 > b.length) throw new Error('jpeg: truncated');
      const len = u16be(b, i + 2);
      if (len < 2 || i + 2 + len > b.length) throw new Error('jpeg: bad length');
      const seg = b.subarray(i, i + 2 + len);
      const data = b.subarray(i + 4, i + 2 + len);
      let keep = true;
      if (m === 0xE1) { // EXIF / XMP
        if (eqStr(data, 0, 'Exif\0\0') && orientation === 1) orientation = readOrientation(data);
        keep = false;
      } else if (m === 0xE2) { // ICC は残す。MPF(複数画像の目次)は後ろのデータを消すので一緒に消す
        keep = eqStr(data, 0, 'ICC_PROFILE\0');
      } else if ((m >= 0xE3 && m <= 0xED) || m === 0xEF || m === 0xFE) {
        keep = false; // APP3〜APP13(Photoshop の IPTC など)、APP15、コメント
      }
      if (keep) {
        out.push(seg);
        if (insertedAt < 0 && m !== 0xE0) insertedAt = out.length - 1; // JFIF(APP0)の直後に向きを入れる
      }
      i += 2 + len;
      if (m === 0xDA) { // SOS: 符号化データ。次のマーカーまでそのまま写す
        const start = i;
        while (i < b.length) {
          if (b[i] === 0xFF) {
            const n = b[i + 1];
            if (n === 0x00 || (n >= 0xD0 && n <= 0xD7) || n === 0xFF) { i += (n === 0xFF ? 1 : 2); continue; }
            break;
          }
          i++;
        }
        if (i >= b.length) throw new Error('jpeg: no EOI');
        out.push(b.subarray(start, i));
      }
    }
    throw new Error('jpeg: no EOI');
  }
  function fixOrientation(out, at, o) {
    if (o === 1) return out;
    const seg = orientationApp1(o);
    if (at < 0) at = out.length - 1;
    return out.slice(0, at).concat([seg], out.slice(at));
  }

  // ---- PNG ----
  const PNG_DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  function stripPng(b) {
    const out = [b.subarray(0, 8)];
    let i = 8, sawEnd = false;
    while (i + 12 <= b.length) {
      const len = u32be(b, i);
      const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
      const end = i + 12 + len;
      if (end > b.length) throw new Error('png: truncated');
      if (!PNG_DROP.has(type)) out.push(b.subarray(i, end));
      i = end;
      if (type === 'IEND') { sawEnd = true; break; } // 後ろに付いた余分なデータは捨てる
    }
    if (!sawEnd) throw new Error('png: no IEND');
    return { bytes: concat(out) };
  }

  // ---- WebP ----
  function stripWebp(b) {
    const out = [];
    let i = 12, vp8x = -1;
    const riffEnd = Math.min(b.length, 8 + u32le(b, 4));
    while (i + 8 <= riffEnd) {
      const id = String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
      const len = u32le(b, i + 4);
      const end = i + 8 + len + (len & 1);
      if (i + 8 + len > b.length) throw new Error('webp: truncated');
      if (id !== 'EXIF' && id !== 'XMP ') {
        const chunk = b.slice(i, Math.min(end, b.length));
        if (id === 'VP8X') vp8x = out.length;
        out.push(chunk);
      }
      i = end;
    }
    if (vp8x >= 0) out[vp8x][8] &= ~(0x08 | 0x04); // EXIF と XMP の印を外す
    const body = concat(out);
    const head = new Uint8Array(12);
    head.set(b.subarray(0, 12));
    const size = body.length + 4;
    head[4] = size & 0xFF; head[5] = (size >> 8) & 0xFF; head[6] = (size >> 16) & 0xFF; head[7] = (size >>> 24) & 0xFF;
    return { bytes: concat([head, body]) };
  }

  // バイト列 → 消した後のバイト列。扱わない形式は null
  function stripBytes(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const k = kind(b);
    if (k === 'jpeg') return stripJpeg(b).bytes;
    if (k === 'png') return stripPng(b).bytes;
    if (k === 'webp') return stripWebp(b).bytes;
    return null;
  }

  // 最後の手段: 描き直して情報を全部落とす(createImageBitmap は向きを反映して描く)
  async function redraw(file) {
    if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null;
    const bmp = await createImageBitmap(file).catch(() => null);
    if (!bmp) return null;
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    if (bmp.close) bmp.close();
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(r => c.toBlob(r, type, 0.92));
    return blob ? new File([blob], file.name || 'image', { type, lastModified: Date.now() }) : null;
  }

  // File/Blob → 撮影情報を消した File。画像以外・GIF・HEIC はそのまま返す
  async function stripFile(file) {
    if (!file || !file.type || !/^image\/(jpeg|jpg|pjpeg|png|webp)$/i.test(file.type)) return file;
    try {
      const b = new Uint8Array(await file.arrayBuffer());
      const out = stripBytes(b);
      if (!out) return (await redraw(file)) || file;
      return new File([out], file.name || 'image', { type: file.type, lastModified: Date.now() });
    } catch (e) {
      console.warn('[stripMeta] 読めない画像なので描き直す', e && e.message);
      return (await redraw(file)) || file;
    }
  }

  const api = { stripFile, stripBytes, _readOrientation: readOrientation };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.bcStripMeta = api;
})(typeof window !== 'undefined' ? window : globalThis);
