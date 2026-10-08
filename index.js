// index.js - Ring サーバー エントリーポイント
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const db = require('./db/db');
const { router: authRouter } = require('./routes/auth');
const prekeysRouter = require('./routes/prekeys');
const mediaRouter = require('./routes/media');
const groupsRouter = require('./routes/groups');
const friendsRouter = require('./routes/friends');
const messagesRouter = require('./routes/messages');
const pushRouter = require('./routes/push');
const postsRouter = require('./routes/posts');
const iceRouter = require('./routes/ice');
const callAssistRouter = require('./routes/callAssist');
const communitiesRouter = require('./routes/communities');
const { uploadRouter: iconUploadRouter, publicRouter: iconPublicRouter } = require('./routes/icons');
const callsRouter = require('./routes/calls');
const adminRouter = require('./routes/admin');
const reportsRouter = require('./routes/reports');
const settingsRouter = require('./routes/settings');
const { initWebSocketServer } = require('./ws/wsServer');
const { apiLimiter } = require('./utils/rateLimits');
const { startKeepAlive } = require('./utils/keepAlive');

const PORT = process.env.PORT || 3000;

// このアプリのフロントエンドは同一オリジン(Express自身がpublic/を配信)から
// しか呼ばれない設計のため、他オリジンからのAPI呼び出しを許可する理由が無い。
// 以前は cors() を引数無しで使っており、これは全オリジンを無条件許可する
// 設定 = 悪意のある第三者サイトが被害者のブラウザ経由でこのAPIを叩ける状態だった。
// ALLOWED_ORIGINS環境変数でカンマ区切り追加可能にしておく(将来別ドメインを足す場合用)。
const DEFAULT_ALLOWED_ORIGINS = [
  'https://ring-server-50sy.onrender.com',
  'http://localhost:3000',
];
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? DEFAULT_ALLOWED_ORIGINS.concat(process.env.ALLOWED_ORIGINS.split(','))
  : DEFAULT_ALLOWED_ORIGINS;

