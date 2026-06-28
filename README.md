# Serika Desktop

Cross-platform desktop app for Serika streaming (Windows, Linux, macOS).

Built with Electron + [Bun](https://bun.sh). Uses [serika.moe](https://serika.moe) as the frontend.

## Features

- **QR Login** — Scan a QR code with your phone to sign in (uses the TV-link system)
- **Password Login** — Email + password, with 2FA (TOTP / backup code) support
- **Session persistence** — Stay logged in across restarts
- **Native window** — Proper desktop app with window controls
- **Run in the background** — Minimize or close to system tray, start at login
- **Discord Rich Presence** — Show your Serika watch activity on Discord (built into the desktop app; automatically disables the standalone background runner)
- **Configurable settings** — Zoom level, startup behavior, hardware acceleration toggle

## Prerequisites

- [Bun](https://bun.sh) 1.1+

## Development

```bash
cd desktop
bun install
bun start
```

## System tray / background running

The app keeps a tray icon while running. You can:

- **Open Serika** — Restore the main window
- **Toggle Discord Presence** — Turn Rich Presence on/off
- **Settings** — Open the desktop settings panel
- **Quit** — Fully exit the app

Settings include: launch at startup, start minimized, close/minimize to tray, zoom level, and hardware acceleration (disable if you see black screens).

## Building

You need an app icon at `build/icon.png` (512×512 recommended). If missing, Electron uses a default icon.

```bash
# Build for current platform
bun run dist

# Build for specific platforms
bun run dist:win    # Windows (NSIS installer)
bun run dist:mac    # macOS (DMG)
bun run dist:linux  # Linux (AppImage + deb)
```

Output goes to `dist/`.

## Discord Presence

The desktop app runs a local server on `127.0.0.1:6464`. When you watch something on `serika.moe` inside the app, it sends play/pause state to this local server, which then updates your Discord Rich Presence.

If you previously installed the standalone `serika-presence` runner, it will automatically **stand down** while the desktop app is running, and resume only after the desktop app closes.

## How login works

### QR Login
1. App calls `POST /api/auth/tv-link/generate` → gets a 7-char code
2. QR code is shown (encodes `https://serika.moe/settings?tv-code=CODE`)
3. User scans QR on their phone (must be logged in on mobile browser)
4. App polls `GET /api/auth/tv-link/status?code=CODE`
5. When linked, session ID is set as cookie and main window opens

### Password Login
1. App calls `POST /api/auth/login` with `{ email, password, rememberMe }`
2. If 2FA required → app calls `POST /api/auth/2fa/verify` with `{ code }`
3. Session cookie is captured and set on the Electron session
4. Main window opens with `https://serika.moe`
