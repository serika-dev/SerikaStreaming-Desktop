const { app, BrowserWindow, ipcMain, session, shell, Menu } = require('electron');
const path = require('path');

const BASE_URL = 'https://serika.moe';
const SESSION_COOKIE_NAME = 'serika_session';
const PENDING_AUTH_COOKIE_NAME = 'serika_pending_auth';
const TV_SESSION_DURATION_SECONDS = Math.floor(6 * 30 * 24 * 60 * 60); // 6 months

let loginWindow = null;
let mainWindow = null;
let pendingAuthCookie = null;

// ─── Helpers ──────────────────────────────────────────────────────────────

function parseSetCookieHeaders(setCookieArray) {
  const cookies = [];
  for (const raw of setCookieArray) {
    const parts = raw.split(';').map(s => s.trim());
    const [nameValue] = parts;
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx);
    const value = nameValue.slice(eqIdx + 1);
    const cookie = { name, value };
    for (const attr of parts.slice(1)) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('max-age=')) {
        cookie.maxAge = parseInt(attr.slice(8), 10);
      } else if (lower.startsWith('path=')) {
        cookie.path = attr.slice(6);
      } else if (lower.startsWith('domain=')) {
        cookie.domain = attr.slice(8);
      } else if (lower === 'secure') {
        cookie.secure = true;
      } else if (lower === 'httponly') {
        cookie.httpOnly = true;
      } else if (lower.startsWith('samesite=')) {
        cookie.sameSite = attr.slice(9).toLowerCase();
      }
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

async function checkExistingSession() {
  try {
    const cookies = await session.defaultSession.cookies.get({ url: BASE_URL });
    const sessionCookie = cookies.find(c => c.name === SESSION_COOKIE_NAME);
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

// ─── Window creation ──────────────────────────────────────────────────────

function createLoginWindow() {
  loginWindow = new BrowserWindow({
    width: 520,
    height: 720,
    resizable: false,
    maximizable: false,
    title: 'Serika — Sign In',
    backgroundColor: '#050505',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  loginWindow.loadFile(path.join(__dirname, 'login.html'));

  if (process.argv.includes('--dev')) {
    loginWindow.webContents.openDevTools({ mode: 'detach' });
  }

  loginWindow.on('closed', () => {
    loginWindow = null;
    if (!mainWindow) {
      app.quit();
    }
  });
}

function createMainWindow() {
  if (mainWindow) {
    mainWindow.show();
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
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(BASE_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (loginWindow) loginWindow.close();
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(BASE_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Detect redirect to login page (session expired)
  mainWindow.webContents.on('did-navigate', (_event, url) => {
    if (url.includes('/login') || url.includes('/register')) {
      mainWindow.hide();
      pendingAuthCookie = null;
      createLoginWindow();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });
}

// ─── IPC: Password login ──────────────────────────────────────────────────

ipcMain.handle('auth:login', async (_event, { email, password, rememberMe }) => {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, rememberMe }),
      redirect: 'manual',
    });

    const data = await response.json();

    // Capture set-cookie headers
    const setCookies = response.headers.getSetCookie?.() || [];
    const parsed = parseSetCookieHeaders(setCookies);

    // Store pending auth cookie for 2FA flow
    const pending = parsed.find(c => c.name === PENDING_AUTH_COOKIE_NAME);
    if (pending) {
      pendingAuthCookie = pending;
    }

    // If login succeeded (no 2FA), set the session cookie
    if (data.success && !data.requiresTwoFactor) {
      const sessionCookie = parsed.find(c => c.name === SESSION_COOKIE_NAME);
      if (sessionCookie) {
        const maxAge = sessionCookie.maxAge || (rememberMe ? 30 * 24 * 60 * 60 : 24 * 60 * 60);
        await setSessionCookieOnElectron(sessionCookie.value, maxAge);
      }
    }

    return data;
  } catch (err) {
    return { success: false, message: 'Network error. Check your connection and try again.' };
  }
});

// ─── IPC: 2FA verify ──────────────────────────────────────────────────────

ipcMain.handle('auth:verify-2fa', async (_event, { code }) => {
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (pendingAuthCookie) {
      headers['Cookie'] = `${PENDING_AUTH_COOKIE_NAME}=${pendingAuthCookie.value}`;
    }

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
      const sessionCookie = parsed.find(c => c.name === SESSION_COOKIE_NAME);
      if (sessionCookie) {
        const maxAge = sessionCookie.maxAge || 30 * 24 * 60 * 60;
        await setSessionCookieOnElectron(sessionCookie.value, maxAge);
      }
      pendingAuthCookie = null;
    }

    return data;
  } catch (err) {
    return { success: false, message: 'Network error. Check your connection and try again.' };
  }
});

// ─── IPC: QR login ────────────────────────────────────────────────────────

ipcMain.handle('auth:generate-qr', async () => {
  try {
    const response = await fetch(`${BASE_URL}/api/auth/tv-link/generate`, {
      method: 'POST',
    });
    const data = await response.json();
    if (!response.ok) {
      return { error: data.error || 'Failed to generate QR code' };
    }

    // Fetch the QR code image as a data URL
    const qrRes = await fetch(`${BASE_URL}/api/auth/tv-link/qr?code=${data.code}`);
    if (!qrRes.ok) {
      return { code: data.code, expiresIn: data.expiresIn, qrDataUrl: null };
    }
    const qrBuffer = await qrRes.arrayBuffer();
    const qrBase64 = Buffer.from(qrBuffer).toString('base64');
    return {
      code: data.code,
      expiresIn: data.expiresIn,
      qrDataUrl: `data:image/png;base64,${qrBase64}`,
    };
  } catch (err) {
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
  } catch (err) {
    return { status: 'expired' };
  }
});

// ─── IPC: Complete login (open main window) ───────────────────────────────

ipcMain.handle('auth:complete-login', async () => {
  createMainWindow();
});

// ─── IPC: Check existing session ──────────────────────────────────────────

ipcMain.handle('auth:check-session', async () => {
  return await checkExistingSession();
});

// ─── App lifecycle ────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Minimal menu (hide menu bar on Windows/Linux, keep on macOS)
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu', submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'quit' },
        ]},
        { role: 'editMenu' },
        { role: 'windowMenu' },
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  const isLoggedIn = await checkExistingSession();
  if (isLoggedIn) {
    createMainWindow();
  } else {
    createLoginWindow();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    checkExistingSession().then(ok => {
      if (ok) createMainWindow();
      else createLoginWindow();
    });
  }
});
