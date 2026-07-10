// index.js - Ring サーバー エントリーポイント
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');

const db = require('./db/db');
const { router: authRouter } = require('./routes/auth');
const prekeysRouter = require('./routes/prekeys');
const mediaRouter = require('./routes/media');
const groupsRouter = require('./routes/groups');
const { initWebSocketServer } = require('./ws/wsServer');
const { startTTLCleanupJob } = require('./storage/ttlStorageManager');

const PORT = process.env.PORT || 3000;

async function main() {
  await db.initDB();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (req, res) => res.json({ ok: true, service: 'ring-server', time: new Date().toISOString() }));

  // 静的ファイル（クライアント側の HTML/JS）
  app.use(express.static('public'));
  
  // ログイン画面
  app.get('/auth', (req, res) => res.sendFile(path.join(__dirname, 'public', 'authform.html')));
  
  // ホーム（トークリスト）- ログイン必須
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'talklist.html')));

  app.use('/api/auth', authRouter);
  app.use('/api/prekeys', prekeysRouter);
  app.use('/api/media', mediaRouter);
  app.use('/api/groups', groupsRouter);

  const server = http.createServer(app);
  initWebSocketServer(server);
  startTTLCleanupJob();

  server.listen(PORT, () => {
    console.log(`\n🔷 Ring サーバー起動: http://localhost:${PORT}`);
    console.log(`🔷 WebSocket:        ws://localhost:${PORT}/ws`);
    console.log(`🔷 ヘルスチェック:    http://localhost:${PORT}/health\n`);
  });
}

main().catch(err => {
  console.error('[fatal] サーバー起動に失敗しました:', err);
  process.exit(1);
});
