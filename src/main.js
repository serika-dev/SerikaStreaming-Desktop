const { app, BrowserWindow, ipcMain, session, shell, Menu, Tray, dialog } = require('electron');
const path = require('path');
const settingsStore = require('./settings');
const presence = require('./presence');
const { buildIcon, getIconPath } = require('./icon');
const { createExperimentsClient } = require('./experiments');

const BASE_URL = 'https://serika.moe';
const { pathToFileURL } = require('url');
const fetchWithTimeout = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
const SESSION_COOKIE_NAME = 'serika_session';
const PENDING_AUTH_COOKIE_NAME = 'serika_pending_auth';

// Set app identity for taskbar icon on Windows
app.setAppUserModelId('moe.serika.desktop');
const TV_SESSION_DURATION_SECONDS = Math.floor(6 * 30 * 24 * 60 * 60); // 6 months

let loginWindow = null;
let mainWindow = null;
let settingsWindow = null;
let tray = null;
let pendingAuthCookie = null;
let isQuitting = false;
let appIcon = null;

// ─── Single instance lock ───────────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// ─── Hardware acceleration (must run before app ready) ──────────────────────

if (settingsStore.get('hardwareAcceleration') === false) {
  app.disableHardwareAcceleration();
}
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// ─── Cookie helpers ─────────────────────────────────────────────────────────

function parseSetCookieHeaders(setCookieArray) {
  const cookies = [];
  for (const raw of setCookieArray) {
    const parts = raw.split(';').map((s) => s.trim());
    const [nameValue] = parts;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx);
    const value = nameValue.slice(eqIdx + 1);
    const cookie = { name, value };
    for (const attr of parts.slice(1)) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('max-age=')) cookie.maxAge = parseInt(attr.slice(8), 10);
      else if (lower.startsWith('path=')) cookie.path = attr.slice(6);
      else if (lower.startsWith('domain=')) cookie.domain = attr.slice(8);
      else if (lower === 'secure') cookie.secure = true;
      else if (lower === 'httponly') cookie.httpOnly = true;
      else if (lower.startsWith('samesite=')) cookie.sameSite = attr.slice(9).toLowerCase();
    }
    cookies.push(cookie);
  }
  return cookies;
}

async function setSessionCookieOnElectron(sessionId, maxAgeSeconds) {
  const expiry = Math.floor(Date.now() / 1000) + (maxAgeSeconds || TV_SESSION_DURATION_SECONDS);
  await session.defaultSession.cookies.set({
    url: BASE_URL,
    name: SESSION_COOKIE_NAME,
    value: sessionId,
    domain: '.serika.moe',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'lax',
    expirationDate: expiry,
  });
}

async function clearSessionCookie() {
  try {
    await session.defaultSession.cookies.remove(BASE_URL, SESSION_COOKIE_NAME);
  } catch {
    // ignore
  }
}

