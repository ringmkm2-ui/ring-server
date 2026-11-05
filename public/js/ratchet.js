// public/js/ratchet.js
// 個人チャットの暗号(e5)。X3DH で最初の鍵を決め、Double Ratchet でメッセージごとに鍵を更新する。
//
// e3(固定の端末鍵)との違い:
//  - 前方秘匿性: 使った鍵はすぐ捨てる。今の鍵を盗まれても、過去の暗号文は開けない
//  - 侵害後の回復: 相手とやり取りが続けば新しいDH鍵が混ざり、盗まれた状態から回復する
// その代わり、サーバーの暗号文は後からもう開けない。読めた本文は端末の中(IndexedDB)にだけ残す。
//
// 暗号の部品は TweetNaCl だけで同期的に計算する(X25519, XSalsa20-Poly1305, SHA-512)。
// 同期にしているのは、状態の読み出しから書き戻しまでを1つのIndexedDBトランザクションに収めるため。
// ページと Service Worker が同時に開いても、同じ鍵を2回使ったり状態を巻き戻したりしない。
//
// 形式:  e5:<送信端末の公開鍵>:<受信端末の公開鍵>.<種類><Base64>,...
//   種類 r = ラチェットの暗号文 / b = まだ対応していない端末あての nacl.box(移行期間だけ)
// window / Service Worker / Node(テスト)で動く。nacl と nacl.util が先に必要。
(function (g) {
  'use strict';
  const PREFIX = 'e5:';
  const VERSION = 1;
  const MAX_SKIP = 2000;            // 1つのチェーンで飛ばせる数(巨大な番号を送られて計算を止められないように)
  const MAX_SKIPPED_TOTAL = 4000;   // 溜めておく飛ばした鍵の総数
  const SKIPPED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 飛ばした鍵は前方秘匿性を弱めるので、古いものは捨てる
  const MAX_SESSIONS_PER_PEER = 5;  // 同時に始めた時など、1組に複数のセッションがありうる
  const MAX_RECIPIENTS = 32;
  const SPK_ROTATE_MS = 7 * 24 * 60 * 60 * 1000;
  const SPK_KEEP_MS = 30 * 24 * 60 * 60 * 1000;   // 回転後も、届くのが遅れた最初の1通のために少し残す
  const OTK_TARGET = 50, OTK_LOW = 20;

  const nacl = () => g.nacl;
  const u8 = n => new Uint8Array(n);
  const b64e = b => nacl().util.encodeBase64(b);
  const b64d = s => nacl().util.decodeBase64(s);
  const utf8 = s => nacl().util.decodeUTF8(s);

  function concat() {
    let n = 0;
    for (let i = 0; i < arguments.length; i++) n += arguments[i].length;
    const out = u8(n);
    let p = 0;
    for (let i = 0; i < arguments.length; i++) { out.set(arguments[i], p); p += arguments[i].length; }
    return out;
  }
  function wipe(b) { if (b && b.fill) b.fill(0); }
  function equal(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
  }

  // --- HMAC-SHA512 / HKDF(RFC 2104 / 5869)---
  function hmac(key, msg) {
    const BLOCK = 128;
    let k = key.length > BLOCK ? nacl().hash(key) : key;
    const ipad = u8(BLOCK), opad = u8(BLOCK);
    for (let i = 0; i < BLOCK; i++) { const c = i < k.length ? k[i] : 0; ipad[i] = c ^ 0x36; opad[i] = c ^ 0x5c; }
    return nacl().hash(concat(opad, nacl().hash(concat(ipad, msg))));
  }
  function hkdf(salt, ikm, info, len) {
    const prk = hmac(salt && salt.length ? salt : u8(64), ikm);
    const out = u8(len);
    let t = u8(0), pos = 0, c = 1;
    while (pos < len) {
      t = hmac(prk, concat(t, info, Uint8Array.of(c++)));
      out.set(t.subarray(0, Math.min(t.length, len - pos)), pos);
      pos += t.length;
    }
    return out;
  }

  const INFO_X3DH = utf8('BroChat-X3DH-v1');
  const INFO_RK = utf8('BroChat-DR-root-v1');
  const INFO_MSG = utf8('BroChat-DR-msg-v1');

  function genDH() {
    const k = nacl().box.keyPair();
    return { pub: k.publicKey, sec: k.secretKey };
  }
  // 小さな部分群の鍵を送られると共有鍵が全部0になる。そのまま使うと誰でも解けるので拒否する
  function dh(sec, pub) {
    if (!pub || pub.length !== 32) throw new Error('bad public key');
    const out = nacl().scalarMult(sec, pub);
    let z = 0;
    for (let i = 0; i < out.length; i++) z |= out[i];
    if (z === 0) throw new Error('bad public key');
    return out;
  }
  function kdfRK(rk, dhOut) {
    const o = hkdf(rk, dhOut, INFO_RK, 64);
    return { rk: o.slice(0, 32), ck: o.slice(32, 64) };
  }
  function kdfCK(ck) {
    return { mk: hmac(ck, Uint8Array.of(1)).slice(0, 32), ck: hmac(ck, Uint8Array.of(2)).slice(0, 32) };
  }

  // --- 見出し(暗号化はしないが、下の sealBody で認証される)---
  // [版1][種類1][DH32][前のチェーンの長さ4][番号4]  種類=1 なら続けて [送信者の端末鍵32][一時鍵32][SPK番号4][OTK番号4(無ければ0)]
  const HDR = 1 + 1 + 32 + 4 + 4, PRE = 32 + 32 + 4 + 4;
  function u32(n) { const b = u8(4); new DataView(b.buffer).setUint32(0, n >>> 0); return b; }
  function rd32(b, off) { return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(off); }
  function encHeader(h) {
    const base = concat(Uint8Array.of(VERSION, h.pre ? 1 : 0), h.dh, u32(h.pn), u32(h.n));
    return h.pre ? concat(base, h.pre.ik, h.pre.ek, u32(h.pre.spkId), u32(h.pre.otkId || 0)) : base;
  }
  function decHeader(bytes) {
    if (bytes.length < HDR || bytes[0] !== VERSION || bytes[1] > 1) throw new Error('bad header');
    const h = { dh: bytes.slice(2, 34), pn: rd32(bytes, 34), n: rd32(bytes, 38), pre: null, size: HDR };
    if (bytes[1] === 1) {
      if (bytes.length < HDR + PRE) throw new Error('bad header');
      h.pre = { ik: bytes.slice(HDR, HDR + 32), ek: bytes.slice(HDR + 32, HDR + 64), spkId: rd32(bytes, HDR + 64), otkId: rd32(bytes, HDR + 68) };
      h.size = HDR + PRE;
    }
    return h;
  }

  // 本文の鍵は、メッセージ鍵 + 両端末の鍵 + 見出し から導く。見出しや宛先を書き換えると開けなくなる
  function bodyKey(mk, ad, header) {
    const o = hkdf(ad, mk, concat(INFO_MSG, header), 32 + 24);
    return { key: o.slice(0, 32), nonce: o.slice(32) };
  }
  function makeAD(senderIk, recipientIk) { return concat(senderIk, recipientIk); }

  // --- X3DH ---
  // 送る側。bundle = { ik, spk:{id,pub}, otk:{id,pub}|null } / myIk = { pub, sec }
  function x3dhInitiate(myIk, bundle) {
    const ek = genDH();
    const parts = [u8(32).fill(0xff), dh(myIk.sec, bundle.spk.pub), dh(ek.sec, bundle.ik), dh(ek.sec, bundle.spk.pub)];
    if (bundle.otk) parts.push(dh(ek.sec, bundle.otk.pub));
    const sk = hkdf(u8(64), concat.apply(null, parts), INFO_X3DH, 32);
    parts.forEach(wipe);
    const s = genDH();
    const r = kdfRK(sk, dh(s.sec, bundle.spk.pub));
    const state = {
      v: VERSION, rk: r.rk, cks: r.ck, ckr: null, dhs: s, dhr: bundle.spk.pub, ns: 0, nr: 0, pn: 0,
      skipped: [], peer: bundle.ik, me: myIk.pub, createdAt: Date.now(), lastUsed: Date.now(),
      pending: { ik: myIk.pub, ek: ek.pub, spkId: bundle.spk.id, otkId: bundle.otk ? bundle.otk.id : 0 },
    };
    wipe(ek.sec); wipe(sk);
    return state;
  }
  // 受ける側。spk / otk は自分の秘密鍵(otk はこの後すぐ消す)
  function x3dhRespond(myIk, spk, otk, pre) {
    const parts = [u8(32).fill(0xff), dh(spk.sec, pre.ik), dh(myIk.sec, pre.ek), dh(spk.sec, pre.ek)];
    if (otk) parts.push(dh(otk.sec, pre.ek));
    const sk = hkdf(u8(64), concat.apply(null, parts), INFO_X3DH, 32);
    parts.forEach(wipe);
    return {
      v: VERSION, rk: sk, cks: null, ckr: null, dhs: { pub: spk.pub.slice(), sec: spk.sec.slice() }, dhr: null, ns: 0, nr: 0, pn: 0,
      skipped: [], peer: pre.ik, me: myIk.pub, createdAt: Date.now(), lastUsed: Date.now(), pending: null, ek: pre.ek,
    };
  }

  // --- Double Ratchet ---
  function cloneState(s) {
    const c = b => (b ? b.slice() : b);
    return Object.assign({}, s, {
      rk: c(s.rk), cks: c(s.cks), ckr: c(s.ckr), dhr: c(s.dhr), peer: c(s.peer), me: c(s.me),
      dhs: { pub: c(s.dhs.pub), sec: c(s.dhs.sec) },
      skipped: s.skipped.map(x => ({ dh: c(x.dh), n: x.n, mk: c(x.mk), at: x.at })),
      pending: s.pending ? Object.assign({}, s.pending) : null,
    });
  }
  function ratchetEncrypt(state, plain) {
    if (!state.cks) {
      // 受けた側は、最初に送る時に自分のDH鍵を更新する
      const s = genDH();
      const r = kdfRK(state.rk, dh(s.sec, state.dhr));
      wipe(state.dhs.sec);
      state.dhs = s; state.rk = r.rk; state.cks = r.ck; state.pn = state.ns; state.ns = 0;
    }
    const step = kdfCK(state.cks);
    wipe(state.cks);
    state.cks = step.ck;
    const header = encHeader({ dh: state.dhs.pub, pn: state.pn, n: state.ns, pre: state.pending });
    state.ns += 1;
    state.lastUsed = Date.now();
    const b = bodyKey(step.mk, makeAD(state.me, state.peer), header);
    const ct = nacl().secretbox(plain, b.nonce, b.key);
    wipe(step.mk); wipe(b.key);
    return concat(header, ct);
  }
  function skipKeys(state, until, now) {
    if (until - state.nr > MAX_SKIP) throw new Error('too many skipped messages');
    if (!state.ckr) return;
    while (state.nr < until) {
      const step = kdfCK(state.ckr);
      wipe(state.ckr);
      state.ckr = step.ck;
      state.skipped.push({ dh: state.dhr.slice(), n: state.nr, mk: step.mk, at: now });
      state.nr += 1;
    }
  }
  function pruneSkipped(state, now) {
    const keep = state.skipped.filter(x => now - x.at <= SKIPPED_TTL_MS);
    const over = keep.length - MAX_SKIPPED_TOTAL;
    state.skipped.filter(x => !keep.includes(x)).forEach(x => wipe(x.mk));
    if (over > 0) keep.splice(0, over).forEach(x => wipe(x.mk));
    state.skipped = keep;
  }
  // state は書き換える。失敗した時は呼び出し側が元の状態を使う(開けない暗号文で状態を壊させない)
  function ratchetDecrypt(state, bytes) {
    const now = Date.now();
    const h = decHeader(bytes);
    const header = bytes.subarray(0, h.size), ct = bytes.subarray(h.size);
    const ad = makeAD(state.peer, state.me);
    const open = mk => {
      const b = bodyKey(mk, ad, header);
      const out = nacl().secretbox.open(ct, b.nonce, b.key);
      wipe(b.key);
      return out;
    };
    const i = state.skipped.findIndex(x => x.n === h.n && equal(x.dh, h.dh));
    if (i >= 0) {
      const out = open(state.skipped[i].mk);
      if (!out) throw new Error('decrypt failed');
      wipe(state.skipped[i].mk);
      state.skipped.splice(i, 1);
      state.lastUsed = now;
      return out;
    }
    if (!state.dhr || !equal(h.dh, state.dhr)) {
      skipKeys(state, h.pn, now);
      state.pn = state.ns; state.ns = 0; state.nr = 0;
      state.dhr = h.dh;
      const r1 = kdfRK(state.rk, dh(state.dhs.sec, state.dhr));
      state.ckr = r1.ck;
      const s = genDH();
      const r2 = kdfRK(r1.rk, dh(s.sec, state.dhr));
      wipe(state.dhs.sec);
      state.dhs = s; state.rk = r2.rk; state.cks = r2.ck;
    }
    skipKeys(state, h.n, now);
    if (h.n < state.nr) throw new Error('replay or old message');
    const step = kdfCK(state.ckr);
    const out = open(step.mk);
    wipe(step.mk);
    if (!out) throw new Error('decrypt failed');
    wipe(state.ckr);
    state.ckr = step.ck;
    state.nr = h.n + 1;
    state.pending = null;   // 相手から届いた = 相手はセッションを持っている。もう最初の情報は要らない
    state.lastUsed = now;
    pruneSkipped(state, now);
    return out;
  }

  // --- 形式 ---
  function parse(str) {
    if (typeof str !== 'string' || !str.startsWith(PREFIX)) return null;
    const i = str.indexOf(':', PREFIX.length);
    if (i < 0) return null;
    const entries = new Map();
    for (const part of str.slice(i + 1).split(',')) {
      const d = part.indexOf('.');
      if (d > 0 && d < part.length - 1) entries.set(part.slice(0, d), part.slice(d + 1));
    }
    return entries.size ? { senderPub: str.slice(PREFIX.length, i), entries } : null;
  }
  const isRatchet = s => typeof s === 'string' && s.startsWith(PREFIX);
  function cacheKey(str) { return b64e(nacl().hash(utf8(str)).slice(0, 24)); }

  // --- 端末内の保存(IndexedDB)---
  // sessions: 相手の端末鍵 -> セッションの配列 / plain: 暗号文のハッシュ -> 本文 / prekeys: 自分の秘密プリキー / meta: その他
  function idbReq(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  const dbs = new Map();
  function openDb(uid) {
    if (dbs.has(uid)) return dbs.get(uid);
    const p = new Promise((res, rej) => {
      const r = indexedDB.open('bc_e5_' + uid, 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        ['sessions', 'plain', 'prekeys', 'meta'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
      };
      r.onsuccess = () => {
        r.result.onversionchange = () => { r.result.close(); dbs.delete(uid); };
        res(r.result);
      };
      r.onerror = () => rej(r.error);
    });
    dbs.set(uid, p);
    p.catch(() => dbs.delete(uid));
    return p;
  }

  function makeClient(opts) {
    // opts: { uid, identity: () => ({pub,sec} Uint8Array), http(method, path, body) }
    const db = () => (opts.db ? Promise.resolve(opts.db) : openDb(opts.uid));
    const me = () => opts.identity();

    async function tx(stores, mode, fn) {
      const d = await db();
      return new Promise((res, rej) => {
        const t = d.transaction(stores, mode);
        let out, err = null;
        t.oncomplete = () => (err ? rej(err) : res(out));
        t.onerror = () => rej(err || t.error);
        t.onabort = () => rej(err || t.error || new Error('aborted'));
        Promise.resolve(fn(t)).then(v => { out = v; }, e => { err = e; try { t.abort(); } catch (_) {} });
      });
    }

    // 相手の端末あての1通を作る。セッションの読み書きとラチェットを1つのトランザクションで
    async function encryptFor(peerPub, plain) {
      const my = me();
      let out = await tx(['sessions'], 'readwrite', async t => {
        const st = t.objectStore('sessions');
        const list = (await idbReq(st.get(peerPub))) || [];
        if (!list.length) return null;
        const bytes = ratchetEncrypt(list[0], plain);
        st.put(list, peerPub);
        return bytes;
      });
      if (out) return out;
      // セッションが無ければプリキーを取る(通信はトランザクションの外)
      const b = await opts.http('GET', '/api/ratchet/bundle/' + encodeURIComponent(peerPub));
      if (!b || !b.spk) return null;
      const peer = b64d(peerPub);
      if (!equal(b64d(b.deviceKey), peer)) throw new Error('bundle mismatch');
      const init = x3dhInitiate(my, {
        ik: peer,
        spk: { id: b.spk.id, pub: b64d(b.spk.pub) },
        otk: b.otk ? { id: b.otk.id, pub: b64d(b.otk.pub) } : null,
      });
      await tx(['sessions', 'meta'], 'readwrite', async t => {
        const st = t.objectStore('sessions');
        const list = (await idbReq(st.get(peerPub))) || [];
        list.unshift(init);
        list.splice(MAX_SESSIONS_PER_PEER);
        out = ratchetEncrypt(init, plain);
        st.put(list, peerPub);
        t.objectStore('meta').put(true, 'peer:' + peerPub);   // この端末は対応済み。以後 box に戻さない
      });
      return out;
    }

    // bytes を recipients(公開鍵Base64の配列)全員あてに。対応していない端末は移行期間だけ box で包む
    async function seal(bytes, recipients) {
      const my = me();
      const myB64 = b64e(my.pub);
      const seen = new Set([myB64]);
      const entries = [];
      for (const pb of recipients) {
        if (!pb || seen.has(pb)) continue;
        if (entries.length >= MAX_RECIPIENTS) throw new Error('送り先の端末が多すぎます');
        seen.add(pb);
        let pk;
        try { pk = b64d(pb); } catch (e) { continue; }
        if (pk.length !== 32) continue;
        let ct = await encryptFor(pb, bytes);
        if (ct) { entries.push(pb + '.r' + b64e(ct)); continue; }
        const pinned = await tx(['meta'], 'readonly', t => idbReq(t.objectStore('meta').get('peer:' + pb)));
        if (pinned) {
          // 前は前方秘匿性ありで話せていた端末。ここで box に落とすと、サーバーがプリキーを隠すだけで弱められる
          const e = new Error('相手の端末の暗号鍵を確かめられないため送りませんでした');
          e.code = 'RATCHET_DOWNGRADE';
          throw e;
        }
        const nonce = nacl().randomBytes(24);
        entries.push(pb + '.b' + b64e(concat(nonce, nacl().box(bytes, nonce, pk, my.sec))));
      }
      if (!entries.length) return null;
      const content = PREFIX + myB64 + ':' + entries.join(',');
      await remember(content, bytes);   // 自分の分は暗号文に入れない。本文は端末の中だけに残す
      return content;
    }

    async function remember(content, bytes) {
      const k = cacheKey(content);
      const v = { b: bytes.slice(), at: Date.now() };
      await tx(['plain'], 'readwrite', async t => { t.objectStore('plain').put(v, k); });
    }
    async function recall(content) {
      const k = cacheKey(content);
      const v = await tx(['plain'], 'readonly', t => idbReq(t.objectStore('plain').get(k)));
      return v ? v.b : null;
    }

    // 戻り値: 本文のバイト列 / 開けなければ null。同じ暗号文は何度呼んでも同じ結果(2回目からは保存分)
    async function open(content) {
      const p = parse(content);
      if (!p) return null;
      const hit = await recall(content);
      if (hit) return hit;
      const my = me();
      const entry = p.entries.get(b64e(my.pub));
      if (!entry) return null;
      const kind = entry[0];
      let body;
      try { body = b64d(entry.slice(1)); } catch (e) { return null; }
      if (kind === 'b') {
        if (body.length < 24 + 16) return null;
        let out = null;
        try { out = nacl().box.open(body.slice(24), body.slice(0, 24), b64d(p.senderPub), my.sec); } catch (e) { out = null; }
        if (!out) return null;
        await remember(content, out);
        return out;
      }
      if (kind !== 'r') return null;
      const k = cacheKey(content);
      return tx(['sessions', 'plain', 'prekeys', 'meta'], 'readwrite', async t => {
        const sessions = t.objectStore('sessions');
        // 別のページや Service Worker が先に開いていたら、もう鍵は無い。保存された本文を返す
        const done = await idbReq(t.objectStore('plain').get(k));
        if (done) return done.b;
        const list = (await idbReq(sessions.get(p.senderPub))) || [];
        for (let i = 0; i < list.length; i++) {
          const trial = cloneState(list[i]);
          let out = null;
          try { out = ratchetDecrypt(trial, body); } catch (e) { out = null; }
          if (!out) continue;
          list.splice(i, 1);
          list.unshift(trial);
          sessions.put(list, p.senderPub);
          t.objectStore('plain').put({ b: out, at: Date.now() }, k);
          return out;
        }
        // 既存のセッションで開けない: 相手が始めた新しいセッションの最初の1通か確かめる
        let h;
        try { h = decHeader(body); } catch (e) { return null; }
        if (!h.pre || b64e(h.pre.ik) !== p.senderPub) return null;
        const ekB64 = b64e(h.pre.ek);
        if (await idbReq(t.objectStore('meta').get('ek:' + ekB64))) return null;   // 同じ最初の1通の再送は受けない
        const pks = t.objectStore('prekeys');
        const spk = await idbReq(pks.get('spk:' + h.pre.spkId));
        if (!spk) return null;
        let otk = null;
        if (h.pre.otkId) {
          otk = await idbReq(pks.get('otk:' + h.pre.otkId));
          if (!otk) return null;     // 使用済みのOTK = 再送か、もう開けないもの
        }
        let state, out = null;
        try {
          state = x3dhRespond(my, spk, otk, h.pre);
          out = ratchetDecrypt(state, body);
        } catch (e) { return null; }
        if (!out) return null;
        if (h.pre.otkId) pks.delete('otk:' + h.pre.otkId);   // 前方秘匿性のために使ったら消す
        t.objectStore('meta').put(Date.now(), 'ek:' + ekB64);
        t.objectStore('meta').put(true, 'peer:' + p.senderPub);
        list.unshift(state);
        list.splice(MAX_SESSIONS_PER_PEER);
        sessions.put(list, p.senderPub);
        t.objectStore('plain').put({ b: out, at: Date.now() }, k);
        return out;
      });
    }

    // プリキーを用意してサーバーへ。古いSPKは回転し、OTKは減ったら足す
    async function ensurePrekeys() {
      const my = me();
      const myB64 = b64e(my.pub);
      const now = Date.now();
      const state = await tx(['prekeys', 'meta'], 'readonly', async t => {
        const metaS = t.objectStore('meta');
        return { spkId: await idbReq(metaS.get('spkId')), spkAt: await idbReq(metaS.get('spkAt')), otkNext: await idbReq(metaS.get('otkNext')) };
      });
      const cnt = await opts.http('GET', '/api/ratchet/prekeys/count?deviceKey=' + encodeURIComponent(myB64));
      const remote = cnt && typeof cnt.otks === 'number' ? cnt.otks : 0;
      const needSpk = !state.spkId || !state.spkAt || now - state.spkAt > SPK_ROTATE_MS || !(cnt && cnt.spkId === state.spkId);
      const needOtk = remote < OTK_LOW;
      if (!needSpk && !needOtk) return false;
      let spkId = state.spkId || 0, spkPub = null, otkNext = state.otkNext || 1;
      const otksOut = [];
      await tx(['prekeys', 'meta'], 'readwrite', async t => {
        const pks = t.objectStore('prekeys'), metaS = t.objectStore('meta');
        if (needSpk) {
          const k = genDH();
          spkId = (spkId % 0x7fffffff) + 1;
          pks.put({ pub: k.pub, sec: k.sec, at: now }, 'spk:' + spkId);
          metaS.put(spkId, 'spkId'); metaS.put(now, 'spkAt');
          spkPub = k.pub;
        } else {
          const cur = await idbReq(pks.get('spk:' + spkId));
          spkPub = cur ? cur.pub : null;
        }
        // 回転して時間が経ったSPKの秘密鍵は消す
        const keys = await idbReq(pks.getAllKeys());
        for (const key of keys) {
          if (!String(key).startsWith('spk:') || key === 'spk:' + spkId) continue;
          const v = await idbReq(pks.get(key));
          if (v && now - v.at > SPK_KEEP_MS) pks.delete(key);
        }
        if (needOtk) {
          for (let i = remote; i < OTK_TARGET; i++) {
            const k = genDH(), id = otkNext++;
            pks.put({ pub: k.pub, sec: k.sec, at: now }, 'otk:' + id);
            otksOut.push({ id, pub: b64e(k.pub) });
          }
          metaS.put(otkNext, 'otkNext');
        }
      });
      if (!spkPub) return false;
      await opts.http('POST', '/api/ratchet/prekeys', { deviceKey: myB64, spk: { id: spkId, pub: b64e(spkPub) }, otks: otksOut });
      return true;
    }

    return { seal, open, recall, remember, ensurePrekeys };
  }

  g.E2ERatchet = {
    PREFIX, isRatchet, parse, cacheKey, makeClient,
    core: { x3dhInitiate, x3dhRespond, ratchetEncrypt, ratchetDecrypt, cloneState, genDH, hmac, hkdf, dh, encHeader, decHeader, MAX_SKIP },
  };
})(typeof self !== 'undefined' ? self : globalThis);
