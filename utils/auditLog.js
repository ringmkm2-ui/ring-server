// utils/auditLog.js
// 「誰が・何を・どうなったか」をRenderのログに1行で残す仕組み。
//
// 以前はエラーのログ(console.warn/error)に誰のどの操作かが一切入っておらず、
// 例えば「[icons] cloudinary failed, storing on server: cloudinary 401」が出ても、
// どのユーザーのアイコン変更で起きたのか後から調べようがなかった(usersテーブルにも更新時刻が無い)。
//
// やっていること:
// 1. 書き込み系のAPI(POST/PUT/PATCH/DELETE)が終わるたびに [audit] の行を1行出す。
//    例: [audit] user=123 action=icon.upload api=POST:/api/icons target=user:123 status=200 result=fallback_local err="cloudinary 401" ms=812
// 2. リクエストの途中で出た console.warn / console.error の頭に、そのリクエストの
//    ユーザーとAPIを付ける。例: [req user=123 POST:/api/icons] [icons] cloudinary failed, ...
//    (AsyncLocalStorage = 「今どのリクエストの処理中か」をawaitをまたいで覚えておく仕組み)
//
// ログに絶対に入れないもの: パスワード、トークン、APIキーや署名、メッセージ本文、鍵、メールアドレス。
// そのため本文(req.body)は丸ごとは出さず、決め打ちした「対象のid」の項目だけを、
// idらしい形(数字・英数字の短い文字列)の時だけ出す。URLのクエリ(?token=... が来うる)も出さない。
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

// URLの :param のうち、ログに出してよいもの(どれも内部のidで、秘密ではない)。
// :code(招待コード)や :sid(セッションid)は、知っていれば使えてしまうので出さない
const SAFE_PARAMS = new Set(['id', 'groupId', 'postId', 'commentId', 'channelId', 'messageId', 'msgId', 'userId', 'otherUserId', 'callId']);
// 本文のうち、操作の対象を表す項目(ユーザー名は内部の表示用idなので可。メールは入れない)
const BODY_TARGETS = ['userId', 'targetUserId', 'removeUserId', 'recipientId', 'groupId', 'friendshipId', 'messageId', 'callId', 'targetUsername', 'folder'];
const ID_LIKE = /^[A-Za-z0-9_\-/.]{1,64}$/;

// 既読・入力中・メッセージ送信など、普段の操作で1日に何千回も呼ばれるAPIは、失敗した時だけ記録する。
// 全部出すとログが埋まって肝心の行が探せなくなるのと、誰と誰がいつやり取りしたかを常に残す必要は無いため
const QUIET_ROUTE = /(\/messages\/send|\/messages\/read|\/read-all|\/read\/:userId|\/seen|\/:postId\/view|\/channels\/:channelId\/messages|\/typing|\/fcm-register|\/notify-diag|\/prekeys|\/ratchet|\/translate|\/summarize|\/call-assist)/;

// ログの1項目に入れる値を整える。改行や " を潰して、長すぎる物は切る(ログの行を偽装されないように)
function clean(v, max = 120) {
  let s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/"/g, "'");
  if (s.length > max) s = s.slice(0, max) + '…';
  return s;
}
function fmt(v) {
  const s = clean(v);
  return /^[A-Za-z0-9_.:\/,+\-]+$/.test(s) ? s : `"${s}"`;
}

// どのAPIか。値の入ったURLではなく、ルートの形(/api/groups/:groupId/icon)を使う。
// URLそのままだと招待コードなど知られたくない値がログに残るため
function routeOf(req) {
  if (!req) return '';
  if (req.route && req.route.path) return `${req.method}:${req.baseUrl || ''}${req.route.path}`;
  // ルートに入る前(認証の前段など)。先頭2段だけにして、後ろの値は出さない
  const segs = String(req.path || '').split('/').filter(Boolean);
  return `${req.method}:${req.baseUrl || ''}/${segs.slice(0, 2).join('/')}${segs.length > 2 ? '/…' : ''}`;
}

function userOf(ctx) {
  if (!ctx) return '';
  if (ctx.actor) return ctx.actor;
  if (ctx.req && ctx.req.userId != null) return ctx.req.userId;
  if (typeof ctx.getUserId === 'function') { const u = ctx.getUserId(); if (u != null) return u; }
  return '';
}

function targetsOf(req) {
  const out = [];
  const params = (req && req.params) || {};
  for (const k of Object.keys(params)) {
    if (SAFE_PARAMS.has(k) && ID_LIKE.test(String(params[k]))) out.push(`${k}:${params[k]}`);
  }
  const body = req && req.body && typeof req.body === 'object' ? req.body : {};
  for (const k of BODY_TARGETS) {
    const v = body[k];
    if ((typeof v === 'number' || typeof v === 'string') && ID_LIKE.test(String(v))) out.push(`${k}:${v}`);
  }
  return out.join(',');
}

