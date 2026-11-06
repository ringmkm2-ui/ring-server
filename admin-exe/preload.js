const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('admin', {
  getCfg: () => ipcRenderer.invoke('cfg:get'),
  saveCfg: c => ipcRenderer.invoke('cfg:save', c),
  api: r => ipcRenderer.invoke('api', r),
  getInfo: () => ipcRenderer.invoke('info'),
  copy: t => ipcRenderer.invoke('clip:write', t),
});
