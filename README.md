# Discord Lyrics Status

> A standalone Windows app that reads Spotify playback through Windows
> SMTC, fetches synchronized lyrics from LRCLIB, and updates your
> Discord custom status in real time.

* **Runs on:** Windows 10 / Windows 11
* **Requires:** Node.js 18.17+ (or a packaged .exe that ships Node)
* **Cost:** $0 — no Discord bot, no remote service, no telemetry
* **Token safety:** stored only in `%APPDATA%\DiscordLyricsStatus\config.json`, never logged, never sent anywhere except Discord's API

---

## What it does

1. Watches the Windows **System Media Transport Controls** session that
   Spotify publishes. No polling for transport state — it reacts to events
   from the OS.
2. When a track starts playing, looks up synced lyrics from
   [LRCLIB](https://lrclib.net). Results are cached on disk (24h TTL,
   keyed by track+artist+duration) and in memory.
3. Schedules lyric transitions with millisecond accuracy using a single
   `setTimeout` that re-anchors from `Date.now()` on every fire — no
   drift, no per-millisecond polling.
4. Pushes the current line to your Discord custom status via the
   `/users/@me/settings` endpoint, with a sequential request queue that
   honors `Retry-After` and deduplicates identical updates.

If lyrics are unavailable for a song, it shows **Artist — Title** instead
of the lyric line. If Spotify closes, the status is cleared. If Discord
rejects the token (401/403), it re-opens the browser setup flow.

---

## Quick start (developer)

```powershell
git clone <your fork>
cd dsc-lyrics
npm install
npm run build
npm start
```

The first time you launch the app it has no token configured, so it
opens a tiny setup page in your default browser, asks for your Discord
user token, validates the format, saves it to
`%APPDATA%\DiscordLyricsStatus\config.json`, and exits setup. The app
then starts tracking Spotify.

Subsequent launches go straight into background mode.

### Useful commands

| Command            | What it does                                                         |
| ------------------ | -------------------------------------------------------------------- |
| `npm start`        | Run the built bundle (`dist/main.cjs`).                              |
| `npm run dev`      | Build on save + run from `src/` with source maps.                    |
| `npm run lint`     | ESLint over `src/**/*.js`.                                           |
| `npm run build`    | Produce ESM + CJS bundles in `dist/`.                                |
| `npm run verify`   | Post-build checks: existence, sizes, `node --check`, smoke.          |
| `npm run package`  | SEA-pack a single-file Windows `.exe` in `release/`.                 |
| `npm run clean`    | Remove `dist/`, `release/`, and log cache.                           |

### Environment variables

| Variable          | Effect                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `DLS_ADAPTER=mock`| Skip SMTC entirely; use the in-process mock adapter (for tests / CI). |
| `DLS_LOG=debug`   | Verbose logging.                                                      |
| `APPDATA`         | Override the per-user config directory.                               |

---

## Architecture

```
                  ┌──────────────────────────┐
                  │  Windows SMTC (Spotify)  │
                  └────────────┬─────────────┘
                               │ events
                               ▼
        ┌──────────────────────────────────────────────┐
        │         src/scripts/smtc-bridge.ps1           │
        │   (PowerShell 5 / 7, streams JSON on stdout)  │
        └────────────────────┬─────────────────────────┘
                             │ line-delimited JSON
                             ▼
              ┌───────────────────────────────┐
              │ PowerShellBridgeAdapter       │   ← pluggable adapter contract
              └────────────┬──────────────────┘
                           │ events: attached, detached,
                           │   playbackStatus, timeline,
                           │   mediaProperties, error
                           ▼
                ┌──────────────────────────┐
                │       SmtcService        │   ← event dedup, backoff,
                └────────────┬─────────────┘     pause/resume/seek detection
                             │
                  ┌──────────┴──────────┐
                  │ trackchange         │ position
                  ▼                     ▼
       ┌──────────────────┐   ┌──────────────────┐
       │  LyricsProvider  │   │    Scheduler     │
       │  LRCLIB + cache  │   │ setTimeout-based │
       └─────────┬────────┘   │ drift-free       │
                 │ lines      └────────┬─────────┘
                 ▼                    │ line
       ┌──────────────────────────────────────┐
       │            StateManager               │   ← single source of truth
       └────────────────┬─────────────────────┘
                        │ status text
                        ▼
              ┌────────────────────────┐
              │     DiscordClient      │   ← sequential queue, Retry-After,
              │   PATCH @me/settings   │     dedup, reconnect, no token logs
              └────────────────────────┘
                        │ HTTPS
                        ▼
                ┌──────────────────┐
                │  Discord API v9  │
                └──────────────────┘
```

