// index.js - Ring サーバー エントリーポイント
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const db = require('./db/db');
const { router: authRouter } = require('./routes/auth');
const prekeysRouter = require('./routes/prekeys');
const mediaRouter = require('./routes/media');
const groupsRouter = require('./routes/groups');
const friendsRouter = require('./routes/friends');
const messagesRouter = require('./routes/messages');
const pushRouter = require('./routes/push');
const { initWebSocketServer } = require('./ws/wsServer');
const { startTTLCleanupJob } = require('./storage/ttlStorageManager');
const { apiLimiter } = require('./utils/rateLimits');

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
  app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  }));

  app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true,
  }));
  app.use(express.json({ limit: '50mb' }));

  // API全体への高頻度リクエストを制限(スクリプトによる連打・スクレイピング対策)
  app.use('/api', apiLimiter);

  app.get('/health', (req, res) => res.json({ ok: true, service: 'ring-server', time: new Date().toISOString() }));

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

  // 静的ファイル（クライアント側の HTML/JS）
  app.use(express.static('public'));
  
  // 起動時のスプラッシュ画面（Powered by → Welcome画面へ拡大遷移）
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'splash.html')));

  app.use('/api/auth', authRouter);
  app.use('/api/prekeys', prekeysRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/groups', groupsRouter);
  app.use('/api/friends', friendsRouter);
  app.use('/api/messages', messagesRouter);
  app.use('/api/push', pushRouter);

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
    console.error('[unhandled error]', err && err.stack ? err.stack : err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'サーバーエラーが発生しました。しばらくしてから再度お試しください。' });
  });

  const server = http.createServer(app);
  initWebSocketServer(server);
  startTTLCleanupJob();

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
