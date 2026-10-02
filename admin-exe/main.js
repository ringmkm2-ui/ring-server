const { app, BrowserWindow, ipcMain, safeStorage, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const cfgPath = () => path.join(app.getPath('userData'), 'settings.json');

function readCfg() {
  try { return JSON.parse(fs.readFileSync(cfgPath(), 'utf8')); } catch (e) { return {}; }
}
function writeCfg(c) { fs.writeFileSync(cfgPath(), JSON.stringify(c)); }

function validUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol === 'https:') return x.origin;
    if (x.protocol === 'http:' && (x.hostname === 'localhost' || x.hostname === '127.0.0.1')) return x.origin;
  } catch (e) {}
  return null;
}

function decodeKey(c) {
  if (!c.key) return '';
  try {
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(c.key, 'base64')) : '';
  } catch (e) { return ''; }
}

ipcMain.handle('cfg:get', () => {
  const c = readCfg();
  return { url: c.url || 'https://ring-server-50sy.onrender.com', key: decodeKey(c), remember: !!c.key };
});

ipcMain.handle('cfg:save', (e, { url, key, remember }) => {
  const c = { url };
  if (remember && key && safeStorage.isEncryptionAvailable()) c.key = safeStorage.encryptString(key).toString('base64');
  writeCfg(c);
  return true;
});

ipcMain.handle('api', async (e, { url, key, method, path: p, body }) => {
  const origin = validUrl(url);
  if (!origin) return { status: 0, error: 'URLが正しくありません(https:// で始めてください)' };
  if (typeof p !== 'string' || !p.startsWith('/api/admin/')) return { status: 0, error: '不正なパスです' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000); // Renderが寝ていると起動に時間がかかる
  try {
    const r = await fetch(origin + p, {
      method: method || 'GET',
      headers: { 'x-admin-key': key, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let data = null;
    try { data = await r.json(); } catch (e2) {}
    return { status: r.status, data };
  } catch (err) {
    return { status: 0, error: err.name === 'AbortError' ? '時間切れです(サーバーが起動中かもしれません)' : 'サーバーに接続できません' };
  } finally { clearTimeout(t); }
});

function createWindow() {
  Menu.setApplicationMenu(null);
  const w = new BrowserWindow({
    width: 1100, height: 720, minWidth: 820, minHeight: 520,
    backgroundColor: '#0f1115',
    title: 'Bro Chat 管理',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', ev => ev.preventDefault());
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
