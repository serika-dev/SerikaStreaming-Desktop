/**
 * Serika Desktop — Discord Rich Presence module
 *
 * Ports the standalone runner's Discord IPC + local update server into the
 * Electron main process. The serika.moe player (running inside the app) POSTs
 * watch activity to http://127.0.0.1:<port>/update, which we forward to Discord.
 *
 * When this module is active it writes a lock file at ~/.serika-presence/desktop.lock
 * and stops any standalone runner so the two never fight over the port.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const { execSync } = require('child_process');

const DISCORD_CLIENT_ID = '1467855257928335512';
const BASE_URL = 'https://serika.moe';

const PRESENCE_DIR = path.join(os.homedir(), '.serika-presence');
const RUNNER_PID_FILE = path.join(PRESENCE_DIR, 'runner.pid');
const DESKTOP_LOCK_FILE = path.join(PRESENCE_DIR, 'desktop.lock');

let ipcSocket = null;
let isConnected = false;
let localServer = null;
let reconnectTimer = null;
let clearTimer = null;
let started = false;
let logFn = (msg) => console.log(`[presence] ${msg}`);

// ─── Discord IPC (native, no deps) ──────────────────────────────────────────

function getIPCPath(id) {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\discord-ipc-' + id;
  }
  const prefix =
    process.env.XDG_RUNTIME_DIR ||
    process.env.TMPDIR ||
    process.env.TMP ||
    process.env.TEMP ||
    '/tmp';
  return path.join(prefix, 'discord-ipc-' + id);
}

function encodeIPC(opcode, data) {
  const jsonStr = JSON.stringify(data);
  const len = Buffer.byteLength(jsonStr);
  const packet = Buffer.alloc(8 + len);
  packet.writeUInt32LE(opcode, 0);
  packet.writeUInt32LE(len, 4);
  packet.write(jsonStr, 8);
  return packet;
}

function decodeIPC(buffer) {
  if (buffer.length < 8) return null;
  const opcode = buffer.readUInt32LE(0);
  const length = buffer.readUInt32LE(4);
  if (buffer.length < 8 + length) return null;
  const data = JSON.parse(buffer.slice(8, 8 + length).toString());
  return { opcode, data, rest: buffer.slice(8 + length) };
}

function tryConnect(pipePath) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = net.createConnection(pipePath, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve(null);
    }, 2000);
    socket.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
  });
}

function waitForReady(socket) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; cleanup(); resolve(null); }
    }, 5000);

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let msg;
      while ((msg = decodeIPC(buf)) !== null) {
        buf = msg.rest;
        if (msg.opcode === 1 && msg.data.evt === 'READY' && !settled) {
          settled = true;
          cleanup();
          resolve({ user: msg.data.data.user, leftoverBuf: buf });
        }
      }
    };

    const onClose = () => {
      if (!settled) { settled = true; cleanup(); resolve(null); }
    };

    const onError = () => {
      if (!settled) { settled = true; cleanup(); resolve(null); }
    };

    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.removeListener('error', onError);
    }

    socket.on('data', onData);
    socket.on('close', onClose);
    socket.on('error', onError);

    socket.write(encodeIPC(0, { v: 1, client_id: DISCORD_CLIENT_ID }));
  });
}

async function connectDiscord() {
  if (!started) return;
  logFn('Connecting to Discord...');

  for (let id = 0; id < 10; id++) {
    const paths = [getIPCPath(id)];
    if (process.platform !== 'win32') {
      const rd = process.env.XDG_RUNTIME_DIR;
      if (rd) {
        paths.push(path.join(rd, 'snap.discord', 'discord-ipc-' + id));
        paths.push(path.join(rd, 'app', 'com.discordapp.Discord', 'discord-ipc-' + id));
      }
    }

    for (const pipePath of paths) {
      const socket = await tryConnect(pipePath);
      if (!socket) continue;

      const result = await waitForReady(socket);
      if (!result) {
        try { socket.destroy(); } catch {}
        continue;
      }

      ipcSocket = socket;
      isConnected = true;
      logFn('Connected to Discord as ' + result.user.username);

      let buf = result.leftoverBuf;
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        let msg;
        while ((msg = decodeIPC(buf)) !== null) {
          buf = msg.rest;
        }
      });

      socket.on('close', () => {
        isConnected = false;
        ipcSocket = null;
        if (started) {
          logFn('Discord disconnected, retrying in 60s...');
          reconnectTimer = setTimeout(connectDiscord, 60000);
        }
      });

      socket.on('error', () => {
        isConnected = false;
        ipcSocket = null;
      });

      return true;
    }
  }

  logFn('Discord not found. Retrying in 60s...');
  reconnectTimer = setTimeout(connectDiscord, 60000);
  return false;
}

// ─── Presence formatting ────────────────────────────────────────────────────

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateDiscordPresence(data) {
  if (!isConnected || !ipcSocket) return;

  try {
    const nonce = Math.random().toString(36).substring(2) + Date.now().toString(36);

    if (!data) {
      ipcSocket.write(
        encodeIPC(1, {
          cmd: 'SET_ACTIVITY',
          args: {
            pid: process.pid,
            activity: {
              details: 'Browsing Serika',
              state: 'Looking for something to watch',
              assets: { large_image: 'serika_logo', large_text: 'Serika' },
              buttons: [{ label: 'Watch on Serika', url: BASE_URL }],
            },
          },
          nonce,
        })
      );
      return;
    }

    const { details, state, posterUrl, progressSeconds, durationSeconds, isPaused } = data;

    let safeProgress = progressSeconds;
    if (durationSeconds > 0 && safeProgress > durationSeconds) {
      safeProgress = durationSeconds;
    }

    const progress = durationSeconds
      ? `${formatTime(safeProgress)} / ${formatTime(durationSeconds)}`
      : formatTime(safeProgress);

    const activity = {
      details: String(details || 'Watching').substring(0, 128),
      state: String(state || 'Watching').substring(0, 128),
      assets: {
        large_image: posterUrl || 'serika_logo',
        large_text: String(details || 'Serika').substring(0, 128),
      },
      buttons: [{ label: 'Watch on Serika', url: BASE_URL }],
    };

    if (isPaused) {
      activity.assets.small_image = 'paused';
      activity.assets.small_text = 'Paused at ' + progress;
      activity.state = 'Paused';
    } else {
      activity.assets.small_image = 'playing';
      activity.assets.small_text = progress;
      activity.timestamps = { start: Math.floor(Date.now() / 1000) - safeProgress };
    }

    ipcSocket.write(
      encodeIPC(1, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity },
        nonce,
      })
    );
  } catch {
    // ignore
  }
}

function clearDiscordPresence() {
  if (!isConnected || !ipcSocket) return;
  try {
    const nonce = Math.random().toString(36).substring(2);
    ipcSocket.write(
      encodeIPC(1, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null },
        nonce,
      })
    );
  } catch {
    // ignore
  }
}

// ─── Local update server (receives POSTs from the in-app player) ────────────

function startLocalServer(port) {
  localServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'POST' && req.url === '/update') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          updateDiscordPresence(data);
          // If no further updates within 30s, clear the presence (stopped watching)
          if (clearTimer) clearTimeout(clearTimer);
          clearTimer = setTimeout(() => updateDiscordPresence(null), 30000);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  localServer.on('error', (e) => {
    logFn(`Local server error: ${e.message}`);
  });

  localServer.listen(port, '127.0.0.1', () => {
    logFn(`Local update server listening on 127.0.0.1:${port}`);
  });
}

// ─── Standalone runner coordination ─────────────────────────────────────────

function stopStandaloneRunner() {
  try {
    if (!fs.existsSync(RUNNER_PID_FILE)) return;
    const pid = parseInt(fs.readFileSync(RUNNER_PID_FILE, 'utf8'), 10);
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGINT');
      }
      logFn(`Stopped standalone runner (PID ${pid}) — desktop app takes over.`);
    } catch {
      // already gone
    }
    try {
      fs.unlinkSync(RUNNER_PID_FILE);
    } catch {}
  } catch {
    // ignore
  }
}

function writeLock() {
  try {
    fs.mkdirSync(PRESENCE_DIR, { recursive: true });
    fs.writeFileSync(DESKTOP_LOCK_FILE, String(process.pid));
  } catch {
    // ignore
  }
}

function removeLock() {
  try {
    if (fs.existsSync(DESKTOP_LOCK_FILE)) fs.unlinkSync(DESKTOP_LOCK_FILE);
  } catch {
    // ignore
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

function start(port = 6464, log) {
  if (started) return;
  if (log) logFn = log;
  started = true;

  // Defer the old background runner to the desktop app
  stopStandaloneRunner();
  writeLock();

  startLocalServer(port);
  connectDiscord();
  logFn('Discord presence enabled.');
}

function stop() {
  if (!started) return;
  started = false;

  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (clearTimer) clearTimeout(clearTimer);

  clearDiscordPresence();

  if (ipcSocket) {
    try {
      ipcSocket.destroy();
    } catch {}
    ipcSocket = null;
  }
  isConnected = false;

  if (localServer) {
    try {
      localServer.close();
    } catch {}
    localServer = null;
  }

  removeLock();
  logFn('Discord presence disabled.');
}

function isActive() {
  return started;
}

function isDiscordConnected() {
  return isConnected;
}

module.exports = { start, stop, isActive, isDiscordConnected, removeLock };
