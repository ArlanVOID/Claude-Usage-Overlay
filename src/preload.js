const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  refresh: () => ipcRenderer.send('refresh'),
  setPaused: (v) => ipcRenderer.send('set-paused', v),
  setCompact: (v) => ipcRenderer.send('set-compact', v),
  setInterval: (v) => ipcRenderer.send('set-interval', v),
  reportHeight: (h) => ipcRenderer.send('content-height', h),
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
});
