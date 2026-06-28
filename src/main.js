const { app, BrowserWindow, ipcMain, session, shell, Menu, Tray } = require('electron');
const path = require('path');
const settingsStore = require('./settings');
const presence = require('./presence');
const { buildIcon } = require('./icon');

const BASE_URL = 'https://serika.moe';
const SESSION_COOKIE_NAME = 'serika_session';
const PENDING_AUTH_COOKIE_NAME = 'serika_pending_auth';

// Set WM_CLASS on Linux so taskbar shows our icon instead of Electron's
if (process.platform === 'linux') {
  app.setAppUserModelId('moe.serika.desktop');
}
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

    const response = await fetch(`${BASE_URL}/api/auth/session`, {
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
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setIcon(appIcon);
  mainWindow.loadURL(BASE_URL);

  mainWindow.once('ready-to-show', () => {
    const zoom = settingsStore.get('zoomFactor') || 1;
    mainWindow.webContents.setZoomFactor(zoom);
    if (show) mainWindow.show();
    if (loginWindow) loginWindow.close();
    syncPresence();
  });

  // External links → default browser; in-app navigation stays in window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE_URL)) {
      mainWindow.loadURL(url);
    } else if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Detect redirect to login/register (session expired or signed out)
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    try {
      const u = new URL(url);
      if (u.hostname.endsWith('serika.moe') && (u.pathname === '/login' || u.pathname === '/register')) {
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
    if (settingsStore.get('minimizeToTray')) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting && settingsStore.get('closeToTray')) {
      e.preventDefault();
      mainWindow.hide();
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
    resizable: false,
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
      const execPath = process.execPath;
      const hidden = settingsStore.get('startMinimized') ? ' --hidden' : '';
      const content = `[Desktop Entry]
Type=Application
Name=Serika
Exec=${execPath}${hidden}
X-GNOME-Autostart-enabled=true
Terminal=false
`;
      fs.writeFileSync(desktopFile, content);
    } else if (fs.existsSync(desktopFile)) {
      fs.unlinkSync(desktopFile);
    }
  } catch (e) {
    console.error('[autostart]', e.message);
  }
}

// ─── IPC: Auth ──────────────────────────────────────────────────────────────

ipcMain.handle('auth:login', async (_event, { email, password, rememberMe }) => {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
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

    if (data.success && !data.requiresTwoFactor) {
      const sessionCookie = parsed.find((c) => c.name === SESSION_COOKIE_NAME);
      if (sessionCookie) {
        const maxAge = sessionCookie.maxAge || (rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60);
        await setSessionCookieOnElectron(sessionCookie.value, maxAge);
      }
    }
    return data;
  } catch {
    return { success: false, message: 'Network error. Check your connection and try again.' };
  }
});

ipcMain.handle('auth:verify-2fa', async (_event, { code }) => {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (pendingAuthCookie) headers['Cookie'] = `${PENDING_AUTH_COOKIE_NAME}=${pendingAuthCookie.value}`;

    const response = await fetch(`${BASE_URL}/api/auth/2fa/verify`, {
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
      if (sessionCookie) {
        const maxAge = sessionCookie.maxAge || 30 * 24 * 60 * 60;
        await setSessionCookieOnElectron(sessionCookie.value, maxAge);
      }
      pendingAuthCookie = null;
    }
    return data;
  } catch {
    return { success: false, message: 'Network error. Check your connection and try again.' };
  }
});

ipcMain.handle('auth:generate-qr', async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/tv-link/generate`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) return { error: data.error || 'Failed to generate QR code' };

    const qrRes = await fetch(`${BASE_URL}/api/auth/tv-link/qr?code=${data.code}`);
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
    const response = await fetch(`${BASE_URL}/api/auth/tv-link/status?code=${code}`);
    const data = await response.json();
    if (data.status === 'linked' && data.sessionId) {
      await setSessionCookieOnElectron(data.sessionId, TV_SESSION_DURATION_SECONDS);
    }
    return data;
  } catch {
    return { status: 'expired' };
  }
});

ipcMain.handle('auth:complete-login', async () => {
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
  const updated = settingsStore.set(key, value);

  if (key === 'launchAtStartup') applyLaunchAtStartup(value);
  if (key === 'startMinimized') applyLaunchAtStartup(settingsStore.get('launchAtStartup'));
  if (key === 'discordPresence') syncPresence();
  if (key === 'zoomFactor' && mainWindow) mainWindow.webContents.setZoomFactor(value || 1);
  if (key === 'closeToTray' || key === 'minimizeToTray') updateTrayMenu();

  return updated;
});

ipcMain.handle('settings:status', async () => {
  return {
    presenceActive: presence.isActive(),
    discordConnected: presence.isDiscordConnected(),
  };
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
  appIcon = buildIcon(256);

  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  createTray();
  watchForLogout();

  const startHidden = process.argv.includes('--hidden') || settingsStore.get('startMinimized');
  const isLoggedIn = await checkExistingSession();

  if (isLoggedIn) {
    createMainWindow(!startHidden);
  } else if (!startHidden) {
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
