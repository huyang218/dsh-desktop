/**
 * dsh Desktop Electron main process.
 *
 * Owns the three responsibilities the shell exists for:
 *  - environment: first-run install and dual-slot update of the dsh runtime;
 *  - process: start the dsh web server with the app, kill its whole process
 *    group only when the app quits;
 *  - storage: DSH_HOME (profiles, sessions, settings) lives under the app's
 *    data directory, so the shell owns where everything is kept.
 *
 * Lifecycle: closing the window hides it while the server keeps running; the
 * tray icon and the Dock bring it back. Quitting (tray menu or Cmd+Q) stops
 * the server process group before exit.
 */
import {
  app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, Notification, screen, session, shell, Tray,
} from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnv, ensureBundledToolchain, findToolchain } from './toolchain.js'
import { getLocale, LOCALES, messages, resolveLocale, setLocale, t } from './i18n.js'
import { resolveLocations, saveLocations } from './locations.js'
import {
  compareVersions, downloadInstaller, fetchLatestRelease, fetchShellManifest, plan, stageShellUpdate,
} from './app-update.js'
import { DEFAULT_CATALOG_URL, loadCatalog } from './market.js'
import {
  getDisabledPlugins, getPluginConfigValues, probePluginConfig, setPluginConfig, setPluginDisabled,
} from './plugin-config.js'
import { normalizeSpec } from './plugin-spec.js'
import { installFromDirectory, installFromZip, removeSkill, SKILLS_DIR } from './skill-install.js'
import { listSkills, setEnabled as setSkillEnabled } from './skills.js'
import { findPluginUpdates } from './plugin-updates.js'
import { PLUGIN_DIR, unpackPluginZip } from './plugin-zip.js'
import { withAccessHint } from './permission.js'
import * as proxy from './proxy.js'
import { confirmBundle, shellDirOf } from './shell-bundle.js'
import { visibleBounds } from './window-state.js'
import {
  activateSlot, CHANNELS, channelVersion, DSH_PACKAGE, dshBinPath, ensureRuntime,
  inactiveSlot, installedVersion, installIntoSlot, normalizeChannel, readPointer, slotDir,
} from './runtime.js'
import { getFreePort, startServer, stopServer, waitHealthy } from './server.js'
import { createSnapshot, inspectSnapshot, restoreSnapshot } from './snapshot.js'
import { formatPaths, insertionScript, pathsFromArgv } from './send-to-chat.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const assets = path.join(here, '..', 'assets')

// Only the packaged bundle carries the product name in its Info.plist; run
// from source, Electron falls back to the package name and the app menu reads
// "dsh-desktop". Safe to set because the data directory is pinned explicitly
// on the next line rather than derived from this name.
app.setName('DeepSeek Harness')

const locations = resolveLocations(app.getPath('appData'))
app.setPath('userData', locations.dataDir)

// Windows ties notifications to an application identity, and one that is not
// set means notifications that never appear — with no error to notice. It
// also keeps the taskbar from treating each launch as a different app.
if (process.platform === 'win32') app.setAppUserModelId('io.github.huyang218.dsh-desktop')

// macOS fires this before the app is ready — for a launch by Open With it is
// the whole reason the app is starting — so it is registered here rather than
// in main(), and the paths wait in the queue until there is a chat to put
// them in.
app.on('open-file', (event, filePath) => {
  event.preventDefault()
  sendFilesToChat([filePath]).catch(error => log(`open-file failed: ${error?.message ?? error}`))
})

/**
 * @type {{
 *   child?: import('node:child_process').ChildProcess, port?: number,
 *   window?: BrowserWindow, tray?: Tray, runtime?: { slot: string, dir: string, version: string },
 *   toolchain?: ReturnType<typeof findToolchain>, quitting: boolean,
 *   restarts: number, restartTimer?: NodeJS.Timeout,
 *   pluginWindows: Record<string, BrowserWindow>,
 * }}
 */
const state = { quitting: false, restarts: 0, pluginWindows: {} }

// ── Supervision ─────────────────────────────────────────────────────────────
// The server can die on its own (an OOM abort inside dsh takes the whole
// process down with SIGABRT, not an exit code). Bring it back automatically,
// but bounded: a crash loop must surface to the user instead of spinning.

/** Automatic restarts before the shell stops trying and asks the user. */
const MAX_AUTO_RESTARTS = 3
/** Delay before each automatic restart, by attempt number. */
const RESTART_BACKOFF_MS = [1000, 3000, 8000]
/** Uptime that earns a server a fresh restart budget. */
const HEALTHY_UPTIME_MS = 60_000

/** Human-readable cause of a child exit: a signal death carries no code. */
function describeExit(code, signal) {
  return signal ? `signal=${signal}` : `code=${code}`
}

const paths = {}
function initPaths() {
  const userData = app.getPath('userData')
  paths.runtimeBase = path.join(userData, 'runtime')
  paths.dshHome = path.join(userData, 'dsh-home')
  // Zip-installed plugins live here for good: the profile links to them by
  // path, so this is part of the installation, not a scratch directory.
  paths.pluginsDir = path.join(paths.dshHome, PLUGIN_DIR)
  // The market catalog is normalized before it is stored, so this file holds
  // a few hundred entries rather than the multi-megabyte document they came
  // from. It is a cache: deleting it costs one refresh.
  paths.marketCache = path.join(userData, 'market-catalog.json')
  // Hot-updated shells, and the installers downloaded for the updates that
  // cannot be hot.
  paths.shellDir = shellDirOf(locations.dataDir)
  paths.downloads = path.join(userData, 'updates')
  // A migrated directory keeps its old dsh-shell.log beside this one; that
  // history is the user's, so it is left alone rather than renamed or removed.
  paths.logDir = locations.logDir
  paths.logFile = path.join(locations.logDir, 'dsh-desktop.log')
  paths.settingsFile = path.join(userData, 'settings.json')
  mkdirSync(paths.dshHome, { recursive: true })
}

/** Shell preferences. Unreadable or corrupt settings fall back to defaults
 * rather than blocking startup — nothing in here is worth failing over. */
function readSettings() {
  try {
    return JSON.parse(readFileSync(paths.settingsFile, 'utf8'))
  } catch {
    return {}
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch }
  try {
    writeFileSync(paths.settingsFile, `${JSON.stringify(next, null, 2)}\n`)
  } catch (error) {
    log(`could not save settings: ${error?.message ?? error}`)
  }
  return next
}

/** The dist-tag runtime update checks follow. Stable unless asked otherwise. */
function runtimeChannel() {
  return normalizeChannel(readSettings().runtimeChannel)
}

/**
 * Applies a language across everything already on screen. The menus and tray
 * are rebuilt from scratch because Electron menu items are immutable once
 * built, and the plugin window reloads to pick up its own strings.
 *
 * @param {string} id one of {@link LOCALES}
 */
function applyLocale(id) {
  if (id === getLocale()) return
  setLocale(id)
  writeSettings({ locale: getLocale() })
  log(`locale set to ${getLocale()}`)
  buildMenu()
  if (state.tray && !state.tray.isDestroyed()) {
    // Re-set rather than recreate: destroying the Tray makes the icon vanish
    // and reappear in the menu bar, and would drop a running update's display.
    state.tray.setContextMenu(trayMenu())
    paintTray()
  }
  for (const win of pluginWindows()) win.reload()
  if (state.settingsWindow && !state.settingsWindow.isDestroyed()) state.settingsWindow.reload()
  if (state.skillsWindow && !state.skillsWindow.isDestroyed()) state.skillsWindow.reload()
  if (state.window && !state.window.isDestroyed() && !state.port) {
    // Still on the loading page: reload it so its two strings switch too.
    state.window.loadFile(path.join(assets, 'loading.html'), { search: `lang=${getLocale()}` })
      .catch(() => {})
  }
}

/**
 * Asks for a directory and records it as the new data location.
 *
 * The data is NOT moved. Relocating gigabytes across volumes from a modal
 * with no progress is exactly where a half-copied runtime and a lost session
 * history come from; the user is told plainly what stays behind and can move
 * it deliberately. A restart is required because Chromium holds handles
 * inside the current userData for the life of the process.
 */
async function chooseDataDir() {
  const { canceled, filePaths } = await dialog.showOpenDialog(state.window, {
    title: t('dialog.pickDataDir'),
    defaultPath: locations.dataDir,
    properties: ['openDirectory', 'createDirectory'],
  })
  const chosen = filePaths?.[0]
  if (canceled || !chosen || chosen === locations.dataDir) return
  saveLocations(locations.pointerFile, { dataDir: chosen === locations.defaultDir ? null : chosen })
  log(`data directory set to ${chosen}`)
  const { response } = await dialog.showMessageBox(state.window, {
    type: 'warning',
    message: t('dialog.dataDirChanged', { dir: chosen }),
    detail: t('dialog.dataDirDetail', { current: locations.dataDir }),
    buttons: [t('button.restartApp'), t('button.restartLater')],
    defaultId: 0,
    cancelId: 1,
  })
  if (response === 0) {
    // Deliberately NOT setting state.quitting here: before-quit uses it to
    // tell "already shutting down" from a fresh request, and short-circuiting
    // it would skip stopping the server — leaving an orphaned dsh behind for
    // the relaunched app to collide with.
    app.relaunch()
    app.quit()
  }
}

