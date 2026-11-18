const { app, BrowserWindow, ipcMain, safeStorage, Menu, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');


// 二重起動しない(管理キーを扱うので窓が増えるのは避ける)
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null;
app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

const cfgPath = () => path.join(app.getPath('userData'), 'settings.json');

function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch (e) { return {}; }
}
function writeCfg(c) {
  const tmp = cfgPath() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o600 });
  fs.renameSync(tmp, cfgPath());
}

const DEFAULT_URL = 'https://ring-server-50sy.onrender.com';

// 管理キーを送ってよい先: https か、手元の開発サーバーだけ
function validUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:') return x.origin;
    if (x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1')) return x.origin;
  } catch (e) {}
  return null;
}

function canEncrypt() {
  try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
}

function decodeKey(c) {
  if (!c.key || !canEncrypt()) return '';
  try { return safeStorage.decryptString(Buffer.from(c.key, 'base64')); } catch (e) { return ''; }
}

ipcMain.handle('cfg:get', () => {
  const c = readCfg();
  return { url: c.url || DEFAULT_URL, key: decodeKey(c), remember: !!c.key };
});

ipcMain.handle('cfg:save', (e, a) => {
  const url = a && typeof a.url === 'string' ? a.url.slice(0, 300) : '';
  const c = { url };
  // OSの暗号化が使えない時は、管理キーを平文でディスクに置かない(保存しない)
  if (a && a.remember && typeof a.key === 'string' && a.key && canEncrypt()) {
    c.key = safeStorage.encryptString(a.key).toString('base64');
  }
  writeCfg(c);
  return { saved: !!c.key || !(a && a.remember), encryptionAvailable: canEncrypt() };
});

ipcMain.handle('info', () => ({
  version: app.getVersion(),
  platform: process.platform,
  encryptionAvailable: canEncrypt(),
}));

ipcMain.handle('clip:write', (e, text) => {
  if (typeof text !== 'string' || text.length > 2000) return false;
  clipboard.writeText(text);
  return true;
});

const PATH_RE = /^\/api\/admin\/[A-Za-z0-9_\-./:?=&%+]*$/;
const WAKE_STATUS = new Set([502, 503, 504]); // Renderが寝ていて起動中の時に返ってくる
const sleep = ms => new Promise(r => setTimeout(r, ms));

ipcMain.handle('api', async (e, req) => {
  const { url, key, method, path: p, body } = req || {};
  const origin = validUrl(url);
  if (!origin) return { status: 0, error: 'URLが正しくありません(https:// で始めてください)' };
  if (typeof p !== 'string' || p.length > 600 || p.includes('..') || !PATH_RE.test(p)) return { status: 0, error: '不正なパスです' };
  if (typeof key !== 'string' || !key || key.length > 200 || /[\r\n]/.test(key)) return { status: 0, error: '管理キーが正しくありません' };
  const m = String(method || 'GET').toUpperCase();
  if (m !== 'GET' && m !== 'POST') return { status: 0, error: '不正なメソッドです' };
  const payload = body === undefined || body === null ? undefined : JSON.stringify(body);
  if (payload && payload.length > 20000) return { status: 0, error: '送信内容が大きすぎます' };

  // Renderが寝ている時は起動に最大1分ほどかかる。全体で75秒まで粘る(読み取りだけ自動で再試行)
  const t0 = Date.now();
  const LIMIT = 75000;
  let lastErr = '';
  for (let i = 0; i < 6; i++) {
    const left = LIMIT - (Date.now() - t0);
    if (left < 3000) break;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.min(left, 60000));
    try {
      const r = await fetch(origin + p, {
        method: m,
        headers: { 'x-admin-key': key, 'content-type': 'application/json', 'user-agent': 'BroChatAdmin/' + app.getVersion() },
        body: payload,
        redirect: 'error', // 管理キーを別のURLへ持ち出さない
        signal: ctrl.signal,
      });
      if (m === 'GET' && WAKE_STATUS.has(r.status) && Date.now() - t0 < LIMIT - 6000) {
        lastErr = 'サーバーが起動中です';
        await sleep(3000);
        continue;
      }
      let data = null;
      try { data = await r.json(); } catch (e2) {}
      return { status: r.status, data, ms: Date.now() - t0 };
    } catch (err) {
      const why = String((err && err.cause && err.cause.message) || (err && err.message) || '');
      if (/redirect/i.test(why)) { lastErr = 'URLが別の場所へ転送されました。転送先のURLを入れてください'; break; }
      lastErr = err && err.name === 'AbortError' ? '時間切れです(サーバーが起動中かもしれません)' : 'サーバーに接続できません';
      if (m !== 'GET') break; // 書き込みは二重実行を避けるため再試行しない
      if (err && err.name === 'AbortError') break;
      await sleep(2000);
    } finally { clearTimeout(timer); }
  }
  return { status: 0, error: lastErr || 'サーバーに接続できません', ms: Date.now() - t0 };
});

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 820, minHeight: 540,
    backgroundColor: '#0f1115',
    title: 'Bro Chat 管理',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', ev => ev.preventDefault());
  win.webContents.on('will-attach-webview', ev => ev.preventDefault());
  win.on('closed', () => { win = null; });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  // カメラ・マイク・通知などの権限は一切出さない
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
