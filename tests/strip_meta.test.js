// 送る画像から位置情報などが消えることを、本物の形式のバイト列を組み立てて確かめる
const { test } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { stripBytes, stripFile, _readOrientation } = require('../public/js/stripMeta.js');

const B = a => Uint8Array.from(a);
const str = s => Array.from(Buffer.from(s, 'latin1'));
const has = (u8, s) => Buffer.from(u8).includes(Buffer.from(s, 'latin1'));
const seg = (m, body) => [0xFF, m, (body.length + 2) >> 8, (body.length + 2) & 0xFF, ...body];

// GPS と向き(6=右に90度)を持つ EXIF。GPS の目印として文字列 "GPSSECRET35.68N" を入れる
function exifBody(orientation) {
  const t = [0x4D, 0x4D, 0x00, 0x2A, 0, 0, 0, 8,
    0, 2,
    0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0,
    0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 38, // GPS IFD へのポインタ
    0, 0, 0, 0,
    ...str('GPSSECRET35.68N')];
  return [...str('Exif\0\0'), ...t];
}
function jpeg({ orientation = 6, trailer = true } = {}) {
  return B([0xFF, 0xD8,
    ...seg(0xE0, str('JFIF\0\x01\x01\0\0\x01\0\x01\0\0')),
    ...seg(0xE1, exifBody(orientation)),
    ...seg(0xE1, str('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>GPSXMP</x:xmpmeta>')),
    ...seg(0xE2, str('ICC_PROFILE\0\x01\x01KEEPICC')),
    ...seg(0xE2, str('MPF\0MPFDATA')),
    ...seg(0xED, str('Photoshop 3.0\0IPTCCITY')),
    ...seg(0xFE, str('COMMENTXYZ')),
    ...seg(0xDB, new Array(65).fill(1)),
    ...seg(0xC0, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]),
    ...seg(0xC4, [0, ...new Array(16).fill(0)]),
    ...seg(0xDA, [1, 1, 0, 0, 63, 0]),
    0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56, // 符号化データ(FF00 と RST を含む)
    0xFF, 0xD9,
    ...(trailer ? str('MotionPhoto_Data GPSTRAILER') : [])]);
}

test('JPEG: EXIF/XMP/IPTC/コメント/MPF/後ろのデータが消え、ICC と画像データは残る', () => {
  const out = stripBytes(jpeg());
  for (const s of ['GPSSECRET', 'GPSXMP', 'IPTCCITY', 'COMMENTXYZ', 'MPFDATA', 'GPSTRAILER', 'MotionPhoto'])
    assert.ok(!has(out, s), s + ' が残っている');
  assert.ok(has(out, 'KEEPICC'));
  assert.ok(has(out, 'JFIF'));
  assert.deepEqual(Array.from(out.slice(0, 2)), [0xFF, 0xD8]);
  assert.deepEqual(Array.from(out.slice(-2)), [0xFF, 0xD9]);
  assert.ok(Buffer.from(out).includes(Buffer.from([0x12, 0xFF, 0x00, 0x34, 0xFF, 0xD0, 0x56])), '符号化データが変わった');
});

test('JPEG: 向きだけは残る(写真が横倒しにならない)', () => {
  const out = stripBytes(jpeg({ orientation: 6 }));
  // 残った APP1 を探して読む
  let i = 2, found = 0;
  while (i < out.length && out[i] === 0xFF && out[i + 1] !== 0xDA) {
    const len = (out[i + 2] << 8) | out[i + 3];
    if (out[i + 1] === 0xE1) found = _readOrientation(out.subarray(i + 4, i + 2 + len));
    i += 2 + len;
  }
  assert.equal(found, 6);
});

test('JPEG: 向きが 1 なら EXIF は丸ごと無くなる', () => {
  const out = stripBytes(jpeg({ orientation: 1, trailer: false }));
  assert.ok(!has(out, 'Exif'));
});

test('JPEG: 壊れたものは例外(呼ぶ側が描き直しに回す)', () => {
  const j = jpeg();
  assert.throws(() => stripBytes(j.slice(0, 40)));
});

function pngChunk(type, data) {
  const d = Buffer.from(data);
  const len = Buffer.alloc(4); len.writeUInt32BE(d.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), d]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
test('PNG: テキスト・EXIF・時刻のチャンクが消え、画像は残る', () => {
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]);
  const idat = zlib.deflateSync(Buffer.from([0, 255, 0, 0]));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk('IHDR', ihdr), pngChunk('tEXt', 'Comment\0GPSPNGTEXT'), pngChunk('eXIf', 'MM\0*GPSPNGEXIF'),
    pngChunk('tIME', [7, 234, 11, 11, 1, 2, 3]), pngChunk('iTXt', 'XML:com.adobe.xmp\0\0\0\0\0GPSPNGXMP'),
    pngChunk('IDAT', idat), pngChunk('IEND', []), Buffer.from('TRAILGPS')]);
  const out = stripBytes(png);
  for (const s of ['GPSPNG', 'tIME', 'TRAILGPS']) assert.ok(!has(out, s), s);
  for (const s of ['IHDR', 'IDAT', 'IEND']) assert.ok(has(out, s), s);
  assert.equal(out.length, 8 + 25 + (12 + idat.length) + 12);
});

test('WebP: EXIF/XMP が消え、VP8X のフラグと RIFF の長さが正しい', () => {
  const chunk = (id, data) => { const d = Buffer.from(data); const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(d.length, 4); return Buffer.concat([h, d, d.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const vp8x = Buffer.alloc(10); vp8x[0] = 0x08 | 0x04 | 0x10;
  const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8L', Buffer.from([0x2F, 0, 0, 0, 0])), chunk('EXIF', 'MM\0*GPSWEBP'), chunk('XMP ', '<x>GPSWEBPXMP</x>')]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  const out = Buffer.from(stripBytes(Buffer.concat([head, body])));
  assert.ok(!out.includes('GPSWEBP'));
  assert.equal(out.readUInt32LE(4), out.length - 8);
  const vi = out.indexOf('VP8X');
  assert.equal(out[vi + 8], 0x10, 'アルファの印は残し、EXIF/XMP の印だけ外す');
  assert.ok(out.includes('VP8L'));
});

test('stripFile: 画像以外・GIF はそのまま、JPEG は消した File を返す', async () => {
  const txt = new File(['hello'], 'a.txt', { type: 'text/plain' });
  assert.equal(await stripFile(txt), txt);
  const gif = new File(['GIF89a'], 'a.gif', { type: 'image/gif' });
  assert.equal(await stripFile(gif), gif);
  const f = await stripFile(new File([jpeg()], 'p.jpg', { type: 'image/jpeg' }));
  assert.equal(f.type, 'image/jpeg');
  assert.ok(!has(new Uint8Array(await f.arrayBuffer()), 'GPSSECRET'));
});
