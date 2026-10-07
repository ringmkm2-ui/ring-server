// テスト用の小道具: サーバーを別プロセスで立ち上げて、APIを叩く。
// - TEST_DATABASE_URL があれば PostgreSQL(本番と同じ)、無ければ一時ファイルの SQLite で動かす
// - 登録の回数制限(1時間に5回/IP)に引っかからないよう、ユーザーごとに別の IP(X-Forwarded-For)を名乗る
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');

async function startServer(extraEnv = {}) {
  const port = 4100 + Math.floor(Math.random() * 800);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'brochat-test-'));
  const env = {
    ...process.env,
    PORT: String(port),
    JWT_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    NODE_ENV: 'test',
    ...extraEnv,
  };
  delete env.DATABASE_URL;
  if (process.env.TEST_DATABASE_URL) env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  else env.SQLITE_FILE = path.join(tmp, 'test.sqlite');
  // 本番用の秘密は子プロセスに渡さない
  for (const k of ['ADMIN_API_KEY', 'CLAUDE_FEED_KEY', 'FIREBASE_SERVICE_ACCOUNT', 'VAPID_PRIVATE_KEY', 'SMTP_PASS', 'RESEND_API_KEY']) {
    if (!(k in extraEnv)) delete env[k];
  }

  const proc = spawn(process.execPath, ['index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('server exited:\n' + log);
    try { const r = await fetch(base + '/health'); if (r.ok) break; } catch (_) {}
    if (Date.now() > deadline) { proc.kill(); throw new Error('server did not start:\n' + log); }
    await new Promise(r => setTimeout(r, 200));
  }

  let ipSeq = 1;
  const nextIp = () => `10.${Math.floor(Math.random() * 200)}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;

  async function req(method, p, { token, body, ip } = {}) {
    const res = await fetch(base + p, {
      method,
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': ip || nextIp(),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return { status: res.status, data };
  }

  const rnd = () => Math.random().toString(36).slice(2, 8);
  async function user(displayName = 'User') {
    const ip = nextIp();
    const username = `t_${rnd()}${rnd()}@example.com`;
    const password = 'Vq8!mZ' + rnd() + 'xL2';
    const r = await req('POST', '/api/auth/register', { ip, body: { username, password, displayName } });
    if (r.status !== 200 || !r.data || !r.data.token) throw new Error('register failed: ' + JSON.stringify(r));
    const u = { ...r.data, username, password, ip };
    u.call = (method, p, body) => req(method, p, { token: u.token, body, ip });
    return u;
  }

  async function befriend(a, b) {
    const r1 = await a.call('POST', '/api/friends/request', { targetUserIdCode: b.userIdCode });
    if (r1.status !== 200) throw new Error('request failed ' + JSON.stringify(r1));
    const pend = await b.call('GET', '/api/friends/pending');
    const f = pend.data.find(p => p.userId === a.userId);
    const r2 = await b.call('POST', '/api/friends/accept', { friendshipId: f.friendshipId });
    if (r2.status !== 200) throw new Error('accept failed ' + JSON.stringify(r2));
  }

  // WebSocket で接続して認証まで済ませる。受け取ったメッセージは msgs に溜まる
  function connect(u) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'x-forwarded-for': u.ip } });
      const msgs = [];
      ws.on('message', raw => {
        let d; try { d = JSON.parse(raw.toString()); } catch (_) { return; }
        msgs.push(d);
        if (d.type === 'auth_ok') resolve({ ws, msgs, send: o => ws.send(JSON.stringify(o)), close: () => ws.close() });
        if (d.type === 'auth_error') reject(new Error('ws auth failed'));
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: u.token })));
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws timeout')), 8000);
    });
  }

  function stop() {
    proc.kill();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  return { base, req, user, befriend, connect, stop, log: () => log };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = { startServer, sleep };
