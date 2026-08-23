# Changelog

Every released version, and what it changed. The notes attached to a
[GitHub release](https://github.com/huyang218/dsh-desktop/releases) are the
section for that version, taken from this file by `scripts/release-notes.mjs`
— so a release with nothing written here ships with nothing to read.

## 0.1.13 — 2026-08-23

- Keep the server's port, and with it the user's open workspace

## 0.1.12 — 2026-08-23

- Stop reading noise as a saturated machine
- Give the badge five load levels and a character that shows them
- Let the badge wear a character

## 0.1.11 — 2026-08-22

- Keep the app in the Dock when the badge is open

## 0.1.10 — 2026-08-22

- Make the badge say what the harness is doing
- Give the badge three sizes to be
- Hold the main window while a manager is open
- Bring the badge forward when the app is woken
- Open the badge in a corner, not over the work
- Show what the harness is costing, in a badge
- Put the application's identity in one document

## 0.1.9 — 2026-08-22

- Suggest the repositories that actually hold skills
- Stop pulling whole repositories to place three kilobytes
- Install skills from GitHub, and give them something to update from
- Add a skills manager window
- Say why a skill is not loading

## 0.1.8 — 2026-08-21

- Build the Intel dmg too, and hand each Mac the right one

## 0.1.7 — 2026-08-21

- Ask the shell where things are instead of guessing
- Find the CLIs a version manager hides from a GUI app
- Give npm room to install dsh, and say when it was killed

## 0.1.6 — 2026-08-20

- Follow a chosen dist-tag, not whatever npm calls latest

## 0.1.5 — 2026-08-20

- Stream the installer download instead of holding it
- Say something when the app dies without being asked to
- macOS: a name and an icon for source runs

## 0.1.4 — 2026-08-18

- Windows: an app identity, so the fallback is not invisible
- Windows and Linux: no menu bar over the secondary windows

## 0.1.3 — 2026-08-18

- Windows: never delete the Node runtime that is running
- macOS: Alternate rank, or the app never appears in Open With
- Send files from the desktop into the chat
- Undo the plugin that broke the server, and snapshot the sessions
- Flag plugins with updates, and let them be switched off
- Install a plugin by pasting its GitHub page
- Author email: guxinglei218@qq.com

## 0.1.2 — 2026-08-18

- Windows: fix a cross-drive rename, refuse unwritable zip names
- A way back to the previous runtime, and life in the tray
- One proxy setting for both of the app's networks
- Update the app from its own releases, hot when it can

## 0.1.1 — 2026-08-18

- Drop the Intel macOS build
- Keep electron-builder from publishing on its own
- Build every platform on GitHub Actions
- Plugin market, in a window of its own
- Explain macOS privacy denials instead of forwarding EPERM
- Plugin manager: install from a zip package
- Restyle the plugin manager window

## 0.1.0 — 2026-08-18

- README: Windows is verified, on real hardware
- Settings: let the data and log directories be moved
- README: drop the dsh-shell upgrade section
- Report update progress in the tray
- Check for updates before downloading one
- Make plugin install, removal and updates work on both platforms
- Add a language setting, and localize the shell in Chinese and English
- Do not fail the build when Node ships no LICENSE to copy
- README: correct the mirror instructions — npm rejects those config keys
- README: document the Electron download failure and its mirror fix
- Rewrite the README as a bilingual, publishable document
- Make a failed launch recoverable instead of unquittable
- Make the shell run on Windows as well as macOS
- Credit the author and record the contribution expectation
- README: state where Windows support actually stands
- Keep the DeepSeek Harness name and icon on the packaged app
- Rename to dsh Desktop and prepare for open source
- shell: supervise the dsh server and report how it died
- Initial commit: dsh-shell with install-time plugin configuration