async function checkExistingSession() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: BASE_URL });
    const sessionCookie = cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    if (!sessionCookie) return false;

    const response = await fetchWithTimeout(`${BASE_URL}/api/auth/session`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie.value}` },
    });
    if (!response.ok) return false;
    const data = await response.json();
    return data.authenticated === true;
  } catch {
    return false;
  }
}

// ─── Presence control ───────────────────────────────────────────────────────

function syncPresence() {
  const enabled = settingsStore.get('discordPresence');
  const port = settingsStore.get('presencePort') || 6464;
  if (enabled && mainWindow) {
    if (!presence.isActive()) presence.start(port);
  } else if (presence.isActive()) {
    presence.stop();
  }
  updateTrayMenu();
}

// ─── Logout handling ────────────────────────────────────────────────────────

function watchForLogout() {
  const filter = { urls: [`${BASE_URL}/api/auth/logout`] };
  session.defaultSession.webRequest.onCompleted(filter, async () => {
    await clearSessionCookie();
    pendingAuthCookie = null;
    presence.stop();
    if (mainWindow) {
      mainWindow.destroy();
      mainWindow = null;
    }
    if (!loginWindow) createLoginWindow();
  });
}

// ─── Windows ────────────────────────────────────────────────────────────────

function createLoginWindow() {
  if (loginWindow) {
    loginWindow.show();
    loginWindow.focus();
    return;
  }
  loginWindow = new BrowserWindow({
    width: 520,
    height: 760,
    resizable: false,
    maximizable: false,
    title: 'Serika — Sign In',
    backgroundColor: '#050505',
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.setIcon(appIcon);
  loginWindow.loadFile(path.join(__dirname, 'login.html'));

  if (process.argv.includes('--dev')) {
    loginWindow.webContents.openDevTools({ mode: 'detach' });
  }

  loginWindow.on('closed', () => {
    loginWindow = null;
    if (!mainWindow && !isQuitting && !settingsStore.get('closeToTray')) {
      app.quit();
    }
  });
}

function createMainWindow(show = true) {
  if (mainWindow) {
    if (show) {
      mainWindow.show();
      mainWindow.focus();
    }
    if (loginWindow) loginWindow.close();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: 'Serika',
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, 'presence-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setIcon(appIcon);
  mainWindow.loadURL(BASE_URL).catch(() => {});
  mainWindow.webContents.on('did-fail-load', async (_event, code, description, _url, isMainFrame) => {
    if (!isMainFrame || code === -3 || !mainWindow) return;
    mainWindow.show();
    const result = await dialog.showMessageBox(mainWindow, { type: 'error', message: 'Unable to load Serika', detail: description, buttons: ['Retry', 'Close'], defaultId: 0 });
    if (result.response === 0 && mainWindow) mainWindow.loadURL(BASE_URL).catch(() => {});
  });
  mainWindow.webContents.on('render-process-gone', () => {
    if (mainWindow) mainWindow.reload();
  });

  mainWindow.once('ready-to-show', () => {
    const zoom = settingsStore.get('zoomFactor') || 1;
    mainWindow.webContents.setZoomFactor(zoom);
    if (show) mainWindow.show();
    if (loginWindow) loginWindow.close();
    syncPresence();
  });

  // External links → default browser; in-app navigation stays in window
  require('./navigation').installNavigationPolicy(mainWindow.webContents, {
    origin: BASE_URL,
    openExternal: url => shell.openExternal(url),
    navigate: url => mainWindow?.loadURL(url),
  });

  // Detect redirect to login/register (session expired or signed out)
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    try {
      const u = new URL(url);
      if (u.origin === BASE_URL && (u.pathname === '/login' || u.pathname === '/register')) {
        presence.stop();
        if (mainWindow) {
          mainWindow.destroy();
          mainWindow = null;
        }
        pendingAuthCookie = null;
        createLoginWindow();
      }
    } catch {
      // ignore
    }
  });

  // Minimize / close to tray
  mainWindow.on('minimize', (e) => {
    if (tray && settingsStore.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && tray && settingsStore.get('closeToTray')) {
      e.preventDefault();
      mainWindow?.hide();
      return false;
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 540,
    height: 680,
    resizable: true,
    minWidth: 480,
    minHeight: 480,
    title: 'Serika — Settings',
    backgroundColor: '#050505',
    icon: appIcon,
    parent: mainWindow || undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWindow.setIcon(appIcon);
  settingsWindow.loadFile(path.join(__dirname, 'settings.html'));
  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

// ─── Tray ───────────────────────────────────────────────────────────────────

function createTray() {
  if (tray) return;
  const trayIcon = buildIcon(process.platform === 'darwin' ? 22 : 32);
  tray = new Tray(trayIcon);
  tray.setToolTip('Serika');
  updateTrayMenu();

  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
    } else if (loginWindow) {
      loginWindow.show();
    }
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const presenceOn = settingsStore.get('discordPresence');
  const menu = Menu.buildFromTemplate([
    {
      label: 'Open Serika',
      click: () => {
        if (mainWindow) mainWindow.show();
        else if (loginWindow) loginWindow.show();
        else createMainWindow();
      },
    },
    { type: 'separator' },
    {
      label: 'Discord Presence',
      type: 'checkbox',
      checked: !!presenceOn,
      click: (item) => {
        settingsStore.set('discordPresence', item.checked);
        syncPresence();
      },
    },
    {
      label: 'Settings…',
      click: () => createSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: 'Quit Serika',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ─── Startup (login item) ───────────────────────────────────────────────────

function applyLaunchAtStartup(enabled) {
  if (process.platform === 'linux') {
    applyLinuxAutostart(enabled);
    return;
  }
  app.setLoginItemSettings({
    openAtLogin: enabled,
    openAsHidden: settingsStore.get('startMinimized'),
    args: settingsStore.get('startMinimized') ? ['--hidden'] : [],
  });
}

function applyLinuxAutostart(enabled) {
  const fs = require('fs');
  const os = require('os');
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopFile = path.join(autostartDir, 'serika-desktop.desktop');
  try {
    if (enabled) {
      fs.mkdirSync(autostartDir, { recursive: true });
      const execPath = process.env.APPIMAGE || process.execPath;
      const quotedExec = '"' + execPath.replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%') + '"';
      const hidden = settingsStore.get('startMinimized') ? ' --hidden' : '';
      const content = `[Desktop Entry]