async function main() {
  await db.initDB();

  const app = express();

  // Renderはリバースプロキシ経由でアプリにリクエストを渡すため、
  // これが無いとexpress-rate-limit等がプロキシのIPを見てしまい、
  // 全ユーザーが同一IP扱いになってレート制限が正しく機能しない。
  app.set('trust proxy', 1);

  // セキュリティ関連HTTPヘッダーを一括設定(X-Content-Type-Options,
  // X-Frame-Options, Strict-Transport-Security 等)。
  // WebRTC(getUserMedia)やWebSocket、外部CDN(cdnjs等)を使うため、
  // デフォルトのContent-Security-Policyは今回は無効化し個別のヘッダーのみ有効化する。
  // (CSPを厳格にするには全インラインscript/styleの棚卸しが必要で、今回のスコープでは
  //  誤ってアプリを壊すリスクの方が大きいため見送り、まずは他の重要ヘッダーを効かせる)
  //
  // crossOriginOpenerPolicy: helmetのデフォルト(same-origin)は、Google Sign-In
  // (accounts.google.com/gsi/...)のポップアップが親ウィンドウと通信する経路を
  // 遮断してしまい、「accounts.google.com/gsi/transformで止まる」「ポップアップが
  // 空白のまま固まる」といったログイン不能の不具合を引き起こす。
  // Google公式ドキュメントの推奨に従い same-origin-allow-popups を設定する
  // (完全無効化(unsafe-none)よりもセキュリティを保てるため、こちらを優先する)。
  // CSPを完全無効化するのではなく、必要な外部リソースだけをホワイトリストする。
  // これにより、XSS脆弱性があっても攻撃者が任意の外部スクリプトを読み込めなくなる。
  // 'unsafe-inline' は既存のインラインscript/styleが多数あるため当面必要だが、
  // 将来的にはnonce方式へ移行すべき。
  // gzip圧縮。JSON(トーク一覧・メッセージ履歴など)はテキストなので大きく縮む。
  // 今まで無圧縮で、アイコンが多いと1回の更新が1MB超になりモバイル回線で読み込みが長引いていた。
  // 暗号化済みメディア(Cloudinaryへ直接送る分)はここを通らない。
  app.use(compression({ threshold: 1024 }));

  // CSPのnonce(リクエストごとの使い捨ての合言葉)。HTML内の<script>には配信時にこれを付け、
  // CSPで「このnonceが付いたscriptだけ実行してよい」とする。
  // 以前は 'unsafe-inline' で全インラインscriptを許していたため、どこかでHTMLを差し込まれる
  // バグ(XSS)が1つでもあれば、そのまま任意のJSを実行できた。nonceがあると差し込まれた
  // <script> や onerror= 等は実行されない。
  app.use((req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          (req, res) => `'nonce-${res.locals.cspNonce}'`,
          // libsodium(グループの暗号化)はWebAssemblyで動く。これが無いとWASMの読み込みがCSPで拒否され、
          // グループ画面で暗号ライブラリの初期化が失敗していた。evalそのものは許さない(WASMだけ)
          "'wasm-unsafe-eval'",
          // nonceに対応したブラウザでは 'unsafe-inline' は無視される(nonce非対応の古いブラウザ向けの互換)
          "'unsafe-inline'",
          "https://accounts.google.com",
          "https://cdnjs.cloudflare.com",
        ],
        // helmetはデフォルトで script-src-attr 'none' を足してくる。これが有効だと
        // onclick="..." 等のインラインイベントハンドラが全ページで一切動かなくなる
        // (v1.28.74でwelcome.htmlの「はじめる」を押しても無反応になった原因)。
        // インラインハンドラが各ページに残っている間はここで許可しておく。
        // onclick="..." 等のインラインイベント属性は全部 data-* + js/actions.js に置き換えたので禁止する
        scriptSrcAttr: ["'none'"],
        styleSrc: [
          "'self'",
          "'unsafe-inline'",          // 既存インラインstyle互換
          "https://fonts.googleapis.com",
          "https://accounts.google.com",
        ],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: [
          "'self'",
          "data:",                     // Base64画像
          "blob:",
          "https://res.cloudinary.com",
          "https://*.googleusercontent.com",
        ],
        mediaSrc: ["'self'", "blob:", "https://res.cloudinary.com"],
        connectSrc: [
          "'self'",
          "wss:",                      // WebSocket
          "https://api.anthropic.com",
          "https://accounts.google.com",
          "https://people.googleapis.com",
          "https://res.cloudinary.com",
          "https://api.cloudinary.com",
        ],
        // 'self' はPC用の2列表示(トーク一覧の右に自分のチャット画面を埋め込む)に必要。
        // 以前は無かったため埋め込みが毎回ブロックされ、2列にならず画面ごと切り替わっていた
        frameSrc: ["'self'", "https://accounts.google.com"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],    // クリックジャッキング防止(他サイトからの埋め込みは禁止。PC版の2列表示で自分自身の埋め込みだけ許可)
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }));

  app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }));
  // JSON本文の上限。以前は全API(ログイン等の未ログインで叩ける所も含む)に50MBを許していたため、
  // 誰でも50MBのJSONを何本か同時に送るだけでメモリ(512MB)を使い切らせてサーバーを落とせた。
  // 普段は4MB(プロフィール画像のBase64が最大3MB)まで。画像・動画を本文に入れて送る
  // メッセージ送信と投稿だけ50MBにし、しかも読み込む前に署名の正しいトークンかを確かめる。
  const smallJson = express.json({ limit: '4mb' });
  // (メッセージ本文は暗号文64KBまで、画像・動画はCloudinary経由なので、もう50MBは要らない)
  const bigJson = express.json({ limit: '2mb' });
  // (投稿はCloudinaryのURLだけになったので、大きな本文はもう要らない)
  const BIG_BODY_RE = /^\/api\/(messages\/send|groups\/[^/]+\/messages\/send)\/?$/;
  const { JWT_SECRET } = require('./utils/jwtSecret');
  const jwt = require('jsonwebtoken');
  app.use((req, res, next) => {
    if (req.method === 'POST' && BIG_BODY_RE.test(req.path)) {
      const h = req.headers.authorization || '';
      try {
        jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET, { algorithms: ['HS256'] });
      } catch (e) {
        return res.status(401).json({ error: 'トークンが無効です' });
      }
      return bigJson(req, res, next);
    }
    return smallJson(req, res, next);
  });

  // Slowloris/遅延攻撃対策: リクエスト全体のタイムアウトを設定。
  // デフォルトは無制限で、接続を意図的に遅延させてサーバーリソースを枯渇させる攻撃が可能。
  // ファイルアップロード(最大50MB)を考慮して60秒に設定する。
  app.use((req, res, next) => {
    res.setTimeout(60000, () => {
      res.status(408).json({ error: 'リクエストタイムアウト' });
    });
    next();
  });

  // API全体への高頻度リクエストを制限(スクリプトによる連打・スクレイピング対策)
  app.use('/api', apiLimiter);

  app.get('/health', (req, res) => res.json({ ok: true, service: 'ring-server', time: new Date().toISOString() }));

  // クライアントが「自分は古い版か」を確かめるためのバージョン返却。キャッシュさせない。
  app.get('/api/version', (req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    let version = '';
    try { version = JSON.parse(require('fs').readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch (e) {}
    res.json({ version });
  });

  // sw.js(Service Worker本体)は、ブラウザ/中継プロキシに一切キャッシュさせない。
  // ここがキャッシュされると「デプロイしても誰にも新バージョンが届かない」
  // 事態になり、アプリを開くだけで自動更新される仕組み全体が機能しなくなるため。
  app.get('/sw.js', (req, res) => {
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Service-Worker-Allowed', '/');
    res.sendFile(path.join(__dirname, 'public', 'sw.js'));
  });

  // manifest.jsonも同様に、アイコン更新等がすぐ反映されるようキャッシュを抑制
  app.get('/manifest.json', (req, res) => {
    res.set('Cache-Control', 'no-cache, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
  });

  // HTMLページは、<script> にこのリクエストのnonceを付けてから返す(CSPで実行を許すため)。
  // ファイルの中身はメモリに置き、更新時刻が変わった時だけ読み直す。
  const htmlCache = new Map(); // fullPath -> { mtimeMs, text }
  const PUBLIC_DIR = path.join(__dirname, 'public');
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    let rel = req.path === '/' ? '/splash.html' : req.path;
    if (!/^\/[A-Za-z0-9_-]+\.html$/.test(rel)) return next();
    const full = path.join(PUBLIC_DIR, rel);
    let st;
    try { st = fs.statSync(full); } catch (e) { return next(); }
    let c = htmlCache.get(full);
    if (!c || c.mtimeMs !== st.mtimeMs) {
      c = { mtimeMs: st.mtimeMs, text: fs.readFileSync(full, 'utf8') };
      htmlCache.set(full, c);
    }
    const nonce = res.locals.cspNonce;
    const body = c.text.replace(/<script(?=[\s>])/gi, `<script nonce="${nonce}"`);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.send(body);
  });

  // 静的ファイル（クライアント側の HTML/JS）
  app.use(express.static('public'));
  
  // 起動時のスプラッシュ画面（Powered by → Welcome画面へ拡大遷移）
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'splash.html')));

  app.use('/api/auth', authRouter);
  app.use('/api/prekeys', prekeysRouter);
  app.use('/api/icons', iconUploadRouter);
  app.use('/icons', iconPublicRouter); // 公開配信(/apiのレート制限の外。一覧で大量に読まれるため)
  app.use('/api/media', mediaRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/friends', friendsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/push', pushRouter);
  app.use('/api/posts', postsRouter);
  app.use('/api/ice', iceRouter);
  app.use('/api/call-assist', callAssistRouter);
  app.use('/api/communities', communitiesRouter);
  app.use('/api/calls', callsRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/claude-feed', require('./routes/claudeFeed'));
  app.use('/api/settings', settingsRouter);
  app.use('/api/moderation', require('./routes/moderation'));
  app.use('/api/staff', require('./routes/staff'));
  app.use('/api/live', require('./routes/live'));
  // Googleドライブ(公式アカウント)をトークの画像・動画の置き場所に使う
  const driveRoutes = require('./routes/drive');
  app.use('/api/drive', driveRoutes.router);
  app.get('/m/d/:id', require('./utils/authMiddleware').verifyToken, require('./utils/asyncHandler').asyncHandler(driveRoutes.serveFile));

  // 未定義APIルートへのアクセス(404)。Expressのデフォルト404ページは
  // 環境によってはスタックトレース相当の情報を含むHTMLを返すことがあるため、
  // シンプルなJSONで統一する。
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // グローバルエラーハンドラ(最終防衛ライン)。
  // groups.js/media.js/prekeys.js 等、ルート内で個別にtry/catchしていない
  // 箇所で例外が発生した場合、Expressはこのハンドラに処理を委譲する。
  // これが無いと、NODE_ENV次第でExpressのデフォルトハンドラが
  // スタックトレースを含むHTMLをそのままクライアントへ返してしまう
  // (ファイルパス・行番号・依存ライブラリ構成などが漏洩する)。
  // 4引数(err, req, res, next)はExpressがエラーハンドラと認識するために必須。
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    // 壊れたJSON・大きすぎる本文などはクライアント側の問題なので4xxで返す(以前は全部500になり、
    // スタック付きのエラーログがログを埋めていた)
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.type === 'encoding.unsupported' || err.type === 'charset.unsupported')) {
      const status = err.type === 'entity.too.large' ? 413 : 400;
      return res.status(status).json({ error: status === 413 ? 'データが大きすぎます' : 'リクエストの形式が正しくありません' });
    }
    console.error('[unhandled error]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
  });

  const server = http.createServer(app);
  initWebSocketServer(server);
  startKeepAlive();

  // 既存ユーザーのBase64アイコンを、画像のURLに置き換える(裏で1回ずつ。失敗した分は次回起動時に再挑戦)
  setTimeout(async () => {
    try {
      const { parseDataUrl, storeIcon } = require('./utils/iconStore');
      const base = process.env.PUBLIC_BASE_URL || (process.env.RENDER_EXTERNAL_URL || '');
      if (!base) { console.log('[icons] migration skipped: PUBLIC_BASE_URL/RENDER_EXTERNAL_URL not set'); return; }
      const rows = await db.all("SELECT id, profile_pic FROM users WHERE profile_pic LIKE 'data:image/%'");
      let done = 0;
      for (const u of rows) {
        const parsed = parseDataUrl(u.profile_pic);
        if (!parsed) continue;
        try {
          const url = await storeIcon(parsed.buf, parsed.mime, base.replace(/\/$/, ''));
          await db.run('UPDATE users SET profile_pic = ? WHERE id = ? AND profile_pic = ?', [url, u.id, u.profile_pic]);
          done++;
        } catch (e) { console.warn('[icons] migrate failed for a user:', e.message); }
      }
      if (rows.length) console.log(`[icons] Base64アイコンを移行: ${done}/${rows.length}`);
    } catch (e) { console.warn('[icons] migration error:', e.message); }
  }, 15000);

  server.listen(PORT, () => {
    console.log(`\nRing サーバー起動: http://localhost:${PORT}`);
    console.log(`WebSocket:        ws://localhost:${PORT}/ws`);
    console.log(`ヘルスチェック:    http://localhost:${PORT}/health\n`);
  });
}

main().catch(err => {
  console.error('[fatal] サーバー起動に失敗しました:', err);
  process.exit(1);
});