/** The log can move without a restart: every line reopens the file anyway. */
async function chooseLogDir() {
  const { canceled, filePaths } = await dialog.showOpenDialog(state.window, {
    title: t('dialog.pickLogDir'),
    defaultPath: paths.logDir,
    properties: ['openDirectory', 'createDirectory'],
  })
  const chosen = filePaths?.[0]
  if (canceled || !chosen || chosen === paths.logDir) return
  saveLocations(locations.pointerFile, { logDir: chosen === locations.dataDir ? null : chosen })
  paths.logDir = chosen
  paths.logFile = path.join(chosen, 'dsh-desktop.log')
  log(`log directory set to ${chosen}`)
  await dialog.showMessageBox(state.window, {
    message: t('dialog.logDirChanged', { dir: chosen }),
    detail: t('dialog.logDirDetail'),
  })
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  try {
    // The fallback matters for the crash handlers below: they are registered
    // before initPaths() runs, and a crash that happens first is exactly the
    // one worth having on disk.
    appendFileSync(paths.logFile ?? path.join(locations.logDir, 'dsh-desktop.log'), stamped)
  } catch { /* logging must never take the shell down */ }
}

/**
 * Last resort for a throw nobody caught.
 *
 * Without this the main process simply dies: no dialog, no log line, and —
 * because the server is spawned detached — an orphaned dsh tree left holding
 * DSH_HOME and its port for the next launch to collide with. The app still
 * ends, because the state after an uncaught throw is not one to keep running
 * in, but it ends on the record and it takes its server with it.
 *
 * @param {string} label which handler fired
 * @param {unknown} reason the error or rejection value
 */
let crashing = false
function crash(label, reason) {
  // A second throw while shutting down must not restart the shutdown.
  if (crashing) return
  crashing = true
  log(`FATAL ${label}: ${reason?.stack ?? reason}`)
  const child = state.child
  state.quitting = true
  state.child = undefined
  const exit = () => app.exit(1)
  if (child) stopServer(child).finally(exit)
  else exit()
}

/**
 * Reports a startup failure the shell cannot continue past, then quits.
 *
 * Deliberately NOT `dialog.showErrorBox`: that call is synchronous and blocks
 * the main process for as long as the box is up, so the app stops answering
 * everything — including a quit request — and has to be force-killed.
 */
async function fatal(title, error) {
  log(`FATAL ${title}: ${error?.stack ?? error}`)
  await dialog.showMessageBox({
    type: 'error',
    message: title,
    detail: `${error?.message ?? error}\n${t('dialog.logPath', { path: paths.logFile })}`,
    buttons: [t('button.quit')],
  })
  app.quit()
}

/**
 * Reports a launch that failed but may well succeed on another try — a health
 * wait that expired because the machine was busy is the common case, and
 * quitting the app over it strands the user with no way back in.
 *
 * @param {unknown} error what launchServer threw
 */
async function offerLaunchRetry(error) {
  log(`launch failed: ${error?.stack ?? error}`)
  const suspect = pluginSuspect()
  const buttons = suspect
    ? [t(`button.undo.${suspect.kind}`, { name: suspect.name }), t('button.retry'), t('button.quit')]
    : [t('button.retry'), t('button.quit')]
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: t('dialog.startFailed'),
    detail: [
      error?.message ?? error,
      suspect ? t('dialog.pluginSuspect', { name: suspect.name }) : t('dialog.startFailedDetail'),
    ].join('\n\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  })
  if (suspect && response === 0) {
    await undoPluginOp(suspect).catch(e => errorDialog(t('dialog.undoFailed'), e))
    return
  }
  if (response !== (suspect ? 1 : 0)) {
    app.quit()
    return
  }
  // restartServer() stops whatever the failed attempt left running: a server
  // that was merely slow is still booting, and a second one would fight it.
  await restartServer().catch(offerLaunchRetry)
}

function errorDialog(title, error) {
  log(`${title}: ${error?.stack ?? error}`)
  dialog.showMessageBox(state.window, {
    type: 'error', message: title, detail: String(error?.message ?? error),
  })
}

function showWindow() {
  const window = state.window
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

async function launchServer() {
  const { window, runtime } = state
  const port = await getFreePort()
  const startedAt = Date.now()
  const child = await startServer({
    slotDir: runtime.dir,
    port,
    dshHome: paths.dshHome,
    cwd: homedir(),
    toolchain: state.toolchain,
    log,
  })
  child.on('exit', (code, signal) => {
    log(`dsh server exited (${describeExit(code, signal)})`)
    // Only the current child on an unplanned exit is ours to supervise: a
    // superseded one belongs to whoever replaced it.
    if (state.quitting || state.child !== child) return
    state.child = undefined
    superviseExit({ code, signal, uptimeMs: Date.now() - startedAt })
  })
  state.child = child
  state.port = port
  const healthy = await waitHealthy(port, { aborted: () => state.quitting || state.child !== child })
  if (!healthy) {
    // Superseded: the child died (the supervisor owns the retry) or we are
    // quitting/restarting. Only a live-but-unresponsive server is our error.
    if (state.quitting || state.child !== child) return
    throw new Error(`${t('error.notReady', { port })}${t('dialog.logPath', { path: paths.logFile })}`)
  }
  if (!window.isDestroyed()) await window.loadURL(`http://127.0.0.1:${port}/`)
  log(`dsh ${runtime.version} serving on ${port} (slot ${runtime.slot})`)
  clearPluginSuspect()
  // Anything that arrived while the app was still starting — which is every
  // file that started it — goes in now that there is a composer to reach.
  flushPendingFiles()
}

async function restartServer() {
  clearTimeout(state.restartTimer)
  state.restartTimer = undefined
  // An explicit restart starts the crash-loop budget over.
  state.restarts = 0
  const old = state.child
  state.child = undefined
  if (old) await stopServer(old)
  if (!state.window.isDestroyed()) {
    await state.window.loadFile(path.join(assets, 'loading.html'), { search: `lang=${getLocale()}` })
  }
  await launchServer()
}

/**
 * Reacts to a server death the shell did not ask for: restart it, backing off
 * and giving up after {@link MAX_AUTO_RESTARTS} consecutive failures.
 *
 * @param {{ code: number | null, signal: string | null, uptimeMs: number }} exit
 */
function superviseExit({ code, signal, uptimeMs }) {
  // A server that ran fine for a while is not part of a crash loop, whatever
  // happened before it.
  if (uptimeMs >= HEALTHY_UPTIME_MS) state.restarts = 0
  if (state.restarts >= MAX_AUTO_RESTARTS) {
    state.restarts = 0
    log(`giving up after ${MAX_AUTO_RESTARTS} automatic restarts`)
    offerRestart(code, signal, t('dialog.gaveUp', { count: MAX_AUTO_RESTARTS }))
    return
  }
  const attempt = ++state.restarts
  const delayMs = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length) - 1]
  log(`auto-restarting in ${delayMs}ms (attempt ${attempt}/${MAX_AUTO_RESTARTS})`)
  if (state.window && !state.window.isDestroyed()) {
    state.window.loadFile(path.join(assets, 'loading.html'), { search: `lang=${getLocale()}` }).catch(() => {})
  }
  state.restartTimer = setTimeout(() => {
    state.restartTimer = undefined
    if (state.quitting || state.child) return
    launchServer().catch(error => {
      log(`automatic restart failed: ${error?.stack ?? error}`)
      offerRestart(code, signal, t('dialog.autoRestartFailed', { message: error?.message ?? error }))
    })
  }, delayMs)
}

/** Reports an exit the shell could not recover from, with a retry button. */
function offerRestart(code, signal, detail) {
  // A plugin touched moments ago is the likeliest cause and the easiest fix,
  // so it leads: the first button undoes it, and the ordinary restart stays
  // available for someone who disagrees.
  const suspect = pluginSuspect()
  const buttons = suspect
    ? [t(`button.undo.${suspect.kind}`, { name: suspect.name }), t('button.restartService'), t('button.ignore')]
    : [t('button.restartService'), t('button.ignore')]
  dialog.showMessageBox(state.window, {
    type: 'error',
    message: t('dialog.serverExited', { cause: describeExit(code, signal) }),
    detail: [
      detail,
      suspect ? t('dialog.pluginSuspect', { name: suspect.name }) : '',
      t('dialog.logPath', { path: paths.logFile }),
    ].filter(Boolean).join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
  }).then(({ response }) => {
    if (suspect && response === 0) {
      undoPluginOp(suspect).catch(e => errorDialog(t('dialog.undoFailed'), e))
      return
    }
    if (response === (suspect ? 1 : 0)) restartServer().catch(e => errorDialog(t('dialog.restartFailed'), e))
  })
}

/**
 * Checks what the chosen channel offers, and installs it only if the user
 * agrees.
 *
 * The check is a registry lookup, not an install: this used to download the
 * newest version into the idle slot before it could tell you that you already
 * had it — minutes of waiting, and no say in whether to fetch it at all. The
 * install that follows pins the exact version shown, so a release landing
 * mid-flow cannot substitute itself for the one that was agreed to.
 *
 * A channel can also point *below* what is installed — switching back to
 * stable after running a preview build is the ordinary way there. That is
 * offered too, worded as the move down that it is, because the alternative is
 * a channel the user selected and the app then refuses to act on.
 */
