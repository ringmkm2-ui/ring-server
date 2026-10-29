// utils/linkPreview.js
// リンクのプレビュー(タイトル・説明・画像)を、サーバーがURL先を取りに行って作る。
//
// 一番の危険は SSRF: 利用者が好きなURLを渡せるので、そのまま取りに行くとサーバーから見た
// 内部ネットワーク(127.0.0.1・社内IP・クラウドのメタデータ 169.254.169.254 など)を覗かれる。
// そのため以下を全部守る。
//  - http / https だけ、ユーザー名・パスワード付きは不可、ポートは 80 / 443 だけ
//  - DNS はこちらで引き、返った全てのアドレスが公開IPであること(1つでも内部なら拒否)
//  - 接続は検証済みのIPに固定する(検証と接続の間にDNSを書き換えられる DNS rebinding を防ぐ)
//  - リダイレクトは3回まで、毎回同じ検証をやり直す
//  - 全体で5秒、本文は512KBまで、text/html だけ
//  - 返すのは平文のテキストだけ(HTMLは通さない)。画像は https のURLだけ
const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const MAX_REDIRECTS = 3;
const TOTAL_TIMEOUT_MS = 5000;
const MAX_BODY = 512 * 1024;
const CACHE_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;

// --- IP の判定 ---------------------------------------------------------

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3]) >>> 0;
}
// [開始, 長さ(ビット)]
const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
].map(([a, bits]) => ({ base: v4ToInt(a), mask: bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0 }));

function isBlockedV4(ip) {
  const n = v4ToInt(ip);
  return BLOCKED_V4.some(r => ((n & r.mask) >>> 0) === r.base);
}

