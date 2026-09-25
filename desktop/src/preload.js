const { contextBridge, ipcRenderer } = require('electron');

const desktop = {
  onStatus: (callback) => {
    const listener = (_event, message) => callback(message);
    ipcRenderer.on('sidecar:status', listener);
    return () => ipcRenderer.removeListener('sidecar:status', listener);
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setStartupMode: (mode) => ipcRenderer.invoke('settings:set-startup-mode', mode),
  log: (level, category, message, data) =>
    ipcRenderer.invoke('log:append', { level, category, message, data }),
};

contextBridge.exposeInMainWorld('desktop', desktop);
contextBridge.exposeInMainWorld('app', {
  logs: {
    append: (message) => ipcRenderer.invoke('log:append', message),
  },
});
