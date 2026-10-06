// ページ側に「デスクトップ版で動いている」ことだけを伝える。Node.jsの機能は一切渡さない
const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('BroDesktop', { isDesktop: true, platform: process.platform });