async function updateRuntime() {
  if (state.updating) {
    await dialog.showMessageBox(state.window, { message: t('dialog.updateBusy') })
    return
  }
  state.updating = true
  try {
    setUpdatePhase('checking')
    const pointer = await readPointer(paths.runtimeBase)
    const current = pointer?.version ?? state.runtime?.version
    const wanted = runtimeChannel()
    let offer
    try {
      offer = await channelVersion({ toolchain: state.toolchain, channel: wanted })
    } catch (error) {
      throw new Error(t('error.checkFailed', { message: error?.message ?? error }))
    }
    const latest = offer.version
    log(`update check (${wanted}${offer.channel === wanted ? '' : ` → ${offer.channel}`}): installed ${current}, offered ${latest}`)
    setUpdatePhase(null)
    if (latest === current) {
      // The other channel is already in hand from the same request. Saying so
      // is the difference between "you are up to date" and the puzzle of an
      // app calling a version current while a newer one is plainly published.
      const elsewhere = CHANNELS
        .filter(id => id !== offer.channel)
        .map(id => ({ id, version: offer.tags?.[id] }))
        .find(({ version }) => version && compareVersions(version, current) > 0)
      await dialog.showMessageBox(state.window, {
        message: t('dialog.upToDate', { version: current }),
        detail: elsewhere
          ? t('dialog.newerElsewhere', {
            version: elsewhere.version, channel: t(`channel.${elsewhere.id}`), menu: t('menu.runtimeChannel'),
          })
          : undefined,
      })
      return
    }

    const older = compareVersions(latest, current) < 0
    const { response: confirm } = await dialog.showMessageBox(state.window, {
      type: 'question',
      message: t(older ? 'dialog.downgradeAvailable' : 'dialog.updateAvailable', { latest }),
      detail: [
        t(older ? 'dialog.downgradeAvailableDetail' : 'dialog.updateAvailableDetail', { current }),
        offer.channel === wanted
          ? t('dialog.fromChannel', { channel: t(`channel.${offer.channel}`) })
          : t('dialog.channelEmpty', {
            wanted: t(`channel.${wanted}`), channel: t(`channel.${offer.channel}`),
          }),
      ].join('\n\n'),
      buttons: [t(older ? 'button.switchVersion' : 'button.update'), t('button.cancel')],
      defaultId: 0,
      cancelId: 1,
    })
    if (confirm !== 0) return

    const target = inactiveSlot(pointer?.slot)
    const dir = slotDir(paths.runtimeBase, target)
    log(`installing ${DSH_PACKAGE}@${latest} into ${target} …`)
    setUpdatePhase('installing', { version: latest })
    const version = await installIntoSlot({
      toolchain: state.toolchain, dir, spec: `${DSH_PACKAGE}@${latest}`, log,
    })

    // Boot test in the new slot before committing to it.
    setUpdatePhase('verifying')
    const testPort = await getFreePort()
    const probe = await startServer({
      slotDir: dir, port: testPort, dshHome: paths.dshHome,
      cwd: homedir(), toolchain: state.toolchain, log,
    })
    const ok = await waitHealthy(testPort, { timeoutMs: 120_000 })
    await stopServer(probe)
    if (!ok) throw new Error(`${t('error.selfTestFailed', { version })}${t('dialog.logPath', { path: paths.logFile })}`)
    await activateSlot(paths.runtimeBase, { slot: target, version })
    state.runtime = { slot: target, dir, version }
    log(`activated ${version} in ${target}`)
    // The slot just left behind is now the way back.
    await refreshRollbackTarget()
    setUpdatePhase(null)

    const { response } = await dialog.showMessageBox(state.window, {
      message: t(older ? 'dialog.switched' : 'dialog.updated', { version }),
      detail: t('dialog.updatedDetail'),
      buttons: [t('button.restartService'), t('button.later')],
      defaultId: 0,
      cancelId: 1,
    })
    if (response === 0) await restartServer()
  } finally {
    // Covers the cancelled and failed paths too: the tray must never be left
    // claiming an update is running.
    setUpdatePhase(null)
    state.updating = false
  }
}

/**
 * The version sitting in the other slot, when it is a complete install.
 *
 * Dual-slot updates leave the previous runtime where it was, so the way back
 * from a bad one is already on disk — it just had no way to be chosen. This
 * is read once at startup and after anything that moves the pointer, because
 * a menu is built synchronously and cannot go and look.
 */
async function refreshRollbackTarget() {
  try {
    const pointer = await readPointer(paths.runtimeBase)
    // No pointer means no active slot to go back FROM: inactiveSlot() would
    // name slot-a, which in that state is as likely to be the one running.
    const slot = pointer ? inactiveSlot(pointer.slot) : undefined
    const version = slot ? await installedVersion(slotDir(paths.runtimeBase, slot)) : undefined
    // The same version in both slots is a reinstall, not a way back.
    state.rollback = version && version !== pointer.version ? { slot, version } : undefined
  } catch {
    state.rollback = undefined
  }
  buildMenu()
  if (state.tray && !state.tray.isDestroyed()) state.tray.setContextMenu(trayMenu())
}

/**
 * Switches back to the runtime in the other slot.
 *
 * No boot test, unlike an update: this version was running on this machine
 * before, and the point of a way back is that it is quick. A restart that
 * fails lands in the same supervision an ordinary one does, and the pointer
 * can be moved again.
 */
async function rollbackRuntime() {
  const target = state.rollback
  if (!target) return
  const { response } = await dialog.showMessageBox(state.window, {
    type: 'question',
    message: t('dialog.rollbackConfirm', { version: target.version }),
    detail: t('dialog.rollbackDetail', { current: state.runtime?.version ?? '' }),
    buttons: [t('button.rollback'), t('button.cancel')],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) return
  await activateSlot(paths.runtimeBase, { slot: target.slot, version: target.version })
  state.runtime = { slot: target.slot, dir: slotDir(paths.runtimeBase, target.slot), version: target.version }
  log(`rolled back to ${target.version} in ${target.slot}`)
  await refreshRollbackTarget()
  await restartServer()
}

// ── Living in the background ────────────────────────────────────────────────
// This app is a service with a window, not a document editor: it is opened
// once and left running. Three settings follow from that — start with the
// machine, start out of the way, and come back the size it was.

/**
 * The window rectangle to restore, if it still lands on a screen.
 *
 * A saved rectangle can name a monitor that has since been unplugged, and a
 * window restored onto it is invisible with no way to fetch it back. So the
 * bounds are only honoured while they still overlap a display's work area;
 * otherwise the window opens where a new one would.
 */
function savedBounds() {
  return visibleBounds(readSettings().windowBounds, screen.getAllDisplays().map(display => display.workArea))
}

/**
 * Records the window's size and position as the user leaves them.
 *
 * Debounced because resizing fires continuously, and reading the normal
 * bounds rather than the current ones so that quitting while maximised
 * restores a maximised window over its old size rather than a full-screen
 * rectangle that cannot be un-maximised back to anything.
 */
function rememberBounds(window) {
  let timer
  const save = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (window.isDestroyed() || window.isMinimized()) return
      writeSettings({ windowBounds: window.getNormalBounds(), windowMaximized: window.isMaximized() })
    }, 500)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) window.on(event, save)
}

/** Whether the app is registered to start with the machine. */
function opensAtLogin() {
  try {
    return app.getLoginItemSettings().openAtLogin
  } catch {
    // Not every platform has login items; not having one is the answer.
    return false
  }
}

function setOpensAtLogin(enabled) {
  // `openAsHidden` is macOS-only and covers only the login case; the app's
  // own startHidden setting is what actually decides, so both paths agree.
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: readSettings().startHidden === true })
  log(`open at login: ${enabled}`)
}

// ── Files from the desktop ──────────────────────────────────────────────────
// Three ways in — Finder's Open With and the Dock icon on macOS, the Send to
// menu on Windows, and dragging onto the window on both — all arriving at
// one place: the paths go into the chat composer.

/** Paths that arrived before there was a window and a server to put them in. */
const pendingFiles = []

/**
 * Puts paths into the composer, or into the clipboard when it will not have
 * them.
 *
 * The UI belongs to the runtime and its markup is free to change, so the
 * result of the insertion is read back rather than assumed. Everything that
 * can go wrong — no workspace open so the composer is read-only, a UI that
 * renders something other than a textarea, a page still loading — ends the
 * same way: the paths are on the clipboard and the user is told, which is
 * one keystroke from where they wanted them.
 *
 * @param {string[]} paths
 */
async function sendFilesToChat(paths) {
  const text = formatPaths(paths)
  if (!text) return
  // Held until there is something to insert into; flushed by launchServer.
  if (!state.port || !state.window || state.window.isDestroyed()) {
    pendingFiles.push(...paths)
    log(`file send held until the server is up: ${paths.length} path(s)`)
    return
  }
  showWindow()
  let outcome
  try {
    outcome = await state.window.webContents.executeJavaScript(insertionScript(text), true)
  } catch (error) {
    outcome = { ok: false, why: String(error?.message ?? error) }
  }
  if (outcome?.ok) {
    log(`sent ${paths.length} path(s) to the chat`)
    return
  }
  clipboard.writeText(text)
  log(`could not reach the composer (${outcome?.why ?? 'unknown'}); paths copied to the clipboard`)
  notify(t('notify.filesCopied'), t('notify.filesCopiedBody', { count: paths.length }))
}

/** Flushes whatever arrived while the app was still starting. */
function flushPendingFiles() {
  if (pendingFiles.length === 0) return
  const paths = pendingFiles.splice(0, pendingFiles.length)
  sendFilesToChat(paths).catch(error => log(`file send failed: ${error?.message ?? error}`))
}

/** A notification when there is one, a dialog when there is not. */
function notify(title, body) {
  try {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show()
      return
    }
  } catch (error) {
    log(`notification failed: ${error?.message ?? error}`)
  }
  dialog.showMessageBox(state.window, { message: title, detail: body, buttons: [t('button.ok')] })
}

