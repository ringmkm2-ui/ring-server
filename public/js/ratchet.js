// public/js/ratchet.js
// 個人チャットの暗号(e5)。X3DH で最初の鍵を決め、Double Ratchet でメッセージごとに鍵を更新する。
//
// e3(固定の端末鍵)との違い:
//  - 前方秘匿性: 使った鍵はすぐ捨てる。今の鍵を盗まれても、サーバーに残る過去の暗号文は開けない
//    (端末そのものを盗まれると、端末に保存した本文は読まれる。これは鍵の更新では防げない)
//  - 侵害後の回復: 相手とやり取りが続けば新しいDH鍵が混ざり、盗まれた状態から回復する
// その代わり、サーバーの暗号文は後からもう開けない。読めた本文は端末の中(IndexedDB)にだけ残す。
//
// 暗号の部品は TweetNaCl だけで同期的に計算する(X25519, XSalsa20-Poly1305, SHA-512)。
// 同期にしているのは、状態の読み出しから書き戻しまでを1つのIndexedDBトランザクションに収めるため。
// ページと Service Worker が同時に開いても、同じ鍵を2回使ったり状態を巻き戻したりしない。
//
// 形式:  e5:<送信端末の公開鍵>:<受信端末の公開鍵>.<種類><Base64>,...
//   種類 r = ラチェットの暗号文 / b = まだ対応していない端末あての nacl.box(移行期間だけ)
// 本文の前に {f: 送信者, t: 宛先} を入れて暗号化する。別の会話の暗号文や自分の文を、相手の発言として見せられない。
// window / Service Worker / Node(テスト)で動く。nacl と nacl.util が先に必要。
(function (g) {
  'use strict';
  const PREFIX = 'e5:';
  const VERSION = 1;
  const MAX_SKIP = 1000;            // 1つのチェーンで飛ばせる数(巨大な番号を送られて計算を止められないように)
  const MAX_SKIP_DORMANT = 100;     // 今使っていないセッションでは小さく(細工した1通で何秒も止められないように)
  const DORMANT_MS = 14 * 24 * 60 * 60 * 1000; // 使わなくなったセッションは捨てる。残すと、盗まれた古い状態で割り込まれる
  const UNCONFIRMED_MS = 24 * 60 * 60 * 1000;  // 一度も返事が来ないセッションは作り直す(相手が開けていないかもしれない)
  const SILENT_MS = 7 * 24 * 60 * 60 * 1000;   // このセッションで長く受信していなければ作り直す(分岐や破損から自動で回復し、鍵も新しくなる)
  const SIM_START_MS = 60 * 60 * 1000;         // 両者が同時に始めたとみなす範囲
  const MAX_SKIPPED_TOTAL = 4000;   // 溜めておく飛ばした鍵の総数
  const SKIPPED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 飛ばした鍵は前方秘匿性を弱めるので、古いものは捨てる
  const MAX_SESSIONS_PER_PEER = 5;  // 同時に始めた時など、1組に複数のセッションがありうる
  const MAX_RECIPIENTS = 32;
  const SPK_ROTATE_MS = 7 * 24 * 60 * 60 * 1000;
  const SPK_KEEP_MS = 30 * 24 * 60 * 60 * 1000;   // 回転後も、届くのが遅れた最初の1通のために少し残す
  const OTK_TARGET = 50, OTK_LOW = 20, OTK_LOCAL_MAX = 300;

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

  // 正規の形の鍵だけ受け取る。同じ鍵の別表記(末尾ビットや最上位ビットの違い)を「別の端末」に見せかけられないように
  function canonicalKey(s) {
    try {
      if (typeof s !== 'string') return null;
      const k = b64d(s);
      if (k.length !== 32 || (k[31] & 0x80) || b64e(k) !== s) return null;
      return k;
    } catch (e) { return null; }
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

  // --- XEdDSA(Signal公開仕様)---
  // 端末の鍵は X25519 なので、そのままでは署名できない。同じ鍵で Ed25519 互換の署名を作る(SPKの署名に使う)。
  // 署名は端末の中で週1回ほどしか行わないので、BigIntで十分。検証は標準の Ed25519(nacl.sign)で行う。
  const P = (1n << 255n) - 19n;
  const Q = (1n << 252n) + 27742317777372353535851937790883648493n;
  const D = (P - 121665n) * modInv(121666n, P) % P;
  const BY = 4n * modInv(5n, P) % P;
  const BX = xFromY(BY);
  function modPow(b, e, m) { let r = 1n; b %= m; while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
  function modInv(a, m) { return modPow(((a % m) + m) % m, m - 2n, m); }
  function xFromY(y) {
    const yy = y * y % P;
    const xx = (yy - 1n + P) * modInv(D * yy + 1n, P) % P;
    let x = modPow(xx, (P + 3n) / 8n, P);
    if ((x * x - xx) % P !== 0n) x = x * modPow(2n, (P - 1n) / 4n, P) % P;
    return x & 1n ? P - x : x;
  }
  function leToBig(b) { let r = 0n; for (let i = b.length - 1; i >= 0; i--) r = (r << 8n) | BigInt(b[i]); return r; }
  function bigToLe(n, len) { const o = u8(len); for (let i = 0; i < len; i++) { o[i] = Number(n & 255n); n >>= 8n; } return o; }
  function ptAdd(p, q) {
    const [x1, y1, z1, t1] = p, [x2, y2, z2, t2] = q;
    const a = (y1 - x1 + P) * (y2 - x2 + P) % P, b = (y1 + x1) * (y2 + x2) % P, c = t1 * 2n * D * t2 % P, d = z1 * 2n * z2 % P;
    const e = (b - a + P) % P, f = (d - c + P) % P, gg = (d + c) % P, h = (b + a) % P;
    return [e * f % P, gg * h % P, f * gg % P, e * h % P];
  }
  function ptMulBase(n) {
    let r = [0n, 1n, 1n, 0n], q = [BX, BY, 1n, BX * BY % P];
    while (n > 0n) { if (n & 1n) r = ptAdd(r, q); q = ptAdd(q, q); n >>= 1n; }
    return r;
  }
  function ptCompress(p) {
    const zi = modInv(p[2], P), x = p[0] * zi % P, y = p[1] * zi % P;
    const o = bigToLe(y, 32);
    if (x & 1n) o[31] |= 0x80;
    return o;
  }
  // X25519の公開鍵 → 符号0のEd25519公開鍵
  function montToEd(u) {
    const n = leToBig(u) & ((1n << 255n) - 1n);
    return bigToLe((n - 1n + P) * modInv(n + 1n, P) % P, 32);
  }
  function hashToScalar(b) { return leToBig(nacl().hash(b)) % Q; }
  function xeddsaSign(sec, msg) {
    const c = sec.slice();
    c[0] &= 248; c[31] &= 127; c[31] |= 64;
    let a = leToBig(c);
    const A0 = ptCompress(ptMulBase(a));
    const neg = A0[31] & 0x80;
    a = a % Q;
    if (neg) a = (Q - a) % Q;
    const A = A0.slice(); A[31] &= 0x7f;
    const pad = u8(32).fill(0xff); pad[0] = 0xfe;
    const r = hashToScalar(concat(pad, bigToLe(a, 32), msg, nacl().randomBytes(64)));
    const R = ptCompress(ptMulBase(r));
    const h = hashToScalar(concat(R, A, msg));
    const S = (r + h * a) % Q;
    wipe(c);
    return concat(R, bigToLe(S, 32));
  }
  function xeddsaVerify(pub, msg, sig) {
    if (!sig || sig.length !== 64) return false;
    try { return nacl().sign.detached.verify(msg, sig, montToEd(pub)); } catch (e) { return false; }
  }
  const spkMessage = pub => concat(utf8('BroChat-SPK-v1'), pub);

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
      skipped: [], peer: bundle.ik, me: myIk.pub, createdAt: Date.now(), lastUsed: Date.now(), sid: b64e(ek.pub),
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
      skipped: [], peer: pre.ik, me: myIk.pub, createdAt: Date.now(), lastUsed: Date.now(), pending: null, sid: b64e(pre.ek),
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
  function skipKeys(state, until, now, maxSkip) {
    if (until - state.nr > maxSkip) throw new Error('too many skipped messages');
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
  function ratchetDecrypt(state, bytes, maxSkip) {
    const limit = maxSkip || MAX_SKIP;
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
      skipKeys(state, h.pn, now, limit);
      state.pn = state.ns; state.ns = 0; state.nr = 0;
      state.dhr = h.dh;
      const r1 = kdfRK(state.rk, dh(state.dhs.sec, state.dhr));
      state.ckr = r1.ck;
      const s = genDH();
      const r2 = kdfRK(r1.rk, dh(s.sec, state.dhr));
      wipe(state.dhs.sec);
      state.dhs = s; state.rk = r2.rk; state.cks = r2.ck;
    }
    skipKeys(state, h.n, now, limit);
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

    const nsOf = my => b64e(my.pub) + '|';   // 端末の鍵を作り直したら、古い鍵の状態は使わない
    const pruneList = (list, now) => list.filter((x, i) => i === 0 || now - (x.lastUsed || 0) <= DORMANT_MS);
    const stale = (x, now) => now - Math.max(x.lastRecv || 0, x.createdAt || 0) > (x.pending ? UNCONFIRMED_MS : SILENT_MS);

    function wrap(bytes, ctx) {
      return concat(utf8(JSON.stringify({ f: String(ctx.from), t: String(ctx.to) })), Uint8Array.of(0), bytes);
    }
    // 中身の {f,t} が、サーバーの言う送信者・宛先と合っている時だけ本文を返す
    function unwrap(out, ctx) {
      const z = out.indexOf(0);
      if (z < 1) return null;
      let m;
      try { m = JSON.parse(nacl().util.encodeUTF8(out.slice(0, z))); } catch (e) { return null; }
      if (!m || typeof m.f !== 'string' || typeof m.t !== 'string') return null;
      // 文脈なしでは開かない。送信者が分からない経路は members で「この2人の間の文」とだけ確かめる
      if (!ctx) return null;
      if (ctx.from != null && ctx.to != null) {
        if (String(ctx.from) !== m.f || String(ctx.to) !== m.t) return null;
      } else if (ctx.members) {
        const set = ctx.members.map(String);
        if (m.f === m.t || !set.includes(m.f) || !set.includes(m.t)) return null;
      } else return null;
      return { bytes: out.slice(z + 1), f: m.f, t: m.t };
    }

    // 相手の端末あての1通を作る。セッションの読み書きとラチェットを1つのトランザクションで
    async function encryptFor(peerPub, plain) {
      const my = me();
      const key = nsOf(my) + peerPub;
      const now = Date.now();
      let out = await tx(['sessions'], 'readwrite', async t => {
        const st = t.objectStore('sessions');
        const list = pruneList((await idbReq(st.get(key))) || [], now);
        if (!list.length || stale(list[0], now)) return null;
        const bytes = ratchetEncrypt(list[0], plain);
        st.put(list, key);
        return bytes;
      });
      if (out) return out;
      // セッションが無ければプリキーを取る(通信はトランザクションの外)
      const b = await opts.http('GET', '/api/ratchet/bundle/' + encodeURIComponent(peerPub));
      const peer = canonicalKey(peerPub);
      const spkPub = b && b.spk ? canonicalKey(b.spk.pub) : null;
      if (!b || !spkPub || !peer) {
        // 作り直せなければ、返事の無いセッションでもそのまま使う
        return tx(['sessions'], 'readwrite', async t => {
          const st = t.objectStore('sessions');
          const list = (await idbReq(st.get(key))) || [];
          if (!list.length) return null;
          const bytes = ratchetEncrypt(list[0], plain);
          st.put(list, key);
          return bytes;
        });
      }
      if (b.deviceKey !== peerPub) throw new Error('bundle mismatch');
      let sig = null;
      try { sig = b64d(b.spk.sig || ''); } catch (e) { sig = null; }
      if (!xeddsaVerify(peer, spkMessage(spkPub), sig)) {
        const e = new Error('相手の端末の暗号鍵を確かめられないため送りませんでした');
        e.code = 'RATCHET_BAD_SPK';
        throw e;
      }
      const otkPub = b.otk ? canonicalKey(b.otk.pub) : null;
      const init = x3dhInitiate(my, {
        ik: peer,
        spk: { id: b.spk.id, pub: spkPub },
        otk: otkPub ? { id: b.otk.id, pub: otkPub } : null,
      });
      await tx(['sessions', 'meta'], 'readwrite', async t => {
        const st = t.objectStore('sessions');
        const list = pruneList((await idbReq(st.get(key))) || [], now);
        list.unshift(init);
        list.splice(MAX_SESSIONS_PER_PEER);
        out = ratchetEncrypt(init, plain);
        st.put(list, key);
        t.objectStore('meta').put(Date.now(), 'peer:' + peerPub);   // この端末は対応済み。以後 box に戻さない
      });
      return out;
    }

    // この相手とは前方秘匿性ありで話したことがあるか。あれば旧方式には戻さない(サーバーの設定やプリキーの細工でも)
    async function pinnedAt(peerUserId) {
      return (await tx(['meta'], 'readonly', t => idbReq(t.objectStore('meta').get('user:' + peerUserId)))) || 0;
    }
    async function isPinned(peerUserId) { return !!(await pinnedAt(peerUserId)); }
    // メッセージIDと暗号文を結びつける。閉じている間に取り消された分も、次に開いた時に消せるように
    async function bindMessage(msgId, content, expiresAt) {
      const k = cacheKey(content);
      const exp = expiresAt ? (Date.parse(expiresAt) || Number(expiresAt) || 0) : 0;
      return tx(['plain', 'meta'], 'readwrite', async t => {
        const m = t.objectStore('meta');
        // 同じ暗号文が別のメッセージとして来たら、再送(リプレイ)。持ち主は最初の1通だけ
        const owner = await idbReq(m.get('owner:' + k));
        if (owner && owner !== msgId) return false;
        if (!owner) m.put(msgId, 'owner:' + k);
        m.put(k, 'msg:' + msgId);
        if (exp) {
          const st = t.objectStore('plain');
          const v = await idbReq(st.get(k));
          if (v && v.exp !== exp) { v.exp = exp; st.put(v, k); }
        }
        return true;
      });
    }
    async function forgetMessage(msgId) {
      await tx(['plain', 'meta'], 'readwrite', async t => {
        const m = t.objectStore('meta');
        const k = await idbReq(m.get('msg:' + msgId));
        if (!k) return;
        m.delete('msg:' + msgId);
        // サーバーが同じ暗号文で別の行を作って消しても、最初の1通の本文は消えない
        if ((await idbReq(m.get('owner:' + k))) === msgId) { t.objectStore('plain').delete(k); m.delete('owner:' + k); }
      });
    }

    // bytes を recipients(公開鍵Base64の配列)全員あてに。ctx = { from, to } 自分と相手のユーザーID
    async function seal(bytes, peers, ctx) {
      // peers = 相手の端末、ctx.mine = 自分の他の端末。前方秘匿性の判定は相手の端末だけで行う
      if (!ctx || ctx.from == null || ctx.to == null) throw new Error('seal: ctx required');
      const my = me();
      const myB64 = b64e(my.pub);
      const seen = new Set([myB64]);
      const entries = [];
      const inner = wrap(bytes, ctx);
      const pinned = await isPinned(ctx.to);
      let ratcheted = false, peerEntries = 0;
      const peerSet = new Set(peers);
      for (const pb of [...peers, ...(ctx.mine || [])]) {
        if (!pb || seen.has(pb)) continue;
        const isPeer = peerSet.has(pb);
        const pk = canonicalKey(pb);
        if (!pk) continue;                                 // 別表記の鍵は受け取らない
        if (entries.length >= MAX_RECIPIENTS) throw new Error('送り先の端末が多すぎます');
        seen.add(pb);
        const ct = await encryptFor(pb, inner);
        if (ct) { entries.push(pb + '.r' + b64e(ct)); if (isPeer) { ratcheted = true; peerEntries += 1; } continue; }
        const devicePinned = await tx(['meta'], 'readonly', t => idbReq(t.objectStore('meta').get('peer:' + pb)));
        // 前方秘匿性ありで話した相手に旧方式で送ると、サーバーがプリキーを隠すだけで弱められる。この端末の分は入れない
        if (pinned || devicePinned) continue;
        const nonce = nacl().randomBytes(24);
        entries.push(pb + '.b' + b64e(concat(nonce, nacl().box(inner, nonce, pk, my.sec))));
        if (isPeer) peerEntries += 1;
      }
      // 相手に届く分が1つも無いのに「送信成功」にしない(サーバーが鍵一覧を隠した時など)
      if (!peerEntries) {
        const e = new Error('相手の端末の暗号鍵を確かめられないため送りませんでした');
        e.code = 'RATCHET_DOWNGRADE';
        throw e;
      }
      const content = PREFIX + myB64 + ':' + entries.join(',');
      const k = cacheKey(content);
      await tx(['plain', 'meta'], 'readwrite', async t => {
        t.objectStore('plain').put({ b: inner, at: Date.now() }, k);   // 自分の分は暗号文に入れない。本文は端末の中だけに残す
        if (ratcheted) t.objectStore('meta').put(Date.now(), 'user:' + ctx.to);
      });
      return content;
    }

    async function recall(content, ctx) {
      const k = cacheKey(content);
      const v = await tx(['plain'], 'readonly', t => idbReq(t.objectStore('plain').get(k)));
      if (!v) return null;
      const u = unwrap(v.b, ctx);
      return u ? u.bytes : null;
    }
    // 取り消し・消えるメッセージ・編集前の文は、端末の中からも消す
    async function forget(content) {
      if (!content) return;
      const k = cacheKey(content);
      await tx(['plain'], 'readwrite', async t => { t.objectStore('plain').delete(k); });
    }
    async function sweepExpired() {
      const now = Date.now();
      await tx(['plain'], 'readwrite', async t => {
        const st = t.objectStore('plain');
        const keys = await idbReq(st.getAllKeys());
        const vals = await idbReq(st.getAll());
        keys.forEach((k, i) => { if (vals[i] && vals[i].exp && vals[i].exp <= now) st.delete(k); });
      });
    }

    const FAILED_RETRY_MS = 5 * 60 * 1000;
    const failed = new Map();  // 開けなかった暗号文。同期のたびに重い計算をやり直さない
    function markFailed(k) { if (failed.size > 500) failed.clear(); failed.set(k, Date.now()); }
    const keyCache = new Map();
    async function peerKeysCached(userId, want) {
      const c = keyCache.get(userId);
      // 無い鍵は聞き直す(たった今増えた端末かもしれない)。覚えているのは一覧にあった時の通信を減らすためだけ
      if (c && Date.now() - c.at < 60000 && c.list.includes(want)) return c.list;
      const list = await opts.peerKeys(userId);
      if (keyCache.size > 200) keyCache.clear();
      keyCache.set(userId, { at: Date.now(), list });
      return list;
    }

    // 戻り値: 本文のバイト列 / 開けなければ null。同じ暗号文は何度呼んでも同じ結果(2回目からは保存分)
    // ctx = { from, to } サーバーの言う送信者と宛先。メディアの鍵など送信者が分からない時は { members: [自分, 相手] }
    async function open(content, ctx) {
      const p = parse(content);
      if (!p || !canonicalKey(p.senderPub)) return null;
      const k = cacheKey(content);
      const hit = await recall(content, ctx);
      if (hit) return hit;
      if (Date.now() - (failed.get(k) || 0) < FAILED_RETRY_MS) return null;
      if (!ctx) return null;
      const my = me();
      const myB64 = b64e(my.pub);
      if (p.senderPub === myB64) return null;   // 自分の鍵を相手の発言に見せかけたもの(自分の分は保存から読む)
      const entry = p.entries.get(myB64);
      if (!entry) return null;
      const kind = entry[0];
      let body;
      try { body = b64d(entry.slice(1)); } catch (e) { return null; }
      if (kind === 'b') {
        const peerUser = ctx && (ctx.from != null ? (String(ctx.from) === String(opts.uid) ? ctx.to : ctx.from) : null);
        const pinAt = await tx(['meta'], 'readonly', async t => {
          const a = await idbReq(t.objectStore('meta').get('peer:' + p.senderPub));
          const b2 = peerUser != null ? await idbReq(t.objectStore('meta').get('user:' + peerUser)) : 0;
          return Math.max(Number(a) || 0, Number(b2) || 0);
        });
        // 前方秘匿性ありで話した相手からの旧方式は受けない。ただし話し始める前に送られた、まだ読んでいない文は読む
        if (pinAt && !(ctx.sentAt && Date.parse(ctx.sentAt) < pinAt)) return null;
        if (body.length < 24 + 16) return null;
        let out = null;
        try { out = nacl().box.open(body.slice(24), body.slice(0, 24), b64d(p.senderPub), my.sec); } catch (e) { out = null; }
        const u = out && unwrap(out, ctx);
        if (!u) { markFailed(k); return null; }
        await tx(['plain'], 'readwrite', async t => { t.objectStore('plain').put({ b: out, at: Date.now() }, k); });
        return u.bytes;
      }
      if (kind !== 'r') return null;
      const sKey = nsOf(my) + p.senderPub;
      const peerUserOf = ctx && ctx.from != null ? (String(ctx.from) === String(opts.uid) ? ctx.to : ctx.from) : null;
      const finish = (t, out) => {
        const u = unwrap(out, ctx);
        if (!u) return null;
        t.objectStore('plain').put({ b: out, at: Date.now() }, k);
        if (peerUserOf != null) t.objectStore('meta').put(Date.now(), 'user:' + peerUserOf);
        return u.bytes;
      };
      // 今あるセッションで開く。戻り値 { out } か、新しいセッションが要る時は { needNew: true }
      const tryExisting = async t => {
        const sessions = t.objectStore('sessions');
        // 別のページや Service Worker が先に開いていたら、もう鍵は無い。保存された本文を返す
        const done = await idbReq(t.objectStore('plain').get(k));
        if (done) { const u = unwrap(done.b, ctx); return { out: u ? u.bytes : null }; }
        const now = Date.now();
        const list = pruneList((await idbReq(sessions.get(sKey))) || [], now);
        for (let i = 0; i < list.length; i++) {
          const trial = cloneState(list[i]);
          let out = null;
          try { out = ratchetDecrypt(trial, body, i === 0 ? MAX_SKIP : MAX_SKIP_DORMANT); } catch (e) { out = null; }
          if (!out) continue;
          const bytes = finish(t, out);
          if (!bytes) return { out: null };  // 中身の送信者が合わない。状態は進めない
          list[i] = trial;
          trial.lastRecv = now;
          // 送る時に使うセッションは、受信しただけでは切り替えない(盗まれた古い状態で乗っ取られないように)。
          // 両者が同時に始めた時だけ、両端で同じ方(番号の大きい方)へ揃える
          const sim = Math.abs((trial.createdAt || 0) - (list[0].createdAt || 0)) < SIM_START_MS;
          if (i > 0 && sim && String(trial.sid) > String(list[0].sid)) { list.splice(i, 1); list.unshift(trial); }
          sessions.put(list, sKey);
          return { out: bytes };
        }
        return { needNew: true };
      };
      const first = await tx(['sessions', 'plain', 'meta'], 'readwrite', tryExisting);
      if (!first.needNew) return first.out;
      // 2. 相手が始めた新しいセッションの最初の1通か確かめる
      let h;
      try { h = decHeader(body); } catch (e) { markFailed(k); return null; }
      if (!h.pre || b64e(h.pre.ik) !== p.senderPub) { markFailed(k); return null; }
      // 送信者として名乗るユーザーの今の端末にある鍵だけ受ける(知らない鍵でセッションを増やされないように)。通信はトランザクションの外
      const senderUser = ctx && ctx.from != null ? ctx.from : null;
      let okKeys = null;
      if (opts.peerKeys && senderUser != null) { try { okKeys = await peerKeysCached(senderUser, p.senderPub); } catch (e) { okKeys = null; } }
      if (!Array.isArray(okKeys)) return null;   // 通信できない時や Service Worker では判断しない。ページで開いた時にもう一度
      if (!okKeys.includes(p.senderPub)) { markFailed(k); return null; }
      const created = await tx(['sessions', 'plain', 'prekeys', 'meta'], 'readwrite', async t => {
        // 鍵の確認を待つ間に、同じセッションの前の1通が開かれているかもしれない
        const again = await tryExisting(t);
        if (!again.needNew) return again.out;
        const ns = nsOf(my), metaS = t.objectStore('meta'), pks = t.objectStore('prekeys');
        const ekB64 = b64e(h.pre.ek);
        if (await idbReq(metaS.get('ek:' + ns + ekB64))) return null;   // 同じ最初の1通の再送は受けない
        const spk = await idbReq(pks.get(ns + 'spk:' + h.pre.spkId));
        if (!spk) return null;
        let otk = null;
        if (h.pre.otkId) {
          otk = await idbReq(pks.get(ns + 'otk:' + h.pre.otkId));
          if (!otk) return null;     // 使用済みのOTK = 再送か、もう開けないもの
        }
        let state, out = null;
        try {
          state = x3dhRespond(my, spk, otk, h.pre);
          out = ratchetDecrypt(state, body);
        } catch (e) { return null; }
        if (!out) return null;
        const bytes = finish(t, out);
        if (!bytes) return null;
        if (h.pre.otkId) pks.delete(ns + 'otk:' + h.pre.otkId);   // 前方秘匿性のために使ったら消す
        metaS.put(Date.now(), 'ek:' + ns + ekB64);
        metaS.put(Date.now(), 'peer:' + p.senderPub);
        const sessions = t.objectStore('sessions');
        const nowT = Date.now();
        const list = pruneList((await idbReq(sessions.get(sKey))) || [], nowT);
        state.lastRecv = nowT;
        // 同時に始めた時は、両端で同じ方を送信に使う(分岐したままにしない)
        const head = list[0];
        if (head && head.pending && Math.abs((head.createdAt || 0) - nowT) < SIM_START_MS && String(head.sid) > String(state.sid)) list.splice(1, 0, state);
        else list.unshift(state);
        list.splice(MAX_SESSIONS_PER_PEER);
        sessions.put(list, sKey);
        return bytes;
      });
      if (!created) markFailed(k);
      return created;
    }

    // プリキーを用意してサーバーへ。古いSPKは回転し、OTKは減ったら足す
    async function ensurePrekeysLocked() {
      const my = me();
      const myB64 = b64e(my.pub), ns = nsOf(my);
      const now = Date.now();
      const cnt = await opts.http('GET', '/api/ratchet/prekeys/count?deviceKey=' + encodeURIComponent(myB64));
      const remote = cnt && typeof cnt.otks === 'number' ? cnt.otks : 0;
      let spkId = 0, spkPub = null, spkSig = null, replace = false, needed = false;
      const otksOut = [];
      await tx(['prekeys', 'meta'], 'readwrite', async t => {
        const pks = t.objectStore('prekeys'), metaS = t.objectStore('meta');
        // 読むのもここで(同時に動く別のタブと番号がぶつからないように)
        const curId = await idbReq(metaS.get(ns + 'spkId'));
        const curAt = await idbReq(metaS.get(ns + 'spkAt'));
        let otkNext = await idbReq(metaS.get(ns + 'otkNext'));
        // 端末の中の状態が無いのにサーバーに古いOTKが残っていると、その秘密鍵はもう無い。全部置き換える。
        // 送信に失敗してもやり直せるよう、完了するまで印を残す
        replace = !otkNext || !!(await idbReq(metaS.get(ns + 'needReplace')));
        if (replace) metaS.put(true, ns + 'needReplace');
        const needSpk = !curId || !curAt || now - curAt > SPK_ROTATE_MS || !(cnt && cnt.spkId === curId);
        const needOtk = replace || remote < OTK_LOW;
        if (!needSpk && !needOtk) return;
        needed = true;
        spkId = curId || 0;
        if (needSpk) {
          const k = genDH();
          spkId = (spkId % 0x7ffffffe) + 1;
          pks.put({ pub: k.pub, sec: k.sec, at: now }, ns + 'spk:' + spkId);
          metaS.put(spkId, ns + 'spkId'); metaS.put(now, ns + 'spkAt');
          spkPub = k.pub;
        } else {
          const cur = await idbReq(pks.get(ns + 'spk:' + spkId));
          spkPub = cur ? cur.pub : null;
        }
        // 回転して時間が経ったSPKの秘密鍵は消す。OTKも増えすぎたら古いものから消す
        const keys = await idbReq(pks.getAllKeys());
        const otkKeys = [];
        for (const key of keys) {
          const ks = String(key);
          if (!ks.startsWith(ns)) continue;
          if (ks.startsWith(ns + 'otk:')) { otkKeys.push(ks); continue; }
          if (ks === ns + 'spk:' + spkId) continue;
          const v = await idbReq(pks.get(key));
          if (v && now - v.at > SPK_KEEP_MS) pks.delete(key);
        }
        otkNext = otkNext || 1;
        if (needOtk) {
          const start = replace ? 0 : remote;
          for (let i = start; i < OTK_TARGET; i++) {
            const k = genDH(), id = otkNext++;
            pks.put({ pub: k.pub, sec: k.sec, at: now }, ns + 'otk:' + id);
            otksOut.push({ id, pub: b64e(k.pub) });
          }
          metaS.put(otkNext, ns + 'otkNext');
          const over = otkKeys.length + otksOut.length - OTK_LOCAL_MAX;
          if (over > 0) otkKeys.sort((a, b) => Number(a.split('otk:')[1]) - Number(b.split('otk:')[1])).slice(0, over).forEach(x => pks.delete(x));
        }
      });
      if (!needed || !spkPub) return false;
      spkSig = xeddsaSign(my.sec, spkMessage(spkPub));
      // この鍵を本当に持っていることを見せる(他人の端末鍵にプリキーを置かれないように)
      const c = await opts.http('POST', '/api/devices/challenge', { publicKey: myB64 });
      if (!c || !c.id) return false;
      const answer = nacl().box.open(b64d(c.box), b64d(c.nonce), b64d(c.serverPublicKey), my.sec);
      if (!answer) return false;
      await opts.http('POST', '/api/ratchet/prekeys', {
        deviceKey: myB64, spk: { id: spkId, pub: b64e(spkPub), sig: b64e(spkSig) }, otks: otksOut, replace,
        challengeId: c.id, answer: b64e(answer),
      });
      if (replace) await tx(['meta'], 'readwrite', async t => { t.objectStore('meta').delete(ns + 'needReplace'); });
      return true;
    }
    function ensurePrekeys() {
      const locks = typeof navigator !== 'undefined' && navigator.locks;
      return locks ? locks.request('bc_e5_prekeys_' + opts.uid, ensurePrekeysLocked) : ensurePrekeysLocked();
    }

    // 端末の中の本文を全部取り出す / 取り込む(履歴の書き出し用)。鍵やセッションは含めない。
    // セッションを別の端末に複製すると同じ鍵を2台で使うことになるので、絶対に移さない
    async function exportPlain() {
      return tx(['plain'], 'readonly', async t => {
        const st = t.objectStore('plain');
        const keys = await idbReq(st.getAllKeys());
        const vals = await idbReq(st.getAll());
        return keys.map((k, i) => ({ k, b: vals[i].b, at: vals[i].at }));
      });
    }
    async function importPlain(items) {
      let added = 0;
      await tx(['plain'], 'readwrite', async t => {
        const st = t.objectStore('plain');
        for (const it of items) {
          if (!it || typeof it.k !== 'string' || !(it.b instanceof Uint8Array)) continue;
          if (await idbReq(st.get(it.k))) continue;
          st.put({ b: it.b, at: Number(it.at) || Date.now() }, it.k);
          added += 1;
        }
      });
      return added;
    }

    return { seal, open, recall, forget, bindMessage, forgetMessage, sweepExpired, isPinned, pinnedAt, ensurePrekeys, exportPlain, importPlain };
  }

  g.E2ERatchet = {
    PREFIX, isRatchet, parse, cacheKey, makeClient,
    core: { x3dhInitiate, x3dhRespond, ratchetEncrypt, ratchetDecrypt, cloneState, genDH, hmac, hkdf, dh, encHeader, decHeader, MAX_SKIP, xeddsaSign, xeddsaVerify, canonicalKey },
  };
})(typeof self !== 'undefined' ? self : globalThis);
