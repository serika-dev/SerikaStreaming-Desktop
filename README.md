<h1 align="center">Serika Desktop</h1>

<p align="center">
  A real, cross-platform desktop app for <a href="https://serika.moe">serika.moe</a> streaming.
  <br>
  Electron · Bun · Windows · Linux · macOS
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#system-tray--background-mode">Tray Mode</a> ·
  <a href="#discord-rich-presence">Discord Presence</a> ·
  <a href="#settings">Settings</a> ·
  <a href="#building--releasing">Building</a>
</p>

---

## Features

- **QR Login** — Scan a QR code with your phone to sign in (uses the existing TV-link system)
- **Password Login** — Email + password, with full 2FA support (TOTP / backup codes)
- **Session Persistence** — Stay logged in across app restarts
- **Native Desktop Window** — Proper window chrome, tray integration, and lifecycle
- **Run in the Background** — Close or minimize to the system tray, start automatically on login
- **Discord Rich Presence** — Show your current Serika watch activity on Discord directly from the desktop app
- **Configurable Settings** — Zoom level, startup behavior, tray options, and hardware acceleration toggle
- **Single Instance** — Only one app instance runs at a time
- **Auto-Play Media** — Browser media policy configured for smooth streaming

---

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) 1.1 or newer

### Install & run

```bash
cd desktop
bun install
bun start
```

### Development mode

```bash
bun run dev
```

This opens DevTools and runs with the `--dev` flag for easier debugging.

### Linux sandbox note

If you see a sandbox error on Linux, the dev scripts automatically use `--no-sandbox` to work around it. To run with proper sandboxing once, run:

```bash
bun run fix:sandbox   # requires sudo, sets chrome-sandbox permissions
bun run start         # will use sandbox after that
```

Packaged builds handle this correctly.

---

## Authentication

### QR Login

1. The app calls `POST /api/auth/tv-link/generate` to get a unique 7-character code.
2. The QR code is shown. It encodes `https://serika.moe/settings?tv-code=CODE`.
3. Scan the QR code on your phone (you must be logged in on mobile browser).
4. The app polls `GET /api/auth/tv-link/status?code=CODE`.
5. Once the code is linked, the app receives a session ID and opens the main window.

### Password Login

1. The app calls `POST /api/auth/login` with `{ email, password, rememberMe }`.
2. If 2FA is required, the app shows a 2FA verification screen and calls `POST /api/auth/2fa/verify`.
3. The session cookie is captured from the response and set on the Electron session.
4. The main window opens with `https://serika.moe`.

### Sign out

When you sign out in the app, the desktop app intercepts the logout request, clears the `serika_session` cookie, and immediately returns you to the login window. If you were running Discord presence, it is also stopped automatically.

---

## System Tray & Background Mode

Serika Desktop is designed to live in your system tray.

### Tray icon menu

Right-click the tray icon to access:

- **Open Serika** — Restore the main window from the tray
- **Discord Presence** — Toggle Rich Presence on or off
- **Settings** — Open the desktop settings panel
- **Quit Serika** — Fully exit the app and stop the background process

### Background behavior

- **Close to tray** — Closing the window keeps the app running in the background
- **Minimize to tray** — Minimizing hides the window to the tray instead of the taskbar
- **Launch at startup** — Start automatically when you log in (Windows login item / Linux autostart / macOS login item)
- **Start minimized** — Launch hidden directly to the tray

You can change all of these from **Settings**.

---

## Discord Rich Presence

Discord Rich Presence is built into the desktop app. When you watch something on `serika.moe` inside the app, your Discord status updates with the title, episode, progress, and play/pause state.

### How it works

- The desktop app starts a local HTTP server on `127.0.0.1:6464`.
- The Serika video player inside the app sends play/pause/seek updates to this local server.
- The desktop app forwards those updates to Discord via native IPC (no external dependencies).
- When you stop watching, the presence clears automatically after a short timeout.