/**
 * Adds or removes the Windows "Send to" shortcut.
 *
 * The shortcut is a .lnk, which is a COM object rather than a file format
 * anything here can write, so Windows is asked to make it — the same way a
 * person would, through the Windows Script Host.
 *
 * @param {boolean} wanted
 */
async function setSendToShortcut(wanted) {
  const link = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'DeepSeek Harness.lnk')
  if (!wanted) {
    await rm(link, { force: true })
    log('send-to shortcut removed')
    return
  }
  const script = [
    '$ErrorActionPreference = "Stop"',
    '$shell = New-Object -ComObject WScript.Shell',
    `$link = $shell.CreateShortcut(${powershellString(link)})`,
    `$link.TargetPath = ${powershellString(process.execPath)}`,
    `$link.WorkingDirectory = ${powershellString(path.dirname(process.execPath))}`,
    '$link.Save()',
  ].join('; ')
  await new Promise((resolve, reject) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
    })
    let err = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { err += chunk })
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(err.trim() || `powershell exit ${code}`))))
  })
  log(`send-to shortcut written to ${link}`)
}

/** Single-quoted PowerShell literal: the only escape inside one is ''. */
function powershellString(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function sendToShortcutExists() {
  return process.platform === 'win32'
    && existsSync(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'SendTo', 'DeepSeek Harness.lnk'))
}

// ── Data snapshots ──────────────────────────────────────────────────────────
// Everything else has a way back: the runtime keeps the previous version in
// the other slot, a hot update falls back to the packaged shell, a plugin can
// be switched off. Sessions have none, and they are the part the user made.

/** Writes a snapshot of DSH_HOME wherever the user chooses. */
async function exportSnapshot() {
  const stamp = new Date().toISOString().slice(0, 10)
  const { canceled, filePath } = await dialog.showSaveDialog(state.window, {
    title: t('dialog.snapshotSave'),
    defaultPath: path.join(app.getPath('downloads'), `dsh-snapshot-${stamp}.tar.gz`),
    filters: [{ name: 'tar.gz', extensions: ['tar.gz', 'tgz'] }],
  })
  if (canceled || !filePath) return
  const { bytes } = await createSnapshot({ dshHome: paths.dshHome, file: filePath, log })
  await dialog.showMessageBox(state.window, {
    message: t('dialog.snapshotDone', { size: Math.max(1, Math.round(bytes / 1024 / 1024)) }),
    detail: filePath,
    buttons: [t('button.ok')],
  })
}

/**
 * Replaces DSH_HOME with a snapshot's contents.
 *
 * The server is stopped first — the directory is moved out from under it —
 * and started again on the restored data, so the app ends up in a state the
 * user can look at rather than one they have to relaunch into.
 */
async function importSnapshot() {
  const { canceled, filePaths } = await dialog.showOpenDialog(state.window, {
    title: t('dialog.snapshotOpen'),
    filters: [{ name: 'tar.gz', extensions: ['tar.gz', 'tgz', 'gz'] }],
    properties: ['openFile'],
  })
  const file = filePaths?.[0]
  if (canceled || !file) return

  // Checked before anything is stopped: an archive that is not a data
  // directory should cost the user nothing at all.
  const { looksRight } = await inspectSnapshot({ file, log })
  if (!looksRight) throw new Error(t('error.snapshotNotData'))

  const { response } = await dialog.showMessageBox(state.window, {
    type: 'warning',
    message: t('dialog.snapshotConfirm'),
    detail: t('dialog.snapshotConfirmDetail', { file }),
    buttons: [t('button.restore'), t('button.cancel')],
    defaultId: 1,
    cancelId: 1,
  })
  if (response !== 0) return

  await stopServer(state.child)
  state.child = undefined
  const { backup } = await restoreSnapshot({ dshHome: paths.dshHome, file, log })
  await restartServer()
  await dialog.showMessageBox(state.window, {
    message: t('dialog.snapshotRestored'),
    detail: t('dialog.snapshotRestoredDetail', { backup }),
    buttons: [t('button.ok')],
  })
}

// ── Proxy ───────────────────────────────────────────────────────────────────
// The app has two networks: Chromium's, which the market and the update check
// use, and the environment every child process inherits — npm installing the
// runtime, pnpm installing plugins, and the dsh server calling the model API.
// One setting configures both, because a user has one proxy.

/** The stored setting, defaulted. */
function proxySetting() {
  return proxy.normalize(readSettings().proxy)
}

/**
 * Applies a proxy setting to both networks.
 *
 * The environment is set on this process, which is what makes it reach the
 * children: childEnv() builds every child's environment from process.env.
 * Children already running keep what they started with — the dsh server has
 * to be restarted to pick up a change, which the settings window says.
 *
 * @param {ReturnType<typeof proxySetting>} setting
 */
async function applyProxy(setting) {
  proxy.applyToEnv(setting)
  await session.defaultSession.setProxy(proxy.sessionConfig(setting))
  log(`proxy: ${proxy.describe(setting)}`)
}

/**
 * Tries both networks with a setting, without storing it.
 *
 * Both are tried because they fail independently and for different reasons,
 * and "the market loads but plugins will not install" is exactly the
 * confusion this reports its way out of. Chromium is exercised through a
 * throwaway session so the running one is not reconfigured by a test; npm is
 * exercised by running it, which is the only honest test of a path that
 * belongs to npm.
 *
 * @returns {Promise<Array<{name: string, ok: boolean, detail: string}>>}
 */
async function testProxy(setting) {
  const results = []
  const started = Date.now()
  const probe = session.fromPartition(`proxy-test-${Date.now()}`)
  try {
    await probe.setProxy(proxy.sessionConfig(setting))
    const response = await probe.fetch('https://api.github.com/zen', {
      signal: AbortSignal.timeout(15_000),
    })
    results.push({
      name: t('settings.testApp'),
      ok: response.ok,
      detail: response.ok ? t('settings.testOk', { ms: Date.now() - started }) : `HTTP ${response.status}`,
    })
  } catch (error) {
    results.push({ name: t('settings.testApp'), ok: false, detail: String(error?.message ?? error) })
  }

  const npmStarted = Date.now()
  if (!state.toolchain) {
    // Reachable only when startup failed before resolving a toolchain; the
    // window is still there, and an unanswered half is better than a crash.
    results.push({ name: t('settings.testNpm'), ok: false, detail: t('settings.testUnavailable') })
    return results
  }
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(
        state.toolchain.nodeBin,
        [state.toolchain.npmCli, 'ping', '--loglevel=error'],
        // A copy of the environment with the setting under test applied, so
        // the saved one is not disturbed by a test.
        { env: proxy.applyToEnv(setting, childEnv(state.toolchain)), stdio: 'ignore', windowsHide: true },
      )
      const timer = setTimeout(() => { child.kill(); reject(new Error(t('settings.testTimeout'))) }, 30_000)
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('exit', code => {
        clearTimeout(timer)
        code === 0 ? resolve() : reject(new Error(`npm ping exit ${code}`))
      })
    })
    results.push({ name: t('settings.testNpm'), ok: true, detail: t('settings.testOk', { ms: Date.now() - npmStarted }) })
  } catch (error) {
    results.push({ name: t('settings.testNpm'), ok: false, detail: String(error?.message ?? error) })
  }
  return results
}

function openSettingsWindow() {
  if (state.settingsWindow && !state.settingsWindow.isDestroyed()) {
    state.settingsWindow.show()
    state.settingsWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 660,
    height: 680,
    title: t('window.settings'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'settings-preload.cjs') },
  })
  if (process.platform !== 'darwin') win.removeMenu()
  win.loadFile(path.join(assets, 'settings.html'))
  win.on('closed', () => { state.settingsWindow = undefined })
  state.settingsWindow = win
}

/**
 * The three ways a file reaches the chat.
 *
 * macOS hands them over as `open-file` events — Finder's Open With, and a
 * drop on the Dock icon. Windows starts the app again with the files as
 * arguments, and the running instance is given that command line. A drop on
 * the window itself comes from the preload. All three end in the same call.
 */
function registerFileHandoff() {
  ipcMain.on('chat:files-dropped', (_event, paths) => {
    if (!Array.isArray(paths)) return
    // Logged on arrival as well as on outcome: without this line a drop the
    // page swallowed and a drop that failed to insert look identical
    // afterwards, and they need different fixes.
    log(`drop received: ${paths.length} path(s)`)
    sendFilesToChat(paths.map(String)).catch(error => log(`drop failed: ${error?.message ?? error}`))
  })
  // Alongside the listener that raises the window; this one reads the files
  // out of the command line that Windows started the second instance with.
  app.on('second-instance', (_event, argv) => {
    const paths = pathsFromArgv(argv, existsSync)
    if (paths.length > 0) sendFilesToChat(paths).catch(error => log(`send-to failed: ${error?.message ?? error}`))
  })
}

function registerSettingsIpc() {
  ipcMain.handle('settings:get-proxy', () => ({
    proxy: proxySetting(),
    fromEnv: proxy.proxyFromEnv(),
    alwaysDirect: proxy.ALWAYS_DIRECT,
  }))
  // Answers with an outcome rather than by throwing: an IPC rejection reaches
  // the window wrapped in "Error invoking remote method …", which is true and
  // useless to someone who mistyped a port.
  ipcMain.handle('settings:set-proxy', async (_event, raw) => {
    const setting = proxy.normalize(raw)
    if (setting.mode === 'manual') {
      // Validated here rather than trusted from the window: a malformed URL
      // saved into settings.json would fail on the next launch, far from the
      // person who typed it.
      try {
        proxy.normalizeUrl(setting.url)
      } catch (error) {
        return { ok: false, message: t(`error.proxyUrl.${error.message}`) }
      }
    }
    writeSettings({ proxy: setting })
    await applyProxy(setting)
    return { ok: true }
  })
  ipcMain.handle('settings:test-proxy', (_event, raw) => testProxy(proxy.normalize(raw)))
}

