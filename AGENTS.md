# AGENTS.md

Instructions for AI coding agents working on the Serika Streaming desktop app.

## Always bump the version

`version.txt` holds the Serika Streaming version: one line, `MAJOR.MINOR.PATCH` (for example `1.0.33`).

**Every Serika Streaming repo holds the same version, always:**

- [SerikaStreaming](https://github.com/serika-dev/SerikaStreaming): the serika.moe website
- [SerikaStreaming-backend](https://github.com/serika-dev/SerikaStreaming-backend): the media encoder
- [SerikaStreaming-App](https://github.com/serika-dev/SerikaStreaming-App): the Android and iOS app
- [SerikaStreaming-Desktop](https://github.com/serika-dev/SerikaStreaming-Desktop): the desktop app
- [cast-receiver](https://github.com/serika-dev/cast-receiver): the Chromecast receiver

**Every change you make here must raise it, in the same commit as the change, and every other repo above must be raised to the same number.** Start from the highest version any of them holds:

- **Patch** (`1.0.30` → `1.0.31`): every change, new features included. This is the default.
- **Minor** (`1.0.31` → `1.1.0`): only when you are asked to.
- **Major** (`1.1.0` → `2.0.0`): only when you are asked to.

Bump once per task, not once per commit. If a task takes several commits, raise it in the first one and leave it there. Never lower it or reuse a number.

In the other repos, a commit that only raises the version (`version.txt` and the files their AGENTS.md lists) is all that is needed; SerikaChangelog leaves repos whose only change is the version number out of the announcement. If you cannot commit to one of them, say so at the end of your task so someone else bumps it.

Keep these in step with `version.txt` whenever you bump it:

- `package.json` → `version` (the release workflow tags builds `v<version>-<timestamp>-<sha>` from it)

## A/B tests

serika.moe assigns experiments (Admin → Experiments) and recognises the main window by its
Electron user agent, so the site needs nothing from this app. The app's own pages (login,
settings) load `experiments-ui.js`, which gives them the same API as the site:

```html
<div class="ab--new-login--qr-first">…</div>    <!-- shows only for that variant -->
<script>serikaExperiments.variant('new-login'); serikaExperiments.isOn('new-login'); serikaExperiments.track('goal-name');</script>
```

`src/experiments.js` fetches the variants with the session cookie and keeps the `serika_ab`
device cookie that the site uses too.

## Why it matters

Raising `version.txt` on `main` is what releases this to users.
[SerikaChangelog](https://github.com/serika-dev/SerikaChangelog) checks it every
15 minutes. When the number goes up, it turns every commit since the previous
version into a short, plain-language announcement in the Serika Discord. Other
Serika Streaming repos bumped around the same time go into the same post. Commit
messages are the raw material, so say in them what changed for users.
