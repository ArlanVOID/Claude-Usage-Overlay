const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onAgentAlert: (cb) => ipcRenderer.on('agent-alert', (_e, chime) => cb(chime)),
  dismissAgent: (id) => ipcRenderer.send('dismiss-agent', id),
  refresh: () => ipcRenderer.send('refresh'),
  setPaused: (v) => ipcRenderer.send('set-paused', v),
  setCompact: (v) => ipcRenderer.send('set-compact', v),
  setInterval: (v) => ipcRenderer.send('set-interval', v),
  reportHeight: (h) => ipcRenderer.send('content-height', h),
  hide: () => ipcRenderer.send('hide'),
  quit: () => ipcRenderer.send('quit'),
});