Type=Application
Name=Serika
Exec=${quotedExec}${hidden}
X-GNOME-Autostart-enabled=true
Terminal=false
`;
      fs.writeFileSync(desktopFile, content);
    } else if (fs.existsSync(desktopFile)) {
      fs.unlinkSync(desktopFile);
    }
  } catch (e) {
    throw new Error('Could not update system startup: ' + e.message);
  }
}

const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel, (event, ...args) => {
  const senderUrl = event.senderFrame?.url;
  const allowed = ['login.html', 'settings.html'].map(name => pathToFileURL(path.join(__dirname, name)).href);
  let trustedPresenceWindow = false;
  if (channel === 'presence:update' || channel === 'presence:clear') {
    try { trustedPresenceWindow = new URL(senderUrl).origin === BASE_URL; } catch {}
  }
  if (!allowed.includes(senderUrl) && !trustedPresenceWindow) throw new Error('Untrusted window');
  return handler(event, ...args);
});
ipcMain.handle('app:restart', () => { isQuitting = true; app.relaunch(); app.quit(); });

// ─── IPC: Auth ──────────────────────────────────────────────────────────────

ipcMain.handle('auth:login', async (_event, { email, password, rememberMe }) => {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe }),
      redirect: 'manual',
    });
    const data = await response.json();
    const setCookies = response.headers.getSetCookie?.() || [];
    const parsed = parseSetCookieHeaders(setCookies);

    const pending = parsed.find((c) => c.name === PENDING_AUTH_COOKIE_NAME);
    if (pending) pendingAuthCookie = pending;

    if (response.ok && data.success === true && !data.requiresTwoFactor) {
      const sessionCookie = parsed.find((c) => c.name === SESSION_COOKIE_NAME);
      if (!sessionCookie) return { success: false, message: 'The server did not create a session. Please retry.' };
      if (sessionCookie) {
        const maxAge = sessionCookie.maxAge || (rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60);
        await setSessionCookieOnElectron(sessionCookie.value, maxAge);
      }
    }
    return response.ok ? data : { ...data, success: false };
  } catch {
    return { success: false, message: 'Network error. Check your connection and try again.' };
  }
});

ipcMain.handle('auth:verify-2fa', async (_event, { code }) => {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (pendingAuthCookie) headers['Cookie'] = `${PENDING_AUTH_COOKIE_NAME}=${pendingAuthCookie.value}`;

    const response = await fetchWithTimeout(`${BASE_URL}/api/auth/2fa/verify`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ code }),
      redirect: 'manual',
    });
    const data = await response.json();

    if (data.success !== false && response.ok) {
      const setCookies = response.headers.getSetCookie?.() || [];
      const parsed = parseSetCookieHeaders(setCookies);
      const sessionCookie = parsed.find((c) => c.name === SESSION_COOKIE_NAME);
      if (!sessionCookie) return { success: false, message: 'The server did not create a session. Please retry.' };
      if (sessionCookie) {
        const maxAge = sessionCookie.maxAge || 30 * 24 * 60 * 60;
        await setSessionCookieOnElectron(sessionCookie.value, maxAge);
      }
      pendingAuthCookie = null;
    }
    return response.ok ? data : { ...data, success: false };
  } catch {
    return { success: false, message: 'Network error. Check your connection and try again.' };
  }
});

ipcMain.handle('auth:generate-qr', async () => {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/auth/tv-link/generate`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) return { error: data.error || 'Failed to generate QR code' };

    const qrRes = await fetchWithTimeout(`${BASE_URL}/api/auth/tv-link/qr?code=${data.code}`);
    if (!qrRes.ok) return { code: data.code, expiresIn: data.expiresIn, qrDataUrl: null };
    const qrBuffer = await qrRes.arrayBuffer();
    const qrBase64 = Buffer.from(qrBuffer).toString('base64');
    return { code: data.code, expiresIn: data.expiresIn, qrDataUrl: `data:image/png;base64,${qrBase64}` };
  } catch {
    return { error: 'Network error. Check your connection and try again.' };
  }
});

ipcMain.handle('auth:poll-qr', async (_event, { code }) => {
  try {
    const response = await fetchWithTimeout(`${BASE_URL}/api/auth/tv-link/status?code=${code}`);
    const data = await response.json();
    if (response.ok && data.status === 'linked') {
      const linkedCookie = parseSetCookieHeaders(response.headers.getSetCookie?.() || []).find(cookie => cookie.name === SESSION_COOKIE_NAME);
      if (!linkedCookie) return { status: 'expired', error: 'No session received. Generate a new QR code.' };
      await setSessionCookieOnElectron(linkedCookie.value, linkedCookie.maxAge || TV_SESSION_DURATION_SECONDS);
    }
    return data;
  } catch {
    return { status: 'expired' };
  }
});

