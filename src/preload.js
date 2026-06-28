const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('serika', {
  login: (email, password, rememberMe) =>
    ipcRenderer.invoke('auth:login', { email, password, rememberMe }),

  verify2FA: (code) =>
    ipcRenderer.invoke('auth:verify-2fa', { code }),

  generateQR: () =>
    ipcRenderer.invoke('auth:generate-qr'),

  pollQR: (code) =>
    ipcRenderer.invoke('auth:poll-qr', { code }),

  completeLogin: () =>
    ipcRenderer.invoke('auth:complete-login'),

  checkSession: () =>
    ipcRenderer.invoke('auth:check-session'),

  // Settings
  getSettings: () =>
    ipcRenderer.invoke('settings:get'),

  setSetting: (key, value) =>
    ipcRenderer.invoke('settings:set', { key, value }),

  getStatus: () =>
    ipcRenderer.invoke('settings:status'),
});
