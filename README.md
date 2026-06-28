# Serika Desktop

Cross-platform desktop app for Serika streaming (Windows, Linux, macOS).

Built with Electron + [Bun](https://bun.sh). Uses [serika.moe](https://serika.moe) as the frontend.

## Features

- **QR Login** — Scan a QR code with your phone to sign in (uses the TV-link system)
- **Password Login** — Email + password, with 2FA (TOTP / backup code) support
- **Session persistence** — Stay logged in across restarts
- **Native window** — Proper desktop app with window controls

## Prerequisites

- [Bun](https://bun.sh) 1.1+

## Development

```bash
cd desktop
bun install
bun start
```

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