// ── Shell updates ───────────────────────────────────────────────────────────
// The app updates itself in two ways, decided by the release rather than by
// the user: a new shell is downloaded and booted from the data directory,
// while anything that changes the packaged bundle needs its installer.

/** The shell that is actually running: a hot-updated one, or what shipped. */
function shellVersion() {
  return globalThis.__dshShellBundle?.version ?? app.getVersion()
}

/**
 * Checks for a newer shell and applies it.
 *
 * @param {{silent?: boolean}} [options] a silent check says nothing when
 *   there is no update and nothing when the network is down — it runs at
 *   startup, where neither is news.
 */
async function updateApp({ silent = false } = {}) {
  if (state.updating) {
    if (!silent) await dialog.showMessageBox(state.window, { message: t('dialog.updateBusy') })
    return
  }
  state.updating = true
  try {
    const current = shellVersion()
    if (!silent) setUpdatePhase('checking')
    let release
    let manifest
    try {
      release = await fetchLatestRelease({ fetchImpl: net.fetch })
      manifest = await fetchShellManifest(release, { fetchImpl: net.fetch })
    } catch (error) {
      log(`app update check failed: ${error?.message ?? error}`)
      if (silent) return
      throw new Error(t('error.checkFailed', { message: error?.message ?? error }))
    }
    const decision = plan({ current, electronVersion: process.versions.electron, release, manifest })
    log(`app update check: running ${current}, published ${release.version} → ${decision.kind}`)
    setUpdatePhase(null)

    if (decision.kind === 'current') {
      if (!silent) await dialog.showMessageBox(state.window, { message: t('dialog.appUpToDate', { version: current }) })
      return
    }
    // Release notes are the author's own words, and the first lines are the
    // ones worth showing in a box this size.
    const notes = release.notes.split('\n').slice(0, 8).join('\n')
    const { response } = await dialog.showMessageBox(state.window, {
      type: 'question',
      message: t('dialog.appUpdateAvailable', { version: release.version }),
      detail: `${t(decision.kind === 'hot' ? 'dialog.appUpdateHot' : 'dialog.appUpdateInstall', { current })}${notes ? `\n\n${notes}` : ''}`,
      buttons: [t(decision.kind === 'hot' ? 'button.update' : 'button.download'), t('button.later')],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) return

    if (decision.kind === 'hot') {
      setUpdatePhase('downloadingShell', { version: release.version })
      await stageShellUpdate({ release, manifest, shellDir: paths.shellDir, fetchImpl: net.fetch, log })
      setUpdatePhase(null)
      const { response: restart } = await dialog.showMessageBox(state.window, {
        message: t('dialog.appUpdateStaged', { version: release.version }),
        detail: t('dialog.appUpdateStagedDetail'),
        buttons: [t('button.restartApp'), t('button.restartLater')],
        defaultId: 0,
        cancelId: 1,
      })
      // Not setting state.quitting: before-quit reads it to tell a shutdown
      // already under way from a new request, and skipping it would leave the
      // server running for the relaunched app to collide with.
      if (restart === 0) { app.relaunch(); app.quit() }
      return
    }

    setUpdatePhase('downloadingInstaller', { version: release.version })
    const file = await downloadInstaller({ release, dir: paths.downloads, fetchImpl: net.fetch, log })
    setUpdatePhase(null)
    await dialog.showMessageBox(state.window, {
      message: t('dialog.appInstallerReady', { version: release.version }),
      detail: t('dialog.appInstallerDetail'),
      buttons: [t('button.ok')],
    })
    // Opened rather than run for the user: replacing a running app from
    // inside itself is how you end up with neither copy, and the platform's
    // installer already knows how to do it properly.
    shell.showItemInFolder(file)
    await shell.openPath(file)
  } finally {
    setUpdatePhase(null)
    state.updating = false
  }
}

/**
 * Tells the hot-update machinery that this shell starts. Called once the app
 * has a window and a server, which is the definition the rollback rule cares
 * about; boot.js also confirms on its own after a minute, in case a future
 * shell forgets to call this.
 */
function confirmShell() {
  const bundle = globalThis.__dshShellBundle
  if (!bundle) return
  try {
    if (confirmBundle(paths.shellDir, bundle.version)) log(`shell ${bundle.version} confirmed`)
  } catch (error) {
    log(`could not confirm shell ${bundle.version}: ${error?.message ?? error}`)
  }
}

// ── Plugin manager ──────────────────────────────────────────────────────────
// Installs/removes dsh plugins by driving the runtime's own `dsh plugin`
// command against the web profile — the shell never touches harness source.

const PLUGIN_PROFILE = 'web'

function pluginsLog(line) {
  log(`[plugins] ${line}`)
  for (const win of pluginWindows()) win.webContents.send('plugins:log', line)
}

/** Runs `dsh plugin --profile web <args>` with output streamed to the manager. */
async function runDshPlugin(args) {
  const bin = await dshBinPath(state.runtime.dir)
  await new Promise((resolve, reject) => {
    const child = spawn(
      state.toolchain.nodeBin,
      [bin, 'plugin', '--profile', PLUGIN_PROFILE, ...args],
      {
        cwd: paths.dshHome,
        env: childEnv(state.toolchain, { DSH_HOME: paths.dshHome }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    let tail = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        tail = (tail + chunk).slice(-2000)
        for (const line of chunk.split('\n')) if (line.trim()) pluginsLog(line)
      })
    }
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) return resolve()
      // dsh forwards to pnpm and exits 127 when it cannot find it. That is the
      // likeliest failure on a fresh machine, and "exit code 127" tells the
      // user nothing they can act on.
      if (code === 127 || /pnpm not found/i.test(tail)) return reject(new Error(t('error.pnpmMissing')))
      reject(new Error(withAccessHint(t('error.pluginExit', { code, tail: tail.slice(-400) }))))
    })
  })
}

/** Installed plugins from the profile manifest: name, version, spec, active. */
async function listPlugins() {
  const profileDir = path.join(paths.dshHome, 'profiles', PLUGIN_PROFILE)
  let manifest
  try {
    manifest = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
  } catch {
    return []
  }
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const disabled = new Set(await getDisabledPlugins(profileDir))
  const plugins = []
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    let version
    try {
      const pkg = JSON.parse(
        await readFile(path.join(profileDir, 'node_modules', name, 'package.json'), 'utf8'),
      )
      version = pkg.version
    } catch { /* not installed yet: version stays undefined */ }
    plugins.push({
      name,
      spec: String(spec),
      version,
      active: bundles.includes(name),
      disabled: disabled.has(name),
    })
  }
  return plugins
}

/**
 * The last plugin operation, until a server has started after it.
 *
 * Installing a plugin runs code the user has never run before, inside the
 * server, at startup. When that server then refuses to come back, the shell
 * knows something the user does not: which plugin was touched a moment ago.
 * Saying so — and offering to undo it — turns "the app is broken now" into
 * one button.
 *
 * @type {{name: string, kind: 'install'|'enable'|'update', at: number} | undefined}
 */
let lastPluginOp

/** How long a plugin operation stays a suspect. */
const SUSPECT_WINDOW_MS = 15 * 60 * 1000

function rememberPluginOp(name, kind) {
  if (!name) return
  lastPluginOp = { name, kind, at: Date.now() }
  log(`plugin operation recorded: ${kind} ${name}`)
}

/** Cleared by a server that starts: whatever happens later is not this. */
function clearPluginSuspect() {
  if (lastPluginOp) log(`plugin operation cleared by a healthy server: ${lastPluginOp.name}`)
  lastPluginOp = undefined
}

/** The plugin worth blaming for a server that will not start, if any. */
function pluginSuspect() {
  if (!lastPluginOp) return undefined
  return Date.now() - lastPluginOp.at < SUSPECT_WINDOW_MS ? lastPluginOp : undefined
}

/**
 * Undoes the last plugin operation and starts the server again.
 *
 * An install is undone by removing — the plugin was not there a minute ago
 * and nothing is lost by putting things back. Enabling and updating are
 * undone by switching the plugin off, which keeps it and its configuration
 * for whenever the user wants to look into why.
 */
async function undoPluginOp(suspect) {
  await withPluginLock(async () => {
    if (suspect.kind === 'install') {
      await runDshPlugin(['remove', suspect.name])
    } else {
      await setPluginEnabled(suspect.name, false)
    }
  })
  clearPluginSuspect()
  await restartServer()
}

/** Serializes plugin operations; concurrent requests fail fast. */
async function withPluginLock(work) {
  if (state.pluginBusy) throw new Error(t('error.pluginBusy'))
  state.pluginBusy = true
  try {
    return await work()
  } finally {
    state.pluginBusy = false
  }
}

/**
 * The two plugin windows. They are separate windows rather than two tabs of
 * one: managing what is installed and shopping for something new are
 * different jobs, done at different moments, and a market that can only be
 * reached through the manager is a market hidden inside a settings screen.
 *
 * They share one page. Everything around a plugin operation — the command
 * log, the restart notice, the busy state, the generated config form — is
 * the same in both, and duplicating that into a second page would mean
 * maintaining it twice for the sake of which list is on screen.
 */