// Express用ミドルウェア。JSONの読み込みより後に置くこと
// (本文の読み込みはソケットのイベントで進むため、それより前で始めると途中で「今のリクエスト」を見失う)
function middleware(req, res, next) {
  const ctx = { req, start: Date.now(), marks: {} };
  req._auditCtx = ctx;
  // 失敗した時の理由(利用者向けの短い文言)を拾う。成功時の中身(トークン等)は見ない
  const json = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400 && body && typeof body.error === 'string') ctx.respError = body.error;
    return json(body);
  };
  res.on('finish', () => writeRequestLine(ctx, res));
  als.run(ctx, next);
}

function writeRequestLine(ctx, res) {
  const req = ctx.req;
  if (!String(req.originalUrl || '').startsWith('/api/')) return;
  const marked = Object.keys(ctx.marks).length > 0;
  const writes = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
  // どのルートにも当たらなかった物(存在しないAPIへのアクセス)は、ボットの探りがほとんどなので出さない
  if (!req.route && !marked) return;
  if (!writes && !marked) return;
  const route = routeOf(req);
  const failed = res.statusCode >= 400;
  if (!failed && !marked && QUIET_ROUTE.test(route)) return;
  const m = ctx.marks;
  const parts = [
    `user=${fmt(userOf(ctx) || '-')}`,
    `action=${fmt(m.action || route)}`,
  ];
  if (m.action) parts.push(`api=${fmt(route)}`);
  const target = m.target || targetsOf(req);
  if (target) parts.push(`target=${fmt(target)}`);
  if (m.detail) parts.push(`detail=${fmt(m.detail)}`);
  parts.push(`status=${res.statusCode}`);
  parts.push(`result=${fmt(m.result || (failed ? 'fail' : 'ok'))}`);
  const err = m.err || (failed ? ctx.respError : '');
  if (err) parts.push(`err=${fmt(err)}`);
  parts.push(`ms=${Date.now() - ctx.start}`);
  rawLog('[audit] ' + parts.join(' '));
}

// 今のリクエストの記録に情報を足す。リクエストの外(起動時の処理など)で呼ばれたら何もしない。
// fields: { action, target, result, err, detail } (後から来た値で上書き。detailだけは足していく)
function mark(fields) {
  const ctx = als.getStore();
  if (!ctx || !ctx.marks) return;
  for (const [k, v] of Object.entries(fields || {})) {
    if (v == null || v === '') continue;
    if (k === 'detail' && ctx.marks.detail) ctx.marks.detail += ',' + clean(v, 60);
    else ctx.marks[k] = clean(v);
  }
}

// ログインや登録など、トークンを持たずに来たリクエストで「誰になったか」が分かった時に呼ぶ
function setUser(userId) {
  const ctx = als.getStore();
  if (ctx && userId != null) ctx.actor = String(userId);
}

// WebSocketのメッセージ処理を、そのユーザーの印付きで動かす(中で出たエラーログに user= が付く)
function runWs(getUserId, fn) {
  return als.run({ getUserId, label: 'WS' }, fn);
}

// サーバー自身の定期処理(起動時のアイコン移行など)を、何の処理中か分かる印付きで動かす
function runSystem(label, fn) {
  return als.run({ actor: 'system', label }, fn);
}

// 共通のエラーハンドラなど、ALSの印を見失っているかもしれない所で、reqから印を戻して動かす
function withReq(req, fn) {
  const ctx = req && req._auditCtx;
  if (!ctx || als.getStore() === ctx) return fn();
  return als.run(ctx, fn);
}

function prefix() {
  const ctx = als.getStore();
  if (!ctx) return '';
  const where = ctx.req ? routeOf(ctx.req) : (ctx.label || '');
  return `[req user=${clean(userOf(ctx) || '-', 40)} ${clean(where, 80)}]`;
}

// console.warn / console.error の頭に、今のリクエストの印を付ける。
// 1つ目の引数が文字列ならそこへ連結する(書式の %s などの扱いを変えないため。印の中の % は %% にする)
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);
const origLog = console.log.bind(console);
function rawLog(line) { origLog(line); }
function wrap(orig) {
  return (...args) => {
    const p = prefix();
    if (!p) return orig(...args);
    const safeP = p.replace(/%/g, '%%');
    if (typeof args[0] === 'string') args[0] = safeP + ' ' + args[0];
    else args.unshift(safeP);
    return orig(...args);
  };
}
let patched = false;
function installConsoleContext() {
  if (patched) return;
  patched = true;
  console.warn = wrap(origWarn);
  console.error = wrap(origError);
}

module.exports = { middleware, mark, setUser, runWs, runSystem, withReq, installConsoleContext, _routeOf: routeOf, _targetsOf: targetsOf };
