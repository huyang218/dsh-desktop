# dsh Desktop

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey.svg)](#platform-support)

A desktop app for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`): it installs and updates the runtime, owns the server process and its storage, and puts the web UI in a window.

> **Unofficial project.** Not affiliated with or endorsed by DeepSeek. `dsh`
> itself is published by its authors on npm; this app is only a shell around
> it. The two ship independently — the app never bundles a copy of `dsh` into
> its own source tree.

The repository is named `dsh-desktop`; the packaged application is named **DeepSeek Harness** (see [Trademarks](#trademarks)).

## Why

`npx dsh web` already works. What it leaves to you is everything around it: where the runtime lives, how it gets upgraded, which port to use when one is taken, whether child processes survive the app, where `DSH_HOME` points, and who restarts the server when it dies. This app owns all of that.

## What it does

| | |
|---|---|
| **Dual-slot updates** | The runtime is installed by npm into `runtime/slot-a` or `slot-b`, with `current.json` naming the active one. An update installs into the idle slot, boots a probe server against it, and only moves the pointer once that self-test passes — a failed upgrade leaves the working version untouched. |
| **Process ownership** | The server starts with the window on a random free port and loads once it answers HTTP 200. It runs in its own process group (POSIX) or job tree (Windows), and the whole tree is terminated when the app quits — no orphans. |
| **Supervision** | An unplanned exit — including an OOM abort, which arrives as a signal rather than an exit code — is restarted automatically, backing off 1s/3s/8s. Three consecutive failures raise a dialog instead of spinning. A server that stays up for a minute earns a fresh budget, so an occasional crash always gets the full three attempts. |
| **Recoverable start** | A server that misses the readiness deadline offers a retry rather than killing the app: on a busy disk it is usually just slow, not broken. |
| **Storage** | `DSH_HOME` points inside the app's data directory, so profiles, sessions and settings are all owned by the app. The menu opens the data directory and the log directly. |
| **Bundled toolchain** | Packaged builds carry their own Node runtime, so a target machine needs nothing preinstalled. Running from source falls back to finding Node ≥ 22 on the machine (PATH, nvm, Homebrew, `%ProgramFiles%`), which also sidesteps GUI apps not inheriting a shell `PATH`. |
| **Plugin manager** | Install and remove `dsh` plugins from a window: by npm name, `github:` spec, absolute local path, or a zip package — a zip is unpacked into `<data dir>/dsh-home/plugins/<package name>` and installed from there as a local path. A plugin that exports a config schema gets a generated form; values are written to the profile's `plugin-config.json` and mirrored into a marked block in `cordis.patch.yml`. |

## Running from source

```sh
npm install
npm start
```

The first launch installs `@deepseek-ai/dsh@latest` from npm (needs network, takes a few minutes). Data and logs live in the [data directory](#data-locations).

### If `npm install` fails downloading Electron

Electron's postinstall fetches a ~100 MB runtime from GitHub Releases, which does **not** go through the npm registry — changing the registry alone will not fix it. On a network where GitHub is unreachable or reset (`RequestError: read ECONNRESET` under `node_modules/electron`), point both downloaders at a mirror.

Windows (`cmd`, same window as the commands that follow):

```cmd
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

macOS / Linux:

```sh
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

To persist them, add the same keys to `.npmrc` in lowercase (`electron_mirror=…`), which npm exports to lifecycle scripts. Note that `npm config set electron_mirror …` is **rejected** by npm 9 and newer — it validates key names and these are not npm's own options.

The second variable matters at build time rather than install time: `electron-builder` downloads its own helper binaries (NSIS, winCodeSign) from GitHub too, so setting only the first one walks into the same failure during `npm run dist:win`.

A failed install leaves `node_modules` half-written — and on Windows, `EPERM: operation not permitted, rmdir` during npm's cleanup means a process is holding files open (antivirus, an editor, Explorer). Close whatever holds the directory, delete `node_modules`, and install again.

## Building

Packaging **snapshots the packaging machine**. `npm run seed` — which every `dist` script runs first — writes two archives into the project root:

- `seed.tar` — the `dsh` runtime currently installed in this machine's data directory
- `node-runtime.tgz` — this machine's Node binary plus npm, so the installed app needs no preinstalled Node

Two consequences follow. **Run the app once before building**, or there is no runtime to snapshot and the build stops with `No active local dsh runtime`. And **build each platform's package on that platform** — a macOS-built Windows installer would contain a macOS Node binary. Cross-compiling is only possible by giving up the offline seed and downloading Node per target instead.

### macOS

```sh
npm install
npm start          # once, so the dsh runtime is installed
npm run dist       # dist/mac-arm64/DeepSeek Harness.app
npm run dist:mac   # dist/DeepSeek Harness-<version>-arm64.dmg
```

Builds are ad-hoc signed by `scripts/adhoc-sign.cjs` (an `afterPack` hook) and not notarized. Without that signature the renamed Electron binary carries a stale one, and Gatekeeper reports a quarantined copy as "damaged" rather than showing the normal unidentified-developer prompt.

### Windows

Requirements: Windows 10 1803 or newer (for `tar.exe` in System32), [Node.js](https://nodejs.org) ≥ 22, and Git.

```powershell
git clone https://github.com/huyang218/dsh-desktop.git
cd dsh-desktop
npm install
npm start          # once, so the dsh runtime is installed under %APPDATA%
npm run dist:win   # NSIS installer
npm run dist       # or: unpacked app only, no installer
```

Output:

```
dist\
├── dsh-desktop Setup <version>.exe   NSIS installer
└── win-unpacked\                     unpacked app (npm run dist)
```

The installer is per-user and lets the user choose the install directory (`oneClick: false`, `perMachine: false`), so it needs no administrator rights. It is unsigned: SmartScreen will warn on first run until the executable earns reputation or you add a code-signing certificate under `build.win.certificateFile`.

`npm start` must come first here too. Skipping it fails during `predist` with `No active local dsh runtime under %APPDATA%\dsh-desktop\runtime`.

After installing, verify the three things listed under [Platform support](#platform-support) — above all that quitting the app leaves no orphaned `node` processes.

## Menu

| Item | Effect |
|---|---|
| Plugins… | Install, remove and configure `dsh` plugins |
| Check for updates | Dual-slot update, with a restart prompt after the self-test passes |
| Restart service | Stops the current server tree and starts the same version again |
| Open data directory / Open log | |

## Data locations

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/dsh-desktop/` |
| Windows | `%APPDATA%\dsh-desktop\` |

```
dsh-desktop/
├── runtime/            installed dsh, slot-a | slot-b, current.json
├── node-runtime/       bundled Node (packaged builds only)
├── dsh-home/           DSH_HOME: profiles, sessions, settings
└── dsh-desktop.log     app and server log
```

## Platform support

| | Status |
|---|---|
| **macOS** (Apple Silicon) | Verified end to end |
| **Windows** (10 1803 or newer) | Verified end to end: NSIS installer, first run, clean exit |
| Linux | Not attempted |

`dsh` itself is cross-platform (no `os` restriction, and it ships pwsh and Windows-ACL sandbox backends), so the platform work is confined to this shell. Every POSIX assumption has a Windows counterpart: process-tree termination uses `taskkill /T` instead of a negative pid, `tar` is invoked by name, Node lookup takes `node.exe` and searches `%ProgramFiles%\nodejs` and nvm-windows, the tray uses a real icon instead of a macOS template image, and the data directory resolves through `%APPDATA%`.

**Process-tree termination** is the part that could only be settled on real hardware, and was: killing a process group and running `taskkill /T` are different mechanisms, and getting it wrong produces an app that appears to exit cleanly while leaving orphaned `dsh` processes behind — invisible to code review. Worth re-checking after any change to shutdown; after quitting, this should print nothing:

```powershell
Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*dsh-desktop*' }
```

## Known limitations

- `dsh` is at release-candidate stage. The contract this app depends on is deliberately minimal: `dsh web --port N`, plus HTTP 200 at the root meaning ready. Check those two first when an upstream change breaks something.
- The local port is reachable by any process on the machine (`dsh` has no auth token yet). A random port narrows the window; it does not close it.
- Conversations need `DEEPSEEK_API_KEY`, set either in the `dsh` web UI settings or in the environment before launch.
- macOS builds are ad-hoc signed and not notarized: the first launch needs approval under System Settings → Privacy & Security.

## Contributing

Issues and pull requests are welcome.

If a change touches the process lifecycle — start, supervision, shutdown — please verify on a real machine that quitting the app leaves no orphaned processes. That class of bug is invisible in review and does not reproduce in unit tests.

**Contributors**

- **Hu Yang** ([@huyang218](https://github.com/huyang218)) — author, maintainer

## License

Released under the [MIT License](LICENSE).

A packaged build redistributes the following, each under its own license, with notices retained in the package:

| Component | License | Location in the package |
|---|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh` and plugins) | MIT | `Resources/runtime-seed.tar` |
| [Node.js](https://nodejs.org) | MIT | `Resources/node-runtime.tgz` → `LICENSE-node` |
| [npm](https://github.com/npm/cli) | Artistic-2.0 | same archive → `lib/node_modules/npm/LICENSE` |
| [Electron](https://www.electronjs.org) | MIT | application framework |

### Trademarks

"DeepSeek" is a trademark of its owner. **This project is unofficial, unaffiliated and unendorsed.** The packaged application carries the DeepSeek Harness name and whale icon to identify the upstream software it hosts; those marks belong to their owner and are not covered by this project's MIT grant.
