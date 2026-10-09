// js/e2eMulti.js
// 1人が複数の端末(PCとスマホなど)を使うための暗号文 "e3"。
//
// 以前の "e2" は相手の鍵1本に向けて暗号化していた。サーバーに登録できる鍵も1人1本だったので、
// PCとスマホで別々の鍵を持っている人は、端末を開くたびに登録を上書きし合い、
// 「今サーバーに登録されていない方の端末」ではメッセージが開けなかった。
//
// e3 は同じ本文を、相手の全端末と自分の他の端末それぞれの鍵に向けて暗号化して1つにまとめる。
//   e3:<送信した端末の公開鍵>:<受け取る公開鍵>.<nonce+box>,<受け取る公開鍵>.<nonce+box>,...
// 中身は nacl.box(送信端末の秘密鍵 × 受け取る端末の公開鍵)。サーバーには読めない。
// window(ページ)と self(Service Worker)の両方で使う。nacl / nacl.util が先に必要。
(function (g) {
  const PREFIX = 'e3:';
  const MAX_RECIPIENTS = 16;

  function seal(bytes, senderSecretKey, senderPubB64, recipientPubB64List) {
    const nacl = g.nacl;
    const seen = new Set();
    const entries = [];
    for (const pb of recipientPubB64List) {
      if (!pb || seen.has(pb) || entries.length >= MAX_RECIPIENTS) continue;
      seen.add(pb);
      let pk;
      try { pk = nacl.util.decodeBase64(pb); } catch (e) { continue; }
      if (pk.length !== nacl.box.publicKeyLength) continue;
      const nonce = nacl.randomBytes(nacl.box.nonceLength);
      const box = nacl.box(bytes, nonce, pk, senderSecretKey);
      const full = new Uint8Array(nonce.length + box.length);
      full.set(nonce); full.set(box, nonce.length);
      entries.push(pb + '.' + nacl.util.encodeBase64(full));
    }
    if (!entries.length) return null;
    return PREFIX + senderPubB64 + ':' + entries.join(',');
  }

  function parse(str) {
    if (typeof str !== 'string' || !str.startsWith(PREFIX)) return null;
    const i = str.indexOf(':', PREFIX.length);
    if (i < 0) return null;
    const senderPub = str.slice(PREFIX.length, i);
    const entries = new Map();
    for (const part of str.slice(i + 1).split(',')) {
      const d = part.indexOf('.');
      if (d > 0) entries.set(part.slice(0, d), part.slice(d + 1));
    }
    return entries.size ? { senderPub, entries } : null;
  }

  // ring: [{ pk: 公開鍵Base64, sk: 秘密鍵Uint8Array }] (自分の鍵の全世代)
  // 戻り値: 平文のバイト列 / 開けなければ null
  function open(str, ring) {
    const nacl = g.nacl;
    const p = parse(str);
    if (!p || !Array.isArray(ring)) return null;
    const tryOpen = (b64, peerB64, sk) => {
      try {
        const full = nacl.util.decodeBase64(b64);
        const peer = nacl.util.decodeBase64(peerB64);
        if (peer.length !== nacl.box.publicKeyLength) return null;
        if (full.length <= nacl.box.nonceLength + nacl.box.overheadLength - 1) return null;
        return nacl.box.open(full.slice(nacl.box.nonceLength), full.slice(0, nacl.box.nonceLength), peer, sk) || null;
      } catch (e) { return null; }
    };
    // 1. 自分のどれかの鍵に向けた分があれば、送信端末の公開鍵で開く
    for (const k of ring) {
      const b = p.entries.get(k.pk);
      if (b) { const out = tryOpen(b, p.senderPub, k.sk); if (out) return out; }
    }
    // 2. 自分がこの端末から送ったもの: 宛先のどれか1つを、宛先の公開鍵 × 自分の秘密鍵で開く
    for (const k of ring) {
      if (k.pk !== p.senderPub) continue;
      for (const [pb, b] of p.entries) { const out = tryOpen(b, pb, k.sk); if (out) return out; }
    }
    return null;
  }

  g.E2EMulti = { PREFIX, seal, parse, open, isMulti: s => typeof s === 'string' && s.startsWith(PREFIX) };
})(typeof self !== 'undefined' ? self : window);