// IPv6 を 16bit x 8 に展開する。読めなければ null
function parseV6(ip) {
  if (ip.includes('%')) return null; // ゾーンID付きは扱わない
  let s = ip.toLowerCase();
  // 末尾が a.b.c.d の形(IPv4埋め込み)
  const m = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (m) {
    if (net.isIPv4(m[2]) === false) return null;
    const n = v4ToInt(m[2]);
    s = m[1] + ((n >>> 16) & 0xffff).toString(16) + ':' + (n & 0xffff).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const out = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}
function v4FromGroups(hi, lo) { return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }

function isBlockedV6(ip) {
  const g = parseV6(ip);
  if (!g) return true; // 読めないものは通さない
  const allZeroUpTo = (n) => g.slice(0, n).every(x => x === 0);
  if (g.every(x => x === 0)) return true;                            // ::
  if (allZeroUpTo(7) && g[7] === 1) return true;                     // ::1
  if (allZeroUpTo(5) && g[5] === 0xffff) return isBlockedV4(v4FromGroups(g[6], g[7])); // ::ffff:a.b.c.d (IPv4-mapped)
  if (allZeroUpTo(6)) return true;                                   // ::a.b.c.d (互換アドレス、廃止済み)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return isBlockedV4(v4FromGroups(g[6], g[7])); // 64:ff9b::/96 (NAT64)
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return true;   // 64:ff9b:1::/48
  if (g[0] === 0x100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 (discard)
  if ((g[0] & 0xfe00) === 0xfc00) return true;                       // fc00::/7 (ULA)
  if ((g[0] & 0xffc0) === 0xfe80) return true;                       // fe80::/10 (link-local)
  if ((g[0] & 0xffc0) === 0xfec0) return true;                       // fec0::/10 (site-local, 廃止)
  if ((g[0] & 0xff00) === 0xff00) return true;                       // ff00::/8 (multicast)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true;               // documentation
  if (g[0] === 0x2001 && g[1] === 0) return true;                    // Teredo
  if (g[0] === 0x2002) return isBlockedV4(v4FromGroups(g[1], g[2])); // 6to4: 埋め込まれたIPv4を見る
  return false;
}

// true = 内部/予約/不正なので接続してはいけない
function isBlockedIp(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '');
  if (net.isIPv4(s)) return isBlockedV4(s);
  if (net.isIPv6(s)) return isBlockedV6(s);
  return true;
}

// --- テスト用の抜け道 ----------------------------------------------------
// テストは 127.0.0.1 のローカルサーバーを相手にするため、NODE_ENV==='test' の時だけ、
// LINK_PREVIEW_TEST_ALLOW(カンマ区切りのホスト名/IP)に書いたホストは内部IP・ポート制限を免除する。
// 本番(NODE_ENV が test 以外)では環境変数が書かれていても読まない。
function testAllowed(hostname) {
  if (process.env.NODE_ENV !== 'test') return false;
  const list = String(process.env.LINK_PREVIEW_TEST_ALLOW || '').split(',').map(x => x.trim()).filter(Boolean);
  return list.includes(hostname);
}

// --- URL の検証と名前解決 -------------------------------------------------

class PreviewError extends Error {
  constructor(msg, status) { super(msg); this.status = status || 400; }
}

function parseHttpUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new PreviewError('URLの形式が正しくありません'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PreviewError('http/https のURLだけ使えます');
  if (u.username || u.password) throw new PreviewError('このURLは使えません');
  if (!u.hostname) throw new PreviewError('URLの形式が正しくありません');
  return u;
}

// 取りに行ってよい宛先か確かめ、接続に使うIPを1つ返す
async function resolveSafe(u, resolver) {
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const allowTest = testAllowed(host);
  if (!allowTest) {
    const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
    if (port !== 80 && port !== 443) throw new PreviewError('このURLは使えません');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
      throw new PreviewError('このURLは使えません');
    }
  }
  let addrs;
  if (net.isIP(host)) {
    addrs = [{ address: host, family: net.isIPv4(host) ? 4 : 6 }];
  } else {
    try {
      addrs = await resolver(host);
    } catch (e) {
      throw new PreviewError('取得できませんでした', 422);
    }
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new PreviewError('取得できませんでした', 422);
  if (!allowTest && addrs.some(a => isBlockedIp(a.address))) throw new PreviewError('このURLは使えません');
  return addrs[0];
}

const defaultResolver = async (host) => dns.promises.lookup(host, { all: true, verbatim: true });

// 検証済みのIPにだけつなぐ(URLのホスト名はそのまま残すので、TLSの証明書確認とHostヘッダは本来の名前で行われる)
function pinnedLookup(addr) {
  return (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    if (options && options.all) return cb(null, [{ address: addr.address, family: addr.family }]);
    cb(null, addr.address, addr.family);
  };
}

function requestOnce(u, addr, deadline) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new PreviewError('時間内に取得できませんでした', 504));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      lookup: pinnedLookup(addr),
      agent: false,
      headers: {
        'User-Agent': 'BroChatLinkPreview/1.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Encoding': 'identity',
      },
    });
    const timer = setTimeout(() => req.destroy(new PreviewError('時間内に取得できませんでした', 504)), left);
    req.on('error', (e) => { clearTimeout(timer); reject(e instanceof PreviewError ? e : new PreviewError('取得できませんでした', 422)); });
    req.on('response', (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        clearTimeout(timer);
        return resolve({ redirect: String(res.headers.location) });
      }
      if (status !== 200) { res.resume(); clearTimeout(timer); return reject(new PreviewError('取得できませんでした', 422)); }
      const ct = String(res.headers['content-type'] || '').toLowerCase();
      if (!/^(text\/html|application\/xhtml\+xml)\b/.test(ct)) { res.resume(); clearTimeout(timer); return reject(new PreviewError('プレビューできないページです', 422)); }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          chunks.push(c.subarray(0, c.length - (size - MAX_BODY)));
          clearTimeout(timer);
          res.destroy(); // 512KB 読めば <head> には十分
          resolve({ body: Buffer.concat(chunks).toString('utf8') });
        } else chunks.push(c);
      });
      res.on('end', () => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks).toString('utf8') }); });
      res.on('error', () => { clearTimeout(timer); resolve({ body: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.end();
  });
}

// リダイレクトを辿って本文を取る。毎回、検証と名前解決をやり直す
async function fetchHtml(startUrl, resolver) {
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let u = parseHttpUrl(startUrl);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const addr = await resolveSafe(u, resolver);
    const r = await requestOnce(u, addr, deadline);
    if (r.body !== undefined) return { body: r.body, finalUrl: u };
    let next;
    try { next = new URL(r.redirect, u); } catch (e) { throw new PreviewError('取得できませんでした', 422); }
    u = parseHttpUrl(next.href);
  }
  throw new PreviewError('リダイレクトが多すぎます', 422);
}