ipcMain.handle('auth:complete-login', async () => {
  if (!await checkExistingSession()) throw new Error('Sign-in session could not be verified.');
  createMainWindow();
});

ipcMain.handle('auth:check-session', async () => {
  return await checkExistingSession();
});

// ─── IPC: Settings ──────────────────────────────────────────────────────────

ipcMain.handle('settings:get', async () => {
  return settingsStore.load();
});

ipcMain.handle('settings:set', async (_event, { key, value }) => {
  settingsStore.validate(key, value);
  const previous = settingsStore.get(key);
  const updated = settingsStore.set(key, value);
  try {

  if (key === 'launchAtStartup') applyLaunchAtStartup(value);
  if (key === 'startMinimized') applyLaunchAtStartup(settingsStore.get('launchAtStartup'));
  if (key === 'discordPresence') syncPresence();
  if (key === 'presencePort') { presence.stop(); syncPresence(); }
  if (key === 'zoomFactor' && mainWindow) mainWindow.webContents.setZoomFactor(value || 1);
  if (key === 'closeToTray' || key === 'minimizeToTray') updateTrayMenu();

  return updated;
  } catch (error) { settingsStore.set(key, previous); throw error; }
});

// ─── IPC: A/B tests (for login.html and settings.html; the site handles its own) ─

let experimentsClient = null;
const getExperimentsClient = () => (experimentsClient ??= createExperimentsClient({
  baseUrl: BASE_URL,
  cookies: session.defaultSession.cookies,
  fetch: fetchWithTimeout,
}));

ipcMain.handle('experiments:get', () => getExperimentsClient().get());
ipcMain.handle('experiments:expose', (_event, { keys }) => getExperimentsClient().expose(keys));
ipcMain.handle('experiments:track', (_event, { goal, value }) => getExperimentsClient().track(goal, value));

ipcMain.handle('settings:status', async () => {
  return {
    presenceActive: presence.isActive(),
    discordConnected: presence.isDiscordConnected(),
  };
});

function isTrustedMainFrame(event) {
  try {
    return new URL(event.senderFrame.url).origin === BASE_URL;
  } catch {
    return false;
  }
}

ipcMain.handle('presence:update', async (event, activity) => {
  if (!isTrustedMainFrame(event) || !activity || typeof activity !== 'object') return false;
  const clean = {
    details: String(activity.details || '').slice(0, 128),
    state: String(activity.state || '').slice(0, 128),
    posterUrl: typeof activity.posterUrl === 'string' && /^https:\/\//.test(activity.posterUrl) ? activity.posterUrl : null,
    progressSeconds: Math.max(0, Number(activity.progressSeconds) || 0),
    durationSeconds: Math.max(0, Number(activity.durationSeconds) || 0),
    isPaused: activity.isPaused === true,
  };
  return presence.update(clean);
});

ipcMain.handle('presence:clear', async (event) => {
  if (!isTrustedMainFrame(event)) return false;
  presence.clear();
  return true;
});

// ─── App lifecycle ──────────────────────────────────────────────────────────

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else if (loginWindow) {
    loginWindow.show();
    loginWindow.focus();
  }
});

app.whenReady().then(async () => {
  // Signed-out A/B test bucketing: one device id for the site and this app's own pages.
  getExperimentsClient().ensureDeviceId().catch(() => undefined);
  // On Linux, use the file path directly — nativeImage resize can fail or produce empty images
  if (process.platform === 'linux') {
    const iconPath = getIconPath();
    appIcon = iconPath || buildIcon(256);
  } else {
    appIcon = buildIcon(256);
  }

  const settingsItem = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: createSettingsWindow };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [{ role: 'about' }, settingsItem, { type: 'separator' }, { role: 'quit' }] }] : [{ label: 'Serika', submenu: [settingsItem, { role: 'quit' }] }]),
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }] },
    { role: 'windowMenu' },
  ]));
  try { createTray(); } catch (error) { tray = null; console.warn('Tray unavailable:', error.message); }
  watchForLogout();

  const startHidden = Boolean(tray) && (process.argv.includes('--hidden') || settingsStore.get('startMinimized'));
  const isLoggedIn = await checkExistingSession();

  if (isLoggedIn) {
    createMainWindow(!startHidden);
  } else {
    createLoginWindow();
  }
});

app.on('window-all-closed', () => {
  if (!settingsStore.get('closeToTray') && process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  presence.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    checkExistingSession().then((ok) => {
      if (ok) createMainWindow();
      else createLoginWindow();
    });
  } else if (mainWindow) {
    mainWindow.show();
  }
});