### Standalone runner compatibility

If you previously installed the standalone `serika-presence` background runner, the desktop app will automatically:

1. Stop the standalone runner when the desktop app starts
2. Write a `~/.serika-presence/desktop.lock` file so the runner knows to stay down
3. Resume the standalone runner after the desktop app exits

The standalone runner has been updated to detect this lock file and defer to the desktop app, so the two never fight over port `6464` or the Discord IPC connection.

---

## Settings

Open the settings panel from the tray icon or from the **Settings** menu. Available options:

| Setting | Description |
| --- | --- |
| **Enable Discord Rich Presence** | Turn Discord status sharing on/off |
| **Launch at system startup** | Start Serika automatically when you log in |
| **Start minimized to tray** | Launch hidden in the background |
| **Close to tray** | Keep running when the main window is closed |
| **Minimize to tray** | Hide to the tray instead of the taskbar when minimized |
| **Zoom level** | Scale the entire interface from 70% to 150% |
| **Hardware acceleration** | Toggle Chromium GPU acceleration. Disable and restart if you see black screens or rendering glitches. |

---

## Project Structure

```
desktop/
├── .github/workflows/    # Blacksmith CI: builds and releases on every push
├── src/
│   ├── main.js           # Electron main process, windows, tray, lifecycle
│   ├── preload.js        # Secure IPC bridge between renderer and main
│   ├── login.html        # Login window UI (QR + password)
│   ├── login.css         # Login window styles
│   ├── login.js          # Login window logic
│   ├── settings.html     # Settings window UI
│   ├── settings.css      # Settings window styles
│   ├── settings-ui.js    # Settings window logic
│   ├── settings.js       # Persistent settings store (userData)
│   ├── presence.js       # Discord Rich Presence module
│   └── icon.js           # Runtime PNG tray icon generator
├── build/
│   └── icon.png          # App icon for window, tray, and installers
├── package.json          # Electron + Bun + electron-builder config
├── README.md             # This file
└── .gitignore
```

---

## Building & Releasing

### App icon

The app icon is `build/icon.png` (already included). The tray icon, window icon, and installer icon all load from this file, with automatic resizing. If `build/icon.png` is missing, a runtime-generated purple "S" icon is used as a fallback.

### Build commands

```bash
# Build for the current platform
bun run dist

# Build for specific platforms
bun run dist:win    # Windows NSIS installer
bun run dist:mac    # macOS DMG
bun run dist:linux  # Linux AppImage + deb package
```

Build outputs are written to `dist/`.

### Automated releases

The included GitHub Actions workflow (`build-release.yml`) runs on every push to `main`:

- Builds for **Windows**, **macOS**, and **Linux** in parallel using **Blacksmith** runners
- Uses **Bun** for dependency install and build steps
- Creates a GitHub release with the generated installers attached
- Tags the release automatically using the commit timestamp and short SHA

To use Blacksmith runners, install the [Blacksmith GitHub App](https://docs.blacksmith.sh/introduction/quickstart) on the repository.

---

## Troubleshooting

### Black screen or rendering issues

Disable hardware acceleration in **Settings** and restart the app. You can also use the `--disable-gpu` flag when launching from the terminal.

### Cannot sign out

The app intercepts the logout API call and should clear the session. If you still get stuck, fully quit the app ( tray → Quit Serika ) and restart it.

### Discord presence not showing

1. Make sure Discord is running
2. Make sure Discord **Activity Status** is enabled in Discord settings
3. Make sure the desktop app has permission to read/write Discord's IPC pipe (this is local, no network access required)
4. Toggle **Discord Presence** off and back on from the tray menu

### Linux: "chrome-sandbox is not configured correctly"

Run `bun run fix:sandbox` once, or use `bun run dev`/`bun start` which already include `--no-sandbox` for development.

---

## License

MIT

---

<p align="center">
  Built with care for the Serika community.
</p>