const PLUGIN_WINDOWS = {
  installed: { title: 'window.plugins', width: 760, height: 640 },
  market: { title: 'window.market', width: 860, height: 700 },
}

/** Every plugin window currently open. */
function pluginWindows() {
  return Object.values(state.pluginWindows).filter(win => win && !win.isDestroyed())
}

/** @param {keyof PLUGIN_WINDOWS} mode */
function openPluginWindow(mode) {
  const open = state.pluginWindows[mode]
  if (open && !open.isDestroyed()) {
    open.show()
    open.focus()
    return
  }
  const spec = PLUGIN_WINDOWS[mode]
  const win = new BrowserWindow({
    width: spec.width,
    height: spec.height,
    title: t(spec.title),
    // Windows and Linux draw the application menu inside every window, and
    // these windows are not the application: they have their own controls and
    // a menu bar over them is a second, irrelevant one. macOS keeps its menu
    // where it belongs, at the top of the screen.
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'plugins-preload.cjs') },
  })
  if (process.platform !== 'darwin') win.removeMenu()
  // The mode is in the URL rather than a message sent after load, so the
  // first painted frame is already the right window.
  win.loadFile(path.join(assets, 'plugins.html'), { search: `mode=${mode}` })
  win.on('closed', () => { delete state.pluginWindows[mode] })
  state.pluginWindows[mode] = win
}

function pluginProfileDir() {
  return path.join(paths.dshHome, 'profiles', PLUGIN_PROFILE)
}

/** Asks for a plugin zip. @returns {Promise<string|null>} null when cancelled */
async function pickPluginZip() {
  const { canceled, filePaths } = await dialog.showOpenDialog(state.pluginWindows.installed, {
    title: t('dialog.pickPluginZip'),
    filters: [{ name: 'Zip', extensions: ['zip'] }],
    properties: ['openFile'],
  })
  return canceled ? null : (filePaths?.[0] ?? null)
}

/**
 * Unpacks a plugin zip into the shell's plugin directory and installs it
 * from there — the same local-path install the spec field accepts, with the
 * unpacking done for the user.
 *
 * @param {string} zipPath
 * @returns {Promise<string>} the installed package name
 */
async function installPluginZip(zipPath) {
  const { name, version, dir } = await unpackPluginZip({
    zipPath, pluginsDir: paths.pluginsDir, log: pluginsLog,
  })
  pluginsLog(`installing ${name}${version ? `@${version}` : ''} from ${dir}`)
  await runDshPlugin(['add', dir])
  return name
}

/**
 * The catalog the market reads. Settable in settings.json for anyone who
 * curates their own list or prefers another one; there is no UI for it,
 * because picking a source is not a decision an ordinary install involves.
 */
function catalogUrl() {
  const configured = readSettings().marketCatalogUrl
  return typeof configured === 'string' && configured.trim() ? configured.trim() : DEFAULT_CATALOG_URL
}

/** Opens a catalog link in the user's browser, never in an app window. */
function openMarketLink(url) {
  const parsed = new URL(String(url))
  // openExternal hands the string to the OS, which will happily act on
  // file:// or a custom scheme registered by some other application.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(t('error.marketBadLink'))
  return shell.openExternal(parsed.toString())
}

/**
 * Switches a plugin off, or back on, without uninstalling it.
 *
 * The switch is a `disabled: true` override on the plugin's loader row — the
 * runtime's own mechanism, written into the same managed patch block as the
 * config values. Not the profile's bundle list: `dsh plugin` rebuilds that
 * from what is installed on every operation, so a plugin taken out of it
 * would come back the next time anything else was installed.
 *
 * @param {string} name @param {boolean} enabled
 */
async function setPluginEnabled(name, enabled) {
  const profileDir = pluginProfileDir()
  // The row id only: this must work for the plugin whose code throws on
  // import, which is exactly the one someone wants to switch off.
  const probe = await probePluginConfig({
    nodeBin: state.toolchain.nodeBin,
    probePath: path.join(here, 'plugin-config-probe.mjs'),
    profileDir,
    runtimeDir: state.runtime.dir,
    name,
    env: childEnv(state.toolchain, { DSH_HOME: paths.dshHome }),
    locale: getLocale(),
    log: pluginsLog,
    rowOnly: true,
  })
  if (probe.error) throw new Error(probe.error)
  if (!probe.rowId) throw new Error(t('error.pluginNoRow', { name }))
  await setPluginDisabled(profileDir, name, probe.rowId, !enabled)
  pluginsLog(`${name} ${enabled ? 'enabled' : 'disabled'} (row ${probe.rowId})`)
}

/**
 * The registry npm is configured to use.
 *
 * Read from npm rather than assumed, and remembered for the session: a
 * mirror is the normal setup wherever the default registry is slow, and an
 * update check against the wrong one reports nothing to update.
 */
async function npmRegistry() {
  if (state.registry) return state.registry
  state.registry = await new Promise(resolve => {
    const child = spawn(
      state.toolchain.nodeBin,
      [state.toolchain.npmCli, 'config', 'get', 'registry'],
      { env: childEnv(state.toolchain), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', () => resolve('https://registry.npmjs.org'))
    child.on('exit', () => resolve(out.trim() || 'https://registry.npmjs.org'))
  })
  log(`npm registry: ${state.registry}`)
  return state.registry
}

function registerPluginIpc() {
  // Synchronous by design: the plugin window's preload needs the strings
  // before the page renders. The payload is a plain object of short strings.
  ipcMain.on('i18n:strings', event => {
    event.returnValue = { locale: getLocale(), messages: messages() }
  })
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:install', (_event, spec) => withPluginLock(async () => {
    // A pasted repository page is translated into the spec pnpm wants; the
    // translation is logged, because "I asked for a URL and it installed
    // something else" deserves to be visible rather than magic.
    const target = normalizeSpec(spec)
    if (target.from) pluginsLog(`${target.from} → ${target.value}`)
    // Which package a spec turns into is pnpm's answer, not ours, so it is
    // read from the profile afterwards — that name is what a failed boot
    // will need to point at.
    const before = new Set((await listPlugins()).map(plugin => plugin.name))
    await runDshPlugin(['add', target.value])
    const added = (await listPlugins()).filter(plugin => !before.has(plugin.name))
    if (added.length === 1) rememberPluginOp(added[0].name, 'install')
  }))
  ipcMain.handle('plugins:pick-zip', () => pickPluginZip())
  ipcMain.handle('plugins:install-zip', (_event, zipPath) => withPluginLock(() => installPluginZip(String(zipPath))))
  ipcMain.handle('plugins:remove', (_event, name) => withPluginLock(() => runDshPlugin(['remove', String(name)])))
  // `dsh plugin` forwards to pnpm, so an update is pnpm's own: --latest to
  // cross the semver range the profile recorded, and minimumReleaseAge=0
  // because an explicit click should not wait out a publish quarantine.
  ipcMain.handle('plugins:update', (_event, name) => withPluginLock(async () => {
    await runDshPlugin(['update', '--latest', '--config.minimumReleaseAge=0', String(name)])
    rememberPluginOp(String(name), 'update')
  }))
  ipcMain.handle('plugins:set-enabled', (_event, name, enabled) => withPluginLock(async () => {
    await setPluginEnabled(String(name), Boolean(enabled))
    if (enabled) rememberPluginOp(String(name), 'enable')
  }))
  // Outside the plugin lock and never fatal: this is a background question
  // about the registry, and its answer only adds a badge.
  ipcMain.handle('plugins:check-updates', async () => findPluginUpdates({
    plugins: await listPlugins(),
    registry: await npmRegistry(),
    fetchImpl: net.fetch,
    log: pluginsLog,
  }))
  ipcMain.handle('plugins:open-link', (_event, url) => openMarketLink(url))
  // Deliberately outside the plugin lock: reading the catalog changes
  // nothing, and it must stay available while an install is running.
  ipcMain.handle('market:catalog', (_event, force) => loadCatalog({
    url: catalogUrl(),
    cacheFile: paths.marketCache,
    force: Boolean(force),
    log: pluginsLog,
    // Chromium's stack rather than Node's: it follows the machine's proxy and
    // PAC settings, which a packaged app launched from Finder or the Start
    // menu cannot learn from the environment.
    fetchImpl: net.fetch,
  }))
  ipcMain.handle('plugins:restart', () => restartServer())
  ipcMain.handle('plugins:config-schema', (_event, name) => probePluginConfig({
    nodeBin: state.toolchain.nodeBin,
    probePath: path.join(here, 'plugin-config-probe.mjs'),
    profileDir: pluginProfileDir(),
    runtimeDir: state.runtime.dir,
    name: String(name),
    env: childEnv(state.toolchain, { DSH_HOME: paths.dshHome }),
    locale: getLocale(),
    log: pluginsLog,
  }))
  ipcMain.handle('plugins:config-get', (_event, name) => getPluginConfigValues(pluginProfileDir(), String(name)))
  ipcMain.handle('plugins:config-set', (_event, name, rowId, values) => withPluginLock(
    () => setPluginConfig(pluginProfileDir(), String(name), String(rowId), values),
  ))
}

/** The tray menu is rebuilt whenever a menu item's state changes. */
function refreshTrayMenu() {
  if (state.tray && !state.tray.isDestroyed()) state.tray.setContextMenu(trayMenu())
}

