// js/callAuth.js
// 通話の鍵(DTLSの指紋)を、端末の暗号鍵で相手に認証して渡す。
//
// 通話の音声・映像は WebRTC の DTLS-SRTP で暗号化されているが、その鍵が本物かどうかは
// SDP の a=fingerprint 行だけで決まる。SDP はサーバーが中継するので、サーバーがその気になれば
// 両側に自分の指紋を書いた SDP を渡して、間に入れた(中間者)。確認コード(4桁)は人が声で
// 読み合わせない限り役に立たない。
//
// そこで、通話を始める側も応答する側も、自分の SDP に書いた指紋を
//   { 通話ID, 自分のID, 相手のID, 向き(offer/answer), 指紋の一覧, (応答の時は)受け取った offer の指紋 }
// にまとめて、メッセージと同じ e3(E2EMulti.seal: 自分の端末の秘密鍵 × 相手の各端末の公開鍵)で封をして
// SDP と一緒に送る(fpSeal)。サーバーには開けないし、作り直すこともできない。
// 受け取った側は
//   1. 自分の端末の鍵で開ける(開けなければ受け付けない)
//   2. 封をした端末の鍵が、相手の承認済み端末の鍵(サーバーの一覧。安全番号で確認済みなら確認した鍵)にある
//   3. 中の通話ID・送り主・宛先・向きが今の通話と同じ(別の通話の封の使い回しを受け付けない)
//   4. 届いた SDP の a=fingerprint が全部、封の中の指紋に含まれる
//   5. 応答の封なら、相手が「受け取った」と言っている offer の指紋が自分の指紋と同じ
//      (前の通話の応答の封を持ってきても、接続ごとに証明書が違うので通らない)
// を確かめてから setRemoteDescription する。どれかが駄目なら通話を切る。
//
// ラチェット(e5)ではなく e3 にしたのは、通話のたびにラチェットの状態を進めると、
// 片方だけ進んだ時にメッセージ側まで壊れるため。e3 でも送り主の認証と秘匿はある。
//
// 古いアプリ(fpSeal を送ってこない相手)との互換:
//   - 一度も fpSeal を受け取ったことの無い相手 → 通話は続ける(繋がらないと困るので)。
//     代わりに確認コードを必ず出して「自動で確認できていません」と表示する
//   - 一度でも正しい fpSeal を受け取った相手(この端末に記録) → 今回無ければ、サーバーが封を
//     抜き取った(ダウングレード)とみなして切る
// window(ページ)と Node(テスト)の両方で読めるようにしてある。nacl / nacl.util / E2EMulti が先に必要。
(function (g) {
  'use strict';
  const VERSION = 1;
  const TAG = 'bc-call-fp';
  const STORE = 'bc_callauth_v1';      // { "<自分>|<相手>": 初めて正しい封を受け取った時刻 }
  // 相手の端末はサーバー側で最大6台。封が大きくなりすぎないよう16台で切る(サーバーも16件までしか通さない)
  const MAX_RECIPIENTS = 16;
  const MAX_FP = 4;
  // サーバーが中継する上限(ws/wsServer.js の FP_SEAL_MAX)と同じ。超えるなら封をしない
  const MAX_SEAL_LEN = 20000;
  // これ以外の(弱い)ハッシュの指紋しか無い SDP は受け付けない
  const STRONG = ['sha-256', 'sha-384', 'sha-512'];
  // 指紋の行。ハッシュ名は大文字小文字を区別せず、16進は 20〜64バイト(sha-1〜sha-512)
  const FP_LINE = /^a=fingerprint:([A-Za-z0-9-]{1,16})[ \t]+([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){15,63})$/;
  // ブラウザが指紋として読むかもしれない行は、形が崩れていても見逃さない(崩れていたら SDP ごと受け付けない)
  const FP_LOOSE = /^\s*a\s*=\s*fingerprint/i;
  const FP_ITEM = /^[a-z0-9-]{1,16} [0-9A-F]{2}(?::[0-9A-F]{2}){15,63}$/;
  const CALL_ID = /^[A-Za-z0-9_.:-]{1,140}$/;

  function sdpText(x) {
    if (typeof x === 'string') return x;
    if (x && typeof x.sdp === 'string') return x.sdp;
    return '';
  }

  // SDP の a=fingerprint 行を全部取り出す(セッション全体の行も、m= ごとの行も)。
  // 戻り値: { list: ['sha-256 AB:CD:...', ...](重複なし・並べ替え済み), bad: 崩れた指紋行があったか }
  function extractFingerprints(sdp) {
    const out = new Set();
    let bad = false;
    for (const raw of sdpText(sdp).split('\n')) {
      const line = raw.replace(/[\r \t]+$/, '');
      if (!FP_LOOSE.test(line)) continue;
      const m = FP_LINE.exec(line);
      if (!m) { bad = true; continue; }
      out.add(m[1].toLowerCase() + ' ' + m[2].toUpperCase());
    }
    return { list: Array.from(out).sort(), bad };
  }

  // 届いた SDP の指紋が、認証済みの指紋の一覧に全部含まれるか。
  // 「1つでも合えば良い」にすると、本物の指紋と偽の指紋を並べて書かれた時に、ブラウザが偽の方で
  // DTLS を通してしまうおそれがあるので、知らない指紋が1つでも混ざっていたら受け付けない
  function checkSdp(sdp, authed) {
    const ex = extractFingerprints(sdp);
    if (ex.bad) return { ok: false, reason: 'malformed' };
    if (!ex.list.length) return { ok: false, reason: 'no_fingerprint' };
    const set = new Set(Array.isArray(authed) ? authed : []);
    if (!set.size) return { ok: false, reason: 'mismatch' };
    for (const f of ex.list) if (!set.has(f)) return { ok: false, reason: 'mismatch' };
    if (!ex.list.some(f => STRONG.includes(f.split(' ')[0]))) return { ok: false, reason: 'weak' };
    return { ok: true, fp: ex.list };
  }

  const uniq = list => Array.from(new Set((list || []).filter(k => typeof k === 'string' && k)));
  const sameSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));

  // 自分の SDP の指紋を封をする。
  // o: { sdp, callId, me, peer, dir:'offer'|'answer', secretKey:Uint8Array, publicKeyB64, recipientKeys:[相手の端末の公開鍵Base64],
  //      remoteSdp?(応答の時: 受け取った offer), now? }
  // 戻り値: e3 の文字列 / 封ができなければ null(呼ぶ側は封無しで送る。相手が古いアプリと同じ扱いにする)
  function seal(o) {
    const E = g.E2EMulti, nacl = g.nacl;
    if (!E || !nacl || !o) return null;
    if (o.dir !== 'offer' && o.dir !== 'answer') return null;
    if (typeof o.callId !== 'string' || !CALL_ID.test(o.callId)) return null;
    const fp = extractFingerprints(o.sdp);
    if (fp.bad || !fp.list.length || fp.list.length > MAX_FP) return null;
    const keys = uniq(o.recipientKeys).slice(0, MAX_RECIPIENTS);
    if (!keys.length) return null;
    const msg = { t: TAG, v: VERSION, callId: o.callId, from: String(o.me), to: String(o.peer), dir: o.dir, fp: fp.list, ts: o.now || Date.now() };
    if (o.dir === 'answer') {
      const r = extractFingerprints(o.remoteSdp);
      if (r.bad || !r.list.length || r.list.length > MAX_FP) return null;
      msg.rfp = r.list;
    }
    try {
      const out = E.seal(nacl.util.decodeUTF8(JSON.stringify(msg)), o.secretKey, o.publicKeyB64, keys);
      return out && out.length <= MAX_SEAL_LEN ? out : null;
    } catch (e) { return null; }
  }

  // 受け取った封を開けて中身を確かめる。
  // o: { ring:[{pk,sk}], callId, me, peer, dir, peerKeys:[相手の承認済み端末の公開鍵], checkSender?: pub => {ok, added},
  //      localSdp?(応答の封を開ける時: 自分が送った offer) }
  // 戻り値: { ok:true, fp, senderPub, newKey } / { ok:false, reason }
  function open(fpSeal, o) {
    const E = g.E2EMulti, nacl = g.nacl;
    if (!E || !nacl) return { ok: false, reason: 'unsupported' };
    if (typeof fpSeal !== 'string' || !E.isMulti(fpSeal)) return { ok: false, reason: 'malformed' };
    const p = E.parse(fpSeal);
    if (!p || !p.senderPub) return { ok: false, reason: 'malformed' };
    const ring = Array.isArray(o.ring) ? o.ring : [];
    // 自分の端末で封をしたもの(自分の封をサーバーが相手の封として跳ね返してきた)は受け付けない。
    // E2EMulti.open は自分が送った分も開けるので、先に弾く
    if (ring.some(k => k.pk === p.senderPub)) return { ok: false, reason: 'unknown_device' };
    const bytes = E.open(fpSeal, ring);
    if (!bytes) return { ok: false, reason: 'cannot_open' };
    let m;
    try { m = JSON.parse(nacl.util.encodeUTF8(bytes)); } catch (e) { return { ok: false, reason: 'malformed' }; }
    if (!m || m.t !== TAG || m.v !== VERSION || !Array.isArray(m.fp)) return { ok: false, reason: 'malformed' };
    if (m.callId !== o.callId) return { ok: false, reason: 'wrong_call' };
    if (m.from !== String(o.peer) || m.to !== String(o.me)) return { ok: false, reason: 'wrong_call' };
    if (m.dir !== o.dir) return { ok: false, reason: 'wrong_call' };
    const fpOk = l => Array.isArray(l) && l.length > 0 && l.length <= MAX_FP && l.every(f => typeof f === 'string' && FP_ITEM.test(f));
    if (!fpOk(m.fp)) return { ok: false, reason: 'malformed' };
    if (m.dir === 'answer') {
      // 相手が応答した offer が、自分が今回送った offer か(別の接続への応答の封の使い回しを受け付けない)
      if (!fpOk(m.rfp)) return { ok: false, reason: 'malformed' };
      const mine = extractFingerprints(o.localSdp);
      if (mine.bad || !mine.list.length || !sameSet(mine.list, uniq(m.rfp).sort())) return { ok: false, reason: 'wrong_call' };
    }
    // 封をした端末が、相手の承認済みの端末か(サーバーが自分で作った鍵で封をして相手になりすますのを防ぐ)
    if (!uniq(o.peerKeys).includes(p.senderPub)) return { ok: false, reason: 'unknown_device' };
    let newKey = false;
    if (typeof o.checkSender === 'function') {
      let r;
      try { r = o.checkSender(p.senderPub); } catch (e) { r = { ok: true }; }
      // 安全番号で確認済みの相手なのに、確認していない端末からの封
      if (r && r.ok === false) return { ok: false, reason: 'unverified_device' };
      newKey = !!(r && r.added);
    }
    return { ok: true, fp: uniq(m.fp).sort(), senderPub: p.senderPub, newKey };
  }

  // ---- 「この相手は封を送ってくる」記録(ダウングレード検出用) ----
  function memStore() { const m = new Map(); return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v); } }; }
  let lsFallback = null;
  function defaultStore() {
    // localStorage が使えない(プライベートモード等)時は、ページを開いている間だけ覚える
    try { if (g.localStorage) { g.localStorage.getItem(STORE); return { get: k => g.localStorage.getItem(k), set: (k, v) => g.localStorage.setItem(k, v) }; } } catch (e) {}
    return lsFallback || (lsFallback = memStore());
  }
  function loadCap(store) { try { return JSON.parse(store.get(STORE) || '{}') || {}; } catch (e) { return {}; } }
  function isCapable(store, me, peer) { return !!loadCap(store || defaultStore())[String(me) + '|' + String(peer)]; }
  function markCapable(store, me, peer) {
    const st = store || defaultStore();
    const o = loadCap(st);
    const k = String(me) + '|' + String(peer);
    if (o[k]) return;
    o[k] = Date.now();
    // 増えすぎないように古いものから捨てる
    const keys = Object.keys(o);
    if (keys.length > 500) keys.sort((a, b) => o[a] - o[b]).slice(0, keys.length - 500).forEach(x => { delete o[x]; });
    try { st.set(STORE, JSON.stringify(o)); } catch (e) {}
  }

  // 通話1本(グループ通話では相手1人との接続1本)ぶんの確認。
  // o: { callId, me, peer, ring: () => [{pk,sk}], peerKeys: async () => [Base64], checkSender?: pub => {ok,added}, store? }
  // verifyRemote(sdp, fpSeal, dir, localSdp) は setRemoteDescription の前に毎回呼ぶ(最初の SDP も、ICE restart や
  // カメラ切替などでの作り直しの SDP も)。localSdp は応答(answer)を確かめる時の、自分が送った offer。
  // 戻り値: { ok:true, state:'verified'|'legacy', newKey } / { ok:false, reason }
  function createSession(o) {
    const store = o.store || defaultStore();
    const s = { pinned: null, state: null, newKey: false, reason: null };
    s.verifyRemote = async function (sdp, fpSeal, dir, localSdp) {
      const fail = reason => { s.reason = reason; return { ok: false, reason }; };
      const hasSeal = fpSeal !== undefined && fpSeal !== null && fpSeal !== '';
      if (hasSeal) {
        let peerKeys = [];
        try { peerKeys = await o.peerKeys(); } catch (e) { peerKeys = []; }
        const r = open(fpSeal, {
          ring: typeof o.ring === 'function' ? o.ring() : o.ring,
          callId: o.callId, me: o.me, peer: o.peer, dir, peerKeys, checkSender: o.checkSender, localSdp,
        });
        if (!r.ok) return fail(r.reason);
        // 同じ接続の途中で指紋が変わることは無い(証明書は接続ごとに1つ)。変わったら受け付けない
        if (s.pinned && !sameSet(s.pinned, r.fp)) return fail('fp_changed');
        const c = checkSdp(sdp, r.fp);
        if (!c.ok) return fail(c.reason);
        s.pinned = r.fp;
        s.state = 'verified';
        s.newKey = s.newKey || r.newKey;
        markCapable(store, o.me, o.peer);
        return { ok: true, state: 'verified', newKey: s.newKey };
      }
      // 封が無い: 前に確かめた指紋があれば、それと同じかだけ見る(作り直しの SDP)
      if (s.pinned) {
        const c = checkSdp(sdp, s.pinned);
        if (!c.ok) return fail(c.reason);
        return { ok: true, state: s.state || 'verified', newKey: s.newKey };
      }
      // 以前は封を送ってきた相手なのに今回は無い = サーバーが抜き取った
      if (isCapable(store, o.me, o.peer)) return fail('downgrade');
      // 古いアプリの相手。通話は続けるが、確認できていないことをはっきり出す。
      // せめて通話の途中で指紋を差し替えられないよう、最初に見た指紋を覚えておく
      const first = extractFingerprints(sdp);
      if (!first.bad && first.list.length) s.pinned = first.list;
      s.state = 'legacy';
      return { ok: true, state: 'legacy', newKey: false };
    };
    return s;
  }

  // 切った理由を画面の文言キーにする(i18n.js)
  function reasonKey(reason) {
    switch (reason) {
      case 'mismatch': case 'fp_changed': case 'malformed': case 'no_fingerprint': case 'weak': return 'call_auth_r_mismatch';
      case 'downgrade': return 'call_auth_r_downgrade';
      case 'unknown_device': case 'unverified_device': return 'call_auth_r_device';
      default: return 'call_auth_r_open';
    }
  }

  // ページ(window)用: この端末の鍵の全世代を E2EMulti.open に渡す形で(e2eKeys.js と同じ保存場所)
  function localRing(myUserId) {
    const out = [];
    const nacl = g.nacl;
    if (!nacl) return out;
    const push = k => { try { out.push({ pk: nacl.util.encodeBase64(new Uint8Array(k.publicKey)), sk: new Uint8Array(k.secretKey) }); } catch (e) {} };
    try { const kp = JSON.parse(g.localStorage.getItem('e2e_keypair_' + myUserId) || 'null'); if (kp) push(kp); } catch (e) {}
    try { JSON.parse(g.localStorage.getItem('e2e_keyring_' + myUserId) || '[]').forEach(push); } catch (e) {}
    const seen = new Set();
    return out.filter(k => !seen.has(k.pk) && seen.add(k.pk));
  }

  // この端末の今の鍵(封をするのに使う)。無ければ null
  function myKey(myUserId) { return localRing(myUserId)[0] || null; }

  // 通話の相手を確かめる時に使う、相手の端末の鍵。サーバーの今の一覧を使い、取れなければ
  // 安全番号で覚えている鍵(サーバーを信じない分、こちらの方が厳しい)に落とす
  async function fetchPeerKeys(peerId, token, myUserId) {
    try {
      const res = await fetch('/api/friends/publickey/' + encodeURIComponent(peerId), { headers: { Authorization: 'Bearer ' + token } });
      if (res.ok) {
        const d = await res.json();
        const list = Array.isArray(d.publicKeys) && d.publicKeys.length ? d.publicKeys : (d.publicKey ? [d.publicKey] : []);
        const ok = list.filter(k => { try { return g.nacl.util.decodeBase64(k).length === 32; } catch (e) { return false; } });
        if (ok.length) return ok;
      }
    } catch (e) {}
    // サーバーに聞けない時は、安全番号の記録(safetyNumber.js の bc_sn_v1)にある鍵だけを使う。
    // 確認済みなら確認した鍵、そうでなければ今までに見た鍵
    try {
      const st = (JSON.parse(g.localStorage.getItem('bc_sn_v1') || '{}') || {})[String(myUserId) + '|' + String(peerId)];
      if (st) return uniq(Array.isArray(st.verified) ? st.verified : st.known);
    } catch (e) {}
    return [];
  }

  // 確認コード(4桁)。古いアプリと同じ数字になるよう、admin.html の以前の計算(最初の指紋行の16進だけ、
  // 2つを並べ替えて通話IDを付けて SHA-256)をそのまま使う
  function firstFpHex(sdp) {
    const m = /^a=fingerprint:\S+ ([0-9A-Fa-f:]+)/m.exec(sdpText(sdp));
    return m ? m[1].toUpperCase() : '';
  }
  async function sasCode(localSdp, remoteSdp, callId) {
    const a = firstFpHex(localSdp), b = firstFpHex(remoteSdp);
    if (!a || !b || !g.crypto || !g.crypto.subtle) return '';
    const material = [a, b].sort().join('|') + '|' + (callId || '');
    const buf = await g.crypto.subtle.digest('SHA-256', new TextEncoder().encode(material));
    return String(new DataView(buf).getUint16(0) % 10000).padStart(4, '0');
  }

  const api = {
    VERSION, TAG, STORE, MAX_RECIPIENTS, STRONG,
    MAX_FP, MAX_SEAL_LEN, extractFingerprints, checkSdp, seal, open, createSession,
    isCapable, markCapable, memStore, reasonKey, localRing, myKey, fetchPeerKeys, sasCode,
  };
  g.CallAuth = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : (typeof window !== 'undefined' ? window : globalThis));