// --- HTML の読み取り -------------------------------------------------------
// 正規表現だけの小さな読み取り。タグは1つも返さず、取り出した値は全部平文にする。

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(cp) || cp < 32 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ' ';
      return String.fromCodePoint(cp);
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
function plain(s, max) {
  if (typeof s !== 'string') return '';
  // 先にエンティティを戻してからタグを落とす(&lt;b&gt; のように隠した形でも、最終的にタグは残らない)
  let t = decodeEntities(s).replace(/<[^>]*>/g, ' ');
  t = t.replace(/[<>]/g, '');                    // 閉じていない < > も落とす(HTMLとして解釈させない)
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(tag))) {
    const k = m[1].toLowerCase();
    if (!(k in attrs)) attrs[k] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '';
  }
  return attrs;
}

function extractMeta(html, baseUrl) {
  // <head> の外(本文)のmetaは見ない。無ければ先頭から
  const headEnd = html.search(/<\/head\s*>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd) : html.slice(0, 200 * 1024);
  const meta = {};
  // 引用符の中の > では閉じない(属性値に <script> のような文字が入っていても、タグの終わりを取り違えない)
  const re = /<meta\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  let m;
  while ((m = re.exec(head))) {
    const a = parseAttrs(m[1]);
    const key = (a.property || a.name || '').toLowerCase();
    if (key && a.content !== undefined && !(key in meta)) meta[key] = a.content;
  }
  const t = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head);

  let image = '';
  const rawImg = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src'] || '';
  if (rawImg) {
    try {
      const iu = new URL(decodeEntities(rawImg).trim(), baseUrl);
      // クライアントが <img> で読むので https だけ。ユーザー名付き・長すぎるものは捨てる
      if (iu.protocol === 'https:' && !iu.username && !iu.password && iu.href.length <= 500) image = iu.href;
    } catch (e) { /* 無効なら画像なし */ }
  }
  return {
    title: plain(meta['og:title'] || meta['twitter:title'] || (t ? t[1] : ''), 200),
    description: plain(meta['og:description'] || meta['twitter:description'] || meta['description'] || '', 300),
    image,
    siteName: plain(meta['og:site_name'] || '', 100),
  };
}

// --- キャッシュ(LRU, 10分) ---------------------------------------------------
const cache = new Map(); // url -> { v, exp }
function cacheGet(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (e.exp < Date.now()) { cache.delete(k); return null; }
  cache.delete(k); cache.set(k, e); // 使ったものを一番新しい位置へ
  return e.v;
}
function cachePut(k, v) {
  cache.delete(k);
  cache.set(k, { v, exp: Date.now() + CACHE_MS });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}
function _clearCache() { cache.clear(); }

// 本体。成功した結果だけキャッシュする。resolver はテストで差し替えられる
async function getPreview(rawUrl, resolver = defaultResolver) {
  const start = parseHttpUrl(rawUrl);
  const key = start.href;
  const hit = cacheGet(key);
  if (hit) return hit;
  const { body, finalUrl } = await fetchHtml(key, resolver);
  const meta = extractMeta(body, finalUrl);
  const out = { url: key.length <= 2000 ? key : key.slice(0, 2000) };
  for (const k of ['title', 'description', 'image', 'siteName']) if (meta[k]) out[k] = meta[k];
  cachePut(key, out);
  return out;
}

module.exports = { getPreview, isBlockedIp, extractMeta, parseHttpUrl, PreviewError, _clearCache };