// ── Skills ──────────────────────────────────────────────────────────────────
// A skill is a directory with a SKILL.md in it, discovered by dsh from a list
// of roots and picked up live. There is no CLI behind any of this — `dsh` has
// `web` and `plugin` and nothing else — so unlike the plugin manager, which
// drives `dsh plugin`, this window is the only way to do any of it, and the
// only place a malformed skill is ever reported: dsh's own answer to one is a
// log line at a level it does not print.

function skillsDir() {
  return path.join(paths.dshHome, SKILLS_DIR)
}

/**
 * The roots to show, in the order dsh consults them.
 *
 * The bundled root comes from the environment because that is the only place
 * the shell could learn it: which preset is active, and where its skills
 * live, is dsh's business. Unset, it is simply not shown — better than a
 * guess at a path that would quietly list the wrong preset's skills.
 */
function skillRoots() {
  return {
    dshHome: paths.dshHome,
    agentsHome: process.env.DSH_AGENTS_HOME ?? path.join(homedir(), '.agents'),
    bundledDir: process.env.DSH_BUNDLED_SKILL_DIR,
  }
}

function skillsLog(line) {
  log(`[skills] ${line}`)
  const win = state.skillsWindow
  if (win && !win.isDestroyed()) win.webContents.send('skills:log', line)
}

/**
 * Resolves an entry name from the window to a skill in the writable root.
 *
 * The name arrives over IPC and is never trusted as a path: it has to match
 * something the shell just listed in its own root, which is a stricter test
 * than checking for `..` and needs no separate one.
 */
async function writableSkill(entry) {
  const skills = await listSkills(skillRoots())
  const skill = skills.find(candidate => candidate.entry === String(entry) && candidate.writable)
  if (skill === undefined) throw new Error('outside-root')
  return skill
}

function openSkillsWindow() {
  const open = state.skillsWindow
  if (open && !open.isDestroyed()) {
    open.show()
    open.focus()
    return
  }
  const win = new BrowserWindow({
    width: 780,
    height: 640,
    title: t('window.skills'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'skills-preload.cjs') },
  })
  if (process.platform !== 'darwin') win.removeMenu()
  win.loadFile(path.join(assets, 'skills.html'))
  win.on('closed', () => { state.skillsWindow = null })
  state.skillsWindow = win
}

function registerSkillIpc() {
  ipcMain.handle('skills:list', () => listSkills(skillRoots()))

  ipcMain.handle('skills:pick-directory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(state.skillsWindow, {
      title: t('skills.installFolder'),
      // A lone markdown file is a skill too, so the picker takes either
      // rather than making the user know which shape they have.
      properties: ['openDirectory', 'openFile'],
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    })
    return canceled ? null : (filePaths?.[0] ?? null)
  })

  ipcMain.handle('skills:pick-zip', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(state.skillsWindow, {
      title: t('skills.installZip'),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    return canceled ? null : (filePaths?.[0] ?? null)
  })

  ipcMain.handle('skills:install-directory', (_event, source) => installFromDirectory({
    source: String(source), skillsDir: skillsDir(), log: skillsLog,
  }))
  ipcMain.handle('skills:install-zip', (_event, zipPath) => installFromZip({
    zipPath: String(zipPath), skillsDir: skillsDir(), log: skillsLog,
  }))

  ipcMain.handle('skills:set-enabled', async (_event, entry, enabled) => {
    const skill = await writableSkill(entry)
    await setSkillEnabled(skill, enabled === true)
    skillsLog(`${skill.name ?? skill.entry} ${enabled === true ? 'on' : 'off'}`)
  })

  ipcMain.handle('skills:remove', async (_event, entry) => {
    const skill = await writableSkill(entry)
    await removeSkill({ skillsDir: skillsDir(), entry: skill.entry })
    skillsLog(`${skill.name ?? skill.entry} removed`)
  })

  ipcMain.handle('skills:reveal', async (_event, entry) => {
    if (entry === null || entry === undefined) {
      // Created on the way: the root does not exist until the first install,
      // and a button that opens nothing is worse than one that opens an empty
      // folder the user can drop a skill into.
      await mkdir(skillsDir(), { recursive: true })
      return shell.openPath(skillsDir())
    }
    const skills = await listSkills(skillRoots())
    const skill = skills.find(candidate => candidate.entry === String(entry))
    if (skill === undefined) return undefined
    return shell.showItemInFolder(skill.file)
  })
}

/** Shared between the application menu and the tray context menu. */
function skillItems() {
  return [{ label: t('menu.skillManage'), click: openSkillsWindow }]
}

/** Shared between the application menu and the tray context menu. */
function languageItems() {
  return LOCALES.map(({ id, label }) => ({
    // A checkmark in the label rather than `type: 'radio'`: Electron invokes a
    // radio item's click handler while it synchronises group state as the menu
    // is shown, so radio items here switched the language merely because the
    // user opened the menu. Plain items only fire when actually chosen.
    //
    // Each language is labelled in its own language, never translated: someone
    // who landed in one they cannot read has to recognise the way out.
    label: getLocale() === id ? `\u2713 ${label}` : `\u2007\u2007${label}`,
    click: () => applyLocale(id),
  }))
}

/** The update channels, checkmarked for the same reason as the languages. */
function channelItems() {
  const active = runtimeChannel()
  return CHANNELS.map(id => ({
    label: `${active === id ? '✓' : '  '} ${t(`channel.${id}`)}`,
    click: () => {
      writeSettings({ runtimeChannel: id })
      buildMenu()
      refreshTrayMenu()
    },
  }))
}

/** The plugin menu's contents: one entry per tab of the plugin window. */
function pluginItems() {
  return [
    { label: t('menu.pluginMarket'), click: () => openPluginWindow('market') },
    { label: t('menu.pluginManage'), click: () => openPluginWindow('installed') },
  ]
}

/**
 * Everything that is not plugins. Plugins are a menu of their own in the
 * menu bar; the tray has no menu bar, so it nests the same items instead.
 */
function actionItems() {
  return [
    {
      label: t('menu.settings'),
      submenu: [
        { label: t('menu.language'), submenu: languageItems() },
        { label: t('menu.proxy'), click: openSettingsWindow },
        { label: t('menu.runtimeChannel'), submenu: channelItems() },
        { type: 'separator' },
        // Checkmarks in the label rather than `type: 'checkbox'`, for the
        // reason spelled out in languageItems(): Electron fires a checked
        // item's handler while it synchronises state as the menu opens.
        {
          label: `${opensAtLogin() ? '\u2713' : '\u2007\u2007'} ${t('menu.openAtLogin')}`,
          click: () => { setOpensAtLogin(!opensAtLogin()); buildMenu(); refreshTrayMenu() },
        },
        ...(process.platform === 'win32'
          ? [{
            label: `${sendToShortcutExists() ? '\u2713' : '\u2007\u2007'} ${t('menu.sendTo')}`,
            click: () => {
              setSendToShortcut(!sendToShortcutExists())
                .then(() => { buildMenu(); refreshTrayMenu() })
                .catch(e => errorDialog(t('dialog.sendToFailed'), e))
            },
          }]
          : []),
        {
          label: `${readSettings().startHidden ? '\u2713' : '\u2007\u2007'} ${t('menu.startHidden')}`,
          click: () => {
            const next = !readSettings().startHidden
            writeSettings({ startHidden: next })
            // Keep the login item's own hidden flag in step on macOS.
            if (opensAtLogin()) setOpensAtLogin(true)
            buildMenu()
            refreshTrayMenu()
          },
        },
        { type: 'separator' },
        { label: t('menu.dataDir'), click: () => chooseDataDir().catch(e => errorDialog(t('dialog.settingFailed'), e)) },
        { label: t('menu.logDir'), click: () => chooseLogDir().catch(e => errorDialog(t('dialog.settingFailed'), e)) },
      ],
    },
    { type: 'separator' },
    state.update
      ? { label: t('menu.updating'), enabled: false }
      : { label: t('menu.checkAppUpdate'), click: () => updateApp().catch(e => errorDialog(t('dialog.updateFailed'), e)) },
    state.update
      ? { label: t('menu.updating'), enabled: false }
      : { label: t('menu.checkUpdate'), click: () => updateRuntime().catch(e => errorDialog(t('dialog.updateFailed'), e)) },
    ...(state.rollback
      ? [{
        label: t('menu.rollback', { version: state.rollback.version }),
        click: () => rollbackRuntime().catch(e => errorDialog(t('dialog.rollbackFailed'), e)),
      }]
      : []),
    { label: t('menu.restartService'), click: () => restartServer().catch(e => errorDialog(t('dialog.restartFailed'), e)) },
    { type: 'separator' },
    { label: t('menu.exportSnapshot'), click: () => exportSnapshot().catch(e => errorDialog(t('dialog.snapshotFailed'), e)) },
    { label: t('menu.importSnapshot'), click: () => importSnapshot().catch(e => errorDialog(t('dialog.snapshotFailed'), e)) },
    { type: 'separator' },
    { label: t('menu.openDataDir'), click: () => shell.openPath(app.getPath('userData')) },
    { label: t('menu.openLog'), click: () => shell.openPath(paths.logFile) },
  ]
}

/**
 * The Edit menu, spelled out item by item.
 *
 * `role: 'editMenu'` would be shorter, but its submenu labels come from
 * Electron in the SYSTEM language, which leaves an English "Edit" menu full of
 * Chinese items the moment the two disagree. Naming each item keeps the whole
 * menu on the language the user picked; the roles still carry the behaviour
 * and the platform accelerators.
 *
 * It has to exist at all because macOS registers the clipboard shortcuts
 * through the menu: with no such roles anywhere, ⌘C/⌘V/⌘A do nothing in the
 * chat UI.
 */