Every box has a corresponding module under `src/`. The DI wiring lives
in `src/main.js` — there is **no global mutable state** anywhere in the
runtime.

### Key modules

| Module                                            | Responsibility                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main.js`                                     | Process entry: install error handlers, lock, wire DI, handle signals.                                                                                |
| `src/core/state-manager.js`                       | The orchestrator. Reacts to SMTC events, drives lyrics lookups, drives the scheduler, drives the Discord client.                                     |
| `src/core/logger.js`                              | Structured (JSON) logger with rotation, file sink, stderr mirror, **token scrubbing** on every field and message string.                            |
| `src/core/config.js`                              | Atomic-write config store. Validates every field with field-level validators. Quarantines corrupt files. Migrates v1 → v2.                          |
| `src/core/paths.js`                               | Resolves `%APPDATA%`, `%LOCALAPPDATA%`, PowerShell, and cmd.exe — never trusts PATH.                                                                 |
| `src/core/browser.js`                             | Cross-platform "open URL in default browser" via PowerShell on Windows, `open` on macOS, `xdg-open` on Linux. Never `spawn('cmd', …)`.              |
| `src/core/single-instance.js`                     | One-instance lock using a `wx`-opened lockfile; refuses a second launch.                                                                             |
| `src/services/playback-adapter.js`                | The adapter contract (interface).                                                                                                                    |
| `src/services/smtc-service.js`                    | Translates adapter events into `trackchange` / `statechange` / `position`. Coalesces duplicates. Retries on failure.                                 |
| `src/services/powershell-bridge-adapter.js`       | Spawns `smtc-bridge.ps1`, parses line-delimited JSON, re-emits as adapter events.                                                                   |
| `src/services/mock-adapter.js`                    | A scripted fake for tests and dev without Spotify.                                                                                                   |
| `src/scripts/smtc-bridge.ps1`                     | The PowerShell side: queries `GlobalSystemMediaTransportControlsSessionManager` and emits JSON. Works on PowerShell 5 and 7.                          |
| `src/services/lrc-parser.js`                      | LRC → `[{ms, text}]`. Handles BOMs, CRLF, multi-stamp lines, fractional ms, unsorted input, malformed lines, metadata tags.                          |
| `src/services/lyrics-provider.js`                 | LRCLIB client. Memory L1 cache + disk L2 cache + TTL + exponential backoff + `AbortController` cancellation. Never throws on lookup failure.       |
| `src/services/scheduler.js`                       | Single `setTimeout` re-anchored from `Date.now()` on every fire. Handles pause, resume, seek, track restart, track repeat.                          |
| `src/services/discord-client.js`                  | Sequential PATCH queue. Honors `Retry-After`. Dedupes identical consecutive updates. Reconnects on network failure. Never logs the token.          |
| `src/setup/setup-server.js`                       | Tiny `http` server: auto-port, CSRF token, token format validation, one-shot consumption, opens browser via `core/browser.js`.                      |

---

## Reliability guarantees

The runtime is built around a few invariants that the code enforces
everywhere:

1. **No uncaught promise rejection.** A top-level `unhandledRejection`
   handler prints the stack and continues; `uncaughtException` prints
   and exits (the OS / launch agent decides whether to restart).
2. **No timer leaks.** Every `setTimeout` and `setInterval` is paired
   with a `clearTimeout` / `clearInterval` in the matching `stop()`
   path, and all are `.unref()`'d so they never block process exit.
3. **No duplicate status updates.** The Discord client compares every
   new value to the last value it sent before even queuing.
4. **No duplicate lyric schedulers.** The scheduler is a single class
   with a single timer; there is exactly one instance per runtime.
5. **No duplicated LRCLIB requests.** The provider's L1 + L2 caches
   short-circuit repeat lookups for the same `(track, artist,
   durationBucket)` triple within the TTL window.
6. **No abandoned SMTC reads.** The bridge process is restarted
   automatically if it exits, and the `SmtcService` re-attaches on
   `attached` events.
7. **No token in logs.** The logger redacts any field whose key
   contains `token` / `authorization`, and any string matching a
   Discord-token shape.

---

## Security

* The Discord user token is stored in plain text inside
  `%APPDATA%\DiscordLyricsStatus\config.json`. This is intentional —
  the token is a **user token**, equivalent in privilege to the
  password, and it MUST NOT leave the machine. We do not log it,
  do not send it anywhere except `discord.com/api/v9`, do not
  encrypt it (because Windows DPAPI would couple the install to
  the user profile and break portability). If your machine is
  compromised at the user level the token is already compromised,
  regardless of encryption.
* The setup server binds **only** to `127.0.0.1`. It cannot be
  reached from another machine.
* CSRF token is required on `/submit`.
* Token format is validated server-side before we save it; a
  malformed token never reaches the config file.
* All LRCLIB request parameters are URL-encoded; we never
  interpolate user input into a path.

---

## Windows compatibility

The runtime is tested against:

* Windows 10 + PowerShell 5.1 (the default `powershell.exe`)
* Windows 11 + PowerShell 7 (`pwsh.exe`)
* Both `cmd.exe` and PowerShell shells
* Stripped-down environments where `%PATH%` is missing `cmd.exe`
  or `powershell.exe`

We never call `spawn('cmd', …)` without resolving a concrete path.
We find `cmd.exe` via `ComSpec`, `WINDIR\System32\cmd.exe`, and
`WINDIR\Sysnative\cmd.exe`. We find PowerShell via the explicit
`Program Files\PowerShell\7\pwsh.exe` paths and
`System32\WindowsPowerShell\v1.0\powershell.exe`.

The PowerShell bridge script uses `[Windows.Media.Control.*]` which
is part of the Universal Windows Platform runtime available on every
supported Windows build since 1607. We do not require any third-party
PowerShell modules.

---

## Build pipeline

* `scripts/build.mjs` produces two bundles in `dist/`:
  * `dist/main.mjs` — ESM, used by `node` directly during development.
  * `dist/main.cjs` — CommonJS, used by the SEA packager and by
    `npm start`.
* The CommonJS bundle ships with `dist/package.json` containing
  `"type": "commonjs"` so Node parses it correctly without renaming.
* `scripts/package.mjs` invokes Node's built-in Single Executable
  Application (`--experimental-sea-config`) to fuse the bundle into
  a copy of `node.exe`, with `postject` injecting the SEA blob.
* If SEA is unavailable on the host Node, the packager falls back
  to a portable launcher (`discord-lyrics-status.exe` is `node.exe`
  + `main.cjs` + a `.bat` wrapper). This still works without Node
  installed on the target machine — the `node.exe` is bundled.

Cold-start time is dominated by the OS loading `node.exe`; the bundle
itself is ~42 KiB and parses in tens of milliseconds.

---

## Configuration reference

Stored in `%APPDATA%\DiscordLyricsStatus\config.json`.

```jsonc
{
  "version": 2,
  "discord": {
    "token": "<your discord user token>",
    "userId": null
  },
  "display": {
    "showArtist": true,
    "maxLineLength": 120,
    "separator": " — "
  },
  "lyrics": {
    "provider": "lrclib",
    "timeoutMs": 8000,
    "maxRetries": 4,
    "cacheTtlMs": 86400000
  },
  "scheduler": {
    "tickMs": 100,
    "lookaheadMs": 4000
  },
  "logging": {
    "level": "info",
    "verbose": false
  },
  "setup": { "lastPort": null }
}
```

The config store validates every field on load and on write. Unknown
keys are dropped silently. Corrupt files are moved to
`config.corrupt-<timestamp>.json` and the runtime starts with defaults.

---

## License

MIT — see `LICENSE`.
