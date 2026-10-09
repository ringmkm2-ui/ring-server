// Bro Chat デスクトップ版
// サーバーのページをそのままウィンドウで開く。中身(画面・機能)はサーバー側にあるので、
// サーバーを更新すればこのexeを作り直さなくても最新になる。
// 幅900px以上では、トーク一覧とチャットが左右に並ぶPC用レイアウトになる。
const { app, BrowserWindow, Menu, Tray, shell, session, nativeTheme, nativeImage, desktopCapturer, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_URL = process.env.BROCHAT_URL || 'https://ring-server-50sy.onrender.com';
const APP_ORIGIN = new URL(APP_URL).origin;
const ICON = path.join(__dirname, 'assets', 'icon.png');

// Windowsの通知に「Bro Chat」と出すため(インストーラーのショートカットと同じID)
app.setAppUserModelId('com.brochat.desktop');

// 2つ目を起動したら、新しく開かずに今のウィンドウを前に出す
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null;
let tray = null;
let quitting = false;

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch (e) { return null; }
}
function saveBounds() {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...win.getNormalBounds(), max: win.isMaximized() })); } catch (e) {}
}

const sameOrigin = (u) => { try { return new URL(u).origin === APP_ORIGIN; } catch (e) { return false; } };
const openOutside = (u) => {
  try { const p = new URL(u).protocol; if (p === 'https:' || p === 'http:' || p === 'mailto:') shell.openExternal(u); } catch (e) {}
};

function showWindow() {
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  const b = loadBounds();
  win = new BrowserWindow({
    // 最初からPC用レイアウト(900px以上)で開く
    width: (b && b.width) || 1280,
    height: (b && b.height) || 820,
    x: b ? b.x : undefined,
    y: b ? b.y : undefined,
    minWidth: 420,
    minHeight: 560,
    title: 'Bro Chat',
    icon: ICON,
    autoHideMenuBar: true,
    // 読み込み中に白や黒が一瞬出ないよう、アプリの背景色で待つ
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#15181f' : '#e0f2fe',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // 閉じてトレイにいる間も、WebSocketとタイマーを止めない(新着や着信を受けるため)
      backgroundThrottling: false,
    },
  });
  if (b && b.max) win.maximize();

  // サーバー側でデスクトップ版を見分けられるように(Googleログインをブラウザ経由にする判定に使う)
  win.webContents.setUserAgent(win.webContents.getUserAgent() + ' BroChatDesktop/' + app.getVersion());

  // Bro Chat以外のページは、アプリの中で開かずに普段のブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (sameOrigin(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        width: 1000, height: 760, icon: ICON, autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      } };
    }
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) { e.preventDefault(); openOutside(url); }
  });

  win.once('ready-to-show', () => win.show());
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  // ×で閉じてもトレイに残す(新着を受け取り続ける)。終了はトレイのメニューから
  win.on('close', (e) => {
    saveBounds();
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  // サーバーが寝ていた等で読み込めなかった時は、少し待ってやり直す
  win.webContents.on('did-fail-load', (e, code, desc, url, isMain) => {
    if (isMain && code !== -3) setTimeout(() => { if (win && !win.isDestroyed()) win.loadURL(APP_URL); }, 4000);
  });

  win.loadURL(APP_URL);
}

function createTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 });
  tray = new Tray(img);
  tray.setToolTip('Bro Chat');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Bro Chat を開く', click: showWindow },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });

app.whenReady().then(() => {
  // カメラ・マイク(通話)、通知、クリップボードは Bro Chat のページにだけ許可する
  const ALLOW = new Set(['media', 'notifications', 'clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'mediaKeySystem', 'display-capture']);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    cb(ALLOW.has(perm) && sameOrigin(details.requestingUrl || wc.getURL()));
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin) => ALLOW.has(perm) && origin === APP_ORIGIN);

  // ライブ配信の画面共有。Electronはブラウザと違って選ぶ画面を自分で出す必要がある(無いと共有が失敗する)
  session.defaultSession.setDisplayMediaRequestHandler(async (req, cb) => {
    try {
      if (!sameOrigin(req.securityOrigin || (req.frame && req.frame.url) || '')) return cb({});
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
      const list = sources.filter(s => s.name && !/^Bro Chat$/.test(s.name)).slice(0, 10);
      if (!list.length) return cb({});
      const labels = list.map((s, i) => (s.id.startsWith('screen:') ? '画面全体' + (list.filter(x => x.id.startsWith('screen:')).length > 1 ? ' ' + (i + 1) : '') : s.name.slice(0, 40)));
      const { response } = await dialog.showMessageBox(win, {
        type: 'none', title: '画面共有', message: 'どこを共有しますか?',
        buttons: [...labels, 'やめる'], cancelId: labels.length, noLink: true,
      });
      if (response >= list.length) return cb({});
      // 画面全体のときはPCの音も一緒に送る(Windowsのみ)
      cb(list[response].id.startsWith('screen:') && process.platform === 'win32' ? { video: list[response], audio: 'loopback' } : { video: list[response] });
    } catch (e) { cb({}); }
  });

  // メニューバーは出さないが、再読み込み・拡大縮小・全画面のショートカットは使えるようにする
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '表示', submenu: [
      { role: 'reload', label: '再読み込み' },
      { role: 'forceReload', label: '強制再読み込み' },
      { type: 'separator' },
      { role: 'resetZoom', label: '実際のサイズ' },
      { role: 'zoomIn', label: '拡大' },
      { role: 'zoomOut', label: '縮小' },
      { type: 'separator' },
      { role: 'togglefullscreen', label: '全画面' },
    ] },
    { label: '編集', submenu: [
      { role: 'undo', label: '元に戻す' }, { role: 'redo', label: 'やり直す' }, { type: 'separator' },
      { role: 'cut', label: '切り取り' }, { role: 'copy', label: 'コピー' }, { role: 'paste', label: '貼り付け' },
      { role: 'selectAll', label: 'すべて選択' },
    ] },
  ]));

  createTray();
  createWindow();
});

// 全部のウィンドウを閉じても終了しない(トレイに残る)
app.on('window-all-closed', () => {});