function editItems() {
  return [
    { role: 'undo', label: t('menu.undo') },
    { role: 'redo', label: t('menu.redo') },
    { type: 'separator' },
    { role: 'cut', label: t('menu.cut') },
    { role: 'copy', label: t('menu.copy') },
    { role: 'paste', label: t('menu.paste') },
    { role: 'selectAll', label: t('menu.selectAll') },
  ]
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: t('menu.main'), submenu: actionItems() },
    { label: t('menu.plugins'), submenu: pluginItems() },
    { label: t('menu.skills'), submenu: skillItems() },
    { label: t('menu.edit'), submenu: editItems() },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: t('menu.showWindow'), click: showWindow },
    { type: 'separator' },
    { label: t('menu.plugins'), submenu: pluginItems() },
    { label: t('menu.skills'), submenu: skillItems() },
    ...actionItems(),
    { type: 'separator' },
    { label: t('menu.quit'), click: () => app.quit() },
  ])
}

function createTray() {
  // macOS wants a `...Template.png` (black + alpha) so it can tint the icon
  // for light/dark menu bars, with the @2x variant beside it for Retina.
  // Windows has no template concept and would draw that same file as a black
  // smudge, so it gets the real icon scaled down instead.
  const icon = process.platform === 'darwin'
    ? nativeImage.createFromPath(path.join(assets, 'trayTemplate.png'))
    : nativeImage.createFromPath(path.join(assets, 'icon-1024.png')).resize({ width: 16, height: 16 })
  const tray = new Tray(icon)
  state.tray = tray
  tray.setContextMenu(trayMenu())
  paintTray()
}

/** mm:ss for a duration that is expected to run into minutes. */
function formatElapsed(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/**
 * Draws the current state onto the tray: its tooltip always, and on macOS a
 * short label beside the icon.
 *
 * The tray is where an update reports progress, because it is the one surface
 * that can be repainted while the user is looking at something else. Menus
 * cannot: an Electron menu is immutable once built, so refreshing a countdown
 * inside one means rebuilding it, which closes the menu the user just opened.
 */
function paintTray() {
  const tray = state.tray
  if (!tray || tray.isDestroyed()) return
  const update = state.update
  if (!update) {
    tray.setToolTip(t('tray.tooltip', { version: state.runtime?.version ?? '' }))
    if (process.platform === 'darwin') tray.setTitle('')
    return
  }
  const elapsed = formatElapsed(Date.now() - update.startedAt)
  tray.setToolTip(t(`tray.${update.phase}`, { ...update.params, elapsed }))
  if (process.platform === 'darwin') tray.setTitle(` ${t('tray.title', { elapsed })}`)
}

/**
 * Enters, advances or leaves the update-progress display.
 *
 * @param {'checking'|'installing'|'verifying'|null} phase null ends it
 * @param {Record<string, string>} [params] values for the phase's message
 */
function setUpdatePhase(phase, params = {}) {
  if (!phase) {
    clearInterval(state.updateTimer)
    state.updateTimer = undefined
    state.update = undefined
    // Restore the context menu's normal "check for updates" entry.
    if (state.tray && !state.tray.isDestroyed()) state.tray.setContextMenu(trayMenu())
    paintTray()
    return
  }
  const startedAt = state.update?.startedAt ?? Date.now()
  const first = !state.update
  state.update = { phase, params, startedAt }
  // The elapsed time lives in the tooltip and the macOS title, which repaint
  // freely. The context menu is rebuilt only when the phase changes, so an
  // open menu is not yanked away once a second.
  if (state.tray && !state.tray.isDestroyed()) state.tray.setContextMenu(trayMenu())
  if (first) state.updateTimer = setInterval(paintTray, 1000)
  paintTray()
}

async function main() {
  initPaths()
  // Run from source, the Dock shows the unbranded Electron.app this process
  // actually lives in. The icon is the half that can be fixed at runtime; the
  // Dock's tooltip stays "Electron" because it comes from that bundle.
  if (!app.isPackaged) app.dock?.setIcon(path.join(assets, 'icon-1024.png'))
  // A saved choice wins; otherwise follow the system language, so a fresh
  // install opens in the user's own rather than in a default.
  setLocale(readSettings().locale ?? resolveLocale(app.getLocale()))
  log('dsh Desktop starting')
  log(`locale: ${getLocale()}`)
  if (locations.migrated) log(`migrated data directory from ${locations.migrated}`)
  for (const note of locations.notes) log(note)
  log(`data directory: ${locations.dataDir}`)
  if (locations.logDir !== locations.dataDir) log(`log directory: ${locations.logDir}`)
  registerPluginIpc()
  registerSkillIpc()
  registerSettingsIpc()
  registerFileHandoff()
  // Before the first child is spawned and before anything is fetched: the
  // runtime install on a first launch is exactly the thing a user behind a
  // proxy needs this for.
  await applyProxy(proxySetting()).catch(error => log(`could not apply the proxy setting: ${error?.message ?? error}`))
  const settings = readSettings()
  const bounds = savedBounds()
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    ...bounds,
    title: 'DeepSeek Harness',
    // Starting hidden means starting in the tray: the server comes up, the
    // window is built and loaded, and nothing appears until it is asked for.
    show: !settings.startHidden,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Only for files dropped on the window; it exposes nothing to the page.
      preload: path.join(here, 'chat-preload.cjs'),
    },
  })
  if (settings.windowMaximized) window.maximize()
  rememberBounds(window)
  state.window = window
  // Close hides; the server keeps running until the app itself quits.
  window.on('close', event => {
    if (state.quitting) return
    event.preventDefault()
    window.hide()
  })
  await window.loadFile(path.join(assets, 'loading.html'), { search: `lang=${getLocale()}` })
  try {
    // Packaged builds prefer the app-bundled Node; the system search is the
    // dev-mode path and the fallback for a missing/corrupt bundle.
    state.toolchain = (app.isPackaged
      ? ensureBundledToolchain({
        tarPath: path.join(process.resourcesPath, 'node-runtime.tgz'),
        versionFile: path.join(process.resourcesPath, 'node-runtime.version'),
        destBase: app.getPath('userData'),
        log,
      })
      : undefined) ?? findToolchain()
    log(`toolchain: ${state.toolchain.nodeBin}`)
    state.runtime = await ensureRuntime({
      baseDir: paths.runtimeBase,
      toolchain: state.toolchain,
      // Packaged builds carry a runtime snapshot in Resources/runtime-seed.tar,
      // so first launch deploys offline instead of downloading from npm.
      seedTar: app.isPackaged ? path.join(process.resourcesPath, 'runtime-seed.tar') : undefined,
      log,
    })
    buildMenu()
    createTray()
    await refreshRollbackTarget()
  } catch (error) {
    // Environment problems (no usable Node, a runtime that will not deploy)
    // are not something another attempt fixes.
    await fatal(t('dialog.startFailed'), error)
    return
  }
  // The environment is ready; past this point a failure is about the server
  // itself, and those are worth another try rather than an app that quits.
  await launchServer().catch(offerLaunchRetry)

  // A shell that got this far — window, toolchain, runtime, server — is a
  // shell that starts, which is what the hot-update rollback rule asks.
  confirmShell()

  // The startup check waits until the app is doing its job: an update dialog
  // racing the first paint would be the first thing a user sees, and the one
  // thing they did not come here for. It says nothing unless there is
  // something new, and nothing at all when the network is unreachable.
  setTimeout(() => { updateApp({ silent: true }).catch(error => log(`silent update check: ${error?.message ?? error}`)) }, 30_000)
}

process.on('uncaughtException', reason => crash('uncaught exception', reason))
// Deliberately not fatal, unlike the line above: a throw leaves the main
// process in a state not worth continuing in, but a rejection nobody awaited
// is usually one isolated async path — and ending a resident app with a live
// server over it costs the user more than the bug does. Registering this
// listener is what stops Node from ending the process itself; the log line is
// the point.
process.on('unhandledRejection', reason => {
  log(`unhandled rejection: ${reason?.stack ?? reason}`)
})

// One instance only: two of these would run two servers over one DSH_HOME.
// The second instance is also how Windows delivers a "Send to" selection —
// its arguments are wanted even though the process itself is not, which
// registerFileHandoff() reads out of the event.
const locked = app.requestSingleInstanceLock()
if (!locked) {
  // Said out loud because this is the one exit that leaves no other trace,
  // and an app that disappeared on its own and an app that was a second
  // instance handing over look identical from the outside.
  log('another instance owns the lock; handing over and exiting')
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  // Diagnostics only, and the counterpart to the handlers above: a renderer
  // or utility process dying does not end the app, so it leaves no trace at
  // all unless it is written down. "The window went blank" and "the app
  // vanished" are the same report from a user, and this tells them apart.
  app.on('render-process-gone', (_event, _contents, details) => {
    log(`renderer gone: reason=${details.reason} exitCode=${details.exitCode}`)
  })
  app.on('child-process-gone', (_event, details) => {
    log(`child process gone: type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`)
  })
  // The tray owns app lifetime: a hidden window with a live server is the
  // resident state, so closing windows never quits by itself.
  app.on('window-all-closed', () => {})
  app.on('before-quit', event => {
    if (state.quitting) return
    state.quitting = true
    clearTimeout(state.restartTimer)
    state.restartTimer = undefined
    if (state.child) {
      event.preventDefault()
      log('stopping dsh server')
      const child = state.child
      state.child = undefined
      stopServer(child).finally(() => app.quit())
    }
  })
  app.whenReady().then(main)
}
