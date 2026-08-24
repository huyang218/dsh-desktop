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
  app, BaseWindow, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, net, Notification, screen, session,
  shell, Tray, WebContentsView,
} from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { cpus, homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnv, ensureBundledToolchain, findToolchain } from './toolchain.js'
import { getLocale, LOCALES, messages, resolveLocale, setLocale, t } from './i18n.js'
import { BRAND } from './brand.js'
import { cpuPercent, sample as sampleUsage } from './metrics.js'
import { resolveLocations, saveLocations } from './locations.js'
import {
  compareVersions, downloadInstaller, fetchLatestRelease, fetchShellManifest, plan, REPO, stageShellUpdate,
} from './app-update.js'
import { DEFAULT_CATALOG_URL, loadCatalog } from './market.js'
import {
  getDisabledPlugins, getPluginConfigValues, probePluginConfig, setPluginConfig, setPluginDisabled,
} from './plugin-config.js'
import { normalizeSpec } from './plugin-spec.js'
import {
  installFromDirectory, installFromGitHub, installFromZip, removeSkill, SKILLS_DIR, updateSkill,
} from './skill-install.js'
import { findSkillUpdates, listRepoSkills, readOrigins } from './skill-source.js'
import { RECOMMENDED_SOURCES } from './skill-sources.js'
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
import { interceptScript, previewTarget } from './preview.js'
import { DEFAULT_TEXT_MAX, DEFAULT_WAIT_MS, shortSource } from './browser-ops.js'
import {
  clearScript, findScript, locateScript, scrollScript, scrollToScript, selectScript, snapshotScript,
  textScript, waitScript,
} from './browser-page.js'
import { bridgeAddress, mintToken, startBridge, writeOpenCommand } from './open-bridge.js'
import { registerMcpTools } from './mcp-register.js'
import { createEngine } from './miniapp-engine.js'
import { createEngine as createPhoneEngine } from './phone-engine.js'
import { inspectPhones, verifyAndroid } from './phone-tool.js'
import {
  createAvd, hasJava, installCli, installPackages, installTools, LICENCE_URL, packageSizes,
  requiredPackages, watchDownloads,
} from './phone-install.js'
import { deployBundledSkills } from './bundled-skills.js'
import { isSourceLaunch } from './source-launch.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const assets = path.join(here, '..', 'assets')
const sourceLaunch = isSourceLaunch(app, here)

// Electron's internal name is used in native role labels and diagnostics. The
// OS-level macOS name still comes from Info.plist; start-dev.mjs supplies a
// branded development bundle for that half. Safe to set because the data
// directory is pinned explicitly on the next line rather than derived from it.
app.setName(BRAND.name)

const locations = resolveLocations(app.getPath('appData'))
app.setPath('userData', locations.dataDir)

// Windows ties notifications to an application identity, and one that is not
// set means notifications that never appear — with no error to notice. It
// also keeps the taskbar from treating each launch as a different app.
if (process.platform === 'win32') app.setAppUserModelId(BRAND.appId)

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
const state = { quitting: false, restarts: 0, pluginWindows: {}, pages: new Map() }

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
  // An Android SDK this app installed for someone who had none. In the data
  // directory because it is ours to remove: a user who deletes this app
  // should not be left with two gigabytes of somebody else's SDK. The virtual
  // device made from it is not here — `avdmanager` writes those to the user's
  // own ~/.android/avd, which is where their tools look — so a removal leaves
  // that behind, a few kilobytes pointing at an image that has gone.
  paths.androidSdk = path.join(userData, 'android-sdk')
  // Hot-updated shells, and the installers downloaded for the updates that
  // cannot be hot.
  paths.shellDir = shellDirOf(locations.dataDir)
  paths.downloads = path.join(userData, 'updates')
  // A migrated directory keeps its old dsh-shell.log beside this one; that
  // history is the user's, so it is left alone rather than renamed or removed.
  paths.logDir = locations.logDir
  paths.logFile = path.join(locations.logDir, BRAND.logFile)
  paths.settingsFile = path.join(userData, 'settings.json')
  // Where each skill came from. The shell's own note, so it lives with the
  // shell's settings rather than inside the folder the user edits by hand.
  paths.skillOrigins = path.join(userData, 'skill-origins.json')
  // The badge's own picture, copied here so it survives the source moving.
  paths.hudDir = path.join(userData, 'hud')
  // The web UI's own storage, kept so it survives the port — and therefore
  // the origin — changing under it. See src/chat-preload.cjs.
  paths.uiStateFile = path.join(userData, 'ui-state.json')
  // One command, `dsh-open`, put on the dsh server's PATH. Written on every
  // launch rather than installed: it names the bundled Node by absolute path,
  // and that path moves with an app update.
  paths.binDir = path.join(userData, 'bin')
  // The skills that ship with the app, unpacked where the server can read
  // them. Rewritten on every launch; nothing user-owned lives here.
  paths.bundledSkills = path.join(userData, 'bundled-skills')
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
  if (state.hud && !state.hud.isDestroyed()) state.hud.reload()
  if (state.chat && !state.port) {
    // Still on the loading page: reload it so its two strings switch too.
    loadChat(path.join(assets, 'loading.html')).catch(() => {})
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
  paths.logFile = path.join(chosen, BRAND.logFile)
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
  // Waking the app brings its badge with it. This is the funnel for the Dock
  // icon, the tray's own item and a second launch, so the three arrive at the
  // same place rather than each remembering separately.
  raiseHud()
}

async function launchServer() {
  const { window, runtime } = state
  // The port the server had last time, if it is still free. It is part of the
  // page's origin, and the web UI's own browser storage — the open workspace,
  // the current session, the sidebar — is partitioned by origin, so a new
  // port every launch quietly discards all of it.
  const port = await getFreePort(readSettings().serverPort)
  const startedAt = Date.now()
  const child = await startServer({
    slotDir: runtime.dir,
    port,
    dshHome: paths.dshHome,
    cwd: homedir(),
    toolchain: state.toolchain,
    // The agent's way to put a page on screen, and the skills that tell it
    // how. Absent when the socket could not be bound, in which case
    // `dsh-open` is simply not on the PATH and nothing else changes.
    ...state.childEnv ? { binDir: paths.binDir, env: state.childEnv } : {},
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
  // Remembered only once it answered: a port that failed to serve is not one
  // worth preferring next time.
  if (healthy) writeSettings({ serverPort: port })
  if (!healthy) {
    // Superseded: the child died (the supervisor owns the retry) or we are
    // quitting/restarting. Only a live-but-unresponsive server is our error.
    if (state.quitting || state.child !== child) return
    throw new Error(`${t('error.notReady', { port })}${t('dialog.logPath', { path: paths.logFile })}`)
  }
  if (!window.isDestroyed()) await state.chat.webContents.loadURL(`http://127.0.0.1:${port}/`)
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
  if (!state.window.isDestroyed()) await loadChat(path.join(assets, 'loading.html'))
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
    loadChat(path.join(assets, 'loading.html')).catch(() => {})
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
    outcome = await state.chat.webContents.executeJavaScript(insertionScript(text), true)
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

/**
 * What makes a manager window a manager window.
 *
 * The plugin manager, the market, the skills manager and the settings are
 * not places to work alongside the chat — they change what the chat is
 * running on. Left as siblings they could be buried under the window they
 * were opened from, and a half-finished install could be left behind a
 * conversation and forgotten. Owned by the main window and modal, they stay
 * in front of it and hold it until they are closed.
 *
 * Without a main window there is nothing to be modal to, and a modal window
 * with no parent is just a window — so the pairing is returned together or
 * not at all.
 *
 * A hidden main window counts as no main window. This app is tray-resident
 * and can start without one at all, and opening the plugin manager from the
 * tray then would hold a window nobody can see.
 *
 * Owned but not modal. Modal put these in front and held the window behind
 * them, which was the point — but it also had the system swallow every click
 * outside, so clicking away did nothing at all and the only way out was the
 * one small button in the title bar. Ownership alone keeps them in front;
 * dismissOnOutsideFocus() closes them when the user turns back to the window
 * they came from, which is what clicking away was trying to say.
 */
function ownedByMainWindow() {
  const parent = state.window
  return parent && !parent.isDestroyed() && parent.isVisible() ? { parent } : {}
}

/**
 * Closes a manager window when the user goes back to another of ours.
 *
 * Focus moving to a different window of this application is the signal, not
 * the window merely losing focus: switching to a browser to read a plugin's
 * repository, or to a terminal, should leave the manager where it was. Only
 * turning back to the app itself means "done here".
 *
 * @param {BrowserWindow} win
 */
function dismissOnOutsideFocus(win) {
  const onFocus = focused => {
    if (win.isDestroyed() || focused === win) return
    // The badge is always on top and takes focus when clicked; closing a
    // manager because somebody glanced at a readout would be its own bug.
    if (focused === state.hud) return
    win.close()
  }
  app.on('browser-window-focus', (_event, focused) => onFocus(focused))
  win.on('closed', () => app.removeListener('browser-window-focus', onFocus))
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
    ...ownedByMainWindow(),
    webPreferences: { preload: path.join(here, 'settings-preload.cjs') },
  })
  if (process.platform !== 'darwin') win.removeMenu()
  win.loadFile(path.join(assets, 'settings.html'))
  dismissOnOutsideFocus(win)
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

// ── The built-in browser ────────────────────────────────────────────────────
// A page the agent produced belongs beside the conversation that produced it,
// not in another application. dsh's own answer — hand the path to the OS,
// which for .html means the default browser — is right for a terminal install
// and wrong for this one, and it is not configurable: the gateway takes a
// boolean about whether paths can be opened at all, never an opener. So the
// shell shows it in a panel of the same window, and reaches the gesture from
// two sides: the UI's own file chips (intercepted in the page, see
// src/preview.js) and a command on the agent's PATH (see src/open-bridge.js).
//
// A panel rather than a second window. A window that appears over the app is
// something to dismiss before the conversation can go on; a panel beside it
// is something to read while typing, which is what a page opened mid-turn is
// for.

/** Height of the panel's own furniture: the tab strip over the toolbar. */
const PANEL_CHROME = 68
/** The seam between the two, and the only part of it the user can grab. */
const PANEL_DIVIDER = 5
/** Narrower than this and the panel is a sliver rather than a page. */
const PANEL_MIN = 260
/** What the conversation keeps whatever the panel is dragged to. */
const CHAT_MIN = 360
const PANEL_DEFAULT = 460
/** Every page shares one partition; see prepareSession for why. */
const PANEL_PARTITION = 'persist:dsh-preview'
/** Console lines and network entries kept per page, for the agent to ask about. */
const PANEL_LOG_MAX = 100
/**
 * Marks a request the inspector already reported.
 *
 * A symbol so that it never reaches the agent: symbol keys are skipped by
 * JSON, which is the only way this row leaves the process.
 */
const CLAIMED = Symbol('claimed')
/** Marks a row whose body has already been asked for, successfully or not. */
const PREVIEWED = Symbol('previewed')
/** How much of a body rides along in the request list. */
const PREVIEW_MAX = 200
/** How many bodies one listing will fetch unasked. */
const PREVIEW_ROWS = 5
/** How long a first load waits for the inspector before going without it. */
const INSPECTOR_READY_MS = 1500
/** How many stack frames an error carries into the log. */
const INSPECTOR_STACK_MAX = 8
/** A response body longer than this is truncated rather than returned whole. */
const BODY_MAX = 40_000
/**
 * The devices a viewport can be asked for by name.
 *
 * Three, not a catalogue: the question an agent is answering is almost always
 * "does this hold together narrow", and a list of thirty handsets invites
 * picking one rather than deciding. A width and height can still be given
 * directly for the case a name does not cover.
 */
const VIEWPORTS = {
  mobile: { width: 390, height: 844, scale: 3, mobile: true },
  tablet: { width: 820, height: 1180, scale: 2, mobile: true },
  desktop: { width: 1280, height: 800, scale: 1, mobile: false },
}
/** What a phone says it is, for the sites that serve by user agent. */
const MOBILE_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'

/** The panel widths this window can actually lay out. @param {number} width content width */
function clampPanel(wanted, width) {
  return Math.max(PANEL_MIN, Math.min(wanted, width - CHAT_MIN - PANEL_DIVIDER))
}

/** Lays the window's views out: chat, seam, panel. */
function layoutWindow() {
  const win = state.window
  if (!win || win.isDestroyed() || !state.chat) return
  const { width, height } = win.getContentBounds()
  if (!state.panel) {
    state.chat.setBounds({ x: 0, y: 0, width, height })
    return
  }
  // Clamped here as well as on drag: the window can be resized down to where
  // a remembered width would leave no conversation. Display only — the width
  // the user chose is kept, and comes back when the window has room for it.
  const panel = clampPanel(state.panelWidth, width)
  const chatWidth = Math.max(0, width - panel - PANEL_DIVIDER)
  state.chat.setBounds({ x: 0, y: 0, width: chatWidth, height })
  state.panel.divider.setBounds({ x: chatWidth, y: 0, width: PANEL_DIVIDER, height })
  const x = chatWidth + PANEL_DIVIDER
  state.panel.chrome.setBounds({ x, y: 0, width: panel, height: PANEL_CHROME })
  // Every page gets the same rectangle, and the one in front is simply the
  // one on top. A hidden view is not composited, and a view that is not
  // composited does not receive input events — so `setVisible(false)` would
  // leave the agent unable to click in any tab but the visible one, which is
  // most of the point of having tabs. Stacking costs a little compositing
  // for pages nobody is looking at; it buys a background tab that behaves
  // exactly like a foreground one.
  const pageBounds = { x, y: PANEL_CHROME, width: panel, height: Math.max(0, height - PANEL_CHROME) }
  for (const entry of state.pages.values()) entry.view.setBounds(pageBounds)
}

/** Loads a page into the dsh UI's view, with the strings the shell's own pages read. */
function loadChat(file) {
  return state.chat.webContents.loadFile(file, { search: `lang=${getLocale()}&app=${encodeURIComponent(BRAND.name)}` })
}

/**
 * Shows a target in the side panel, if it is one the panel will take.
 *
 * The vetting answer is the caller's answer too: the page interception reads
 * `false` as "leave this request alone", so a `.docx` or a `mailto:` still
 * reaches the application that should have it, and `dsh-open` prints a reason
 * the agent can act on rather than failing silently.
 *
 * @param {string} target a path or an http(s) URL
 * @param {{ wide?: boolean }} [options] wide: also take PDFs and images
 * @returns {{ ok: true, label: string } | { ok: false, why: string }}
 */
function openPreview(target, { wide = false } = {}) {
  const resolved = previewTarget(target, { wide, exists: existsSync })
  if (!resolved) return { ok: false, why: 'not a page this panel can show' }
  if (isHarnessOrigin(resolved.url)) return { ok: false, why: 'that is the harness itself' }
  if (!state.window || state.window.isDestroyed()) return { ok: false, why: 'no window' }
  const entry = frontPage() ?? createPage()
  showPage(entry.id)
  entry.view.webContents.loadURL(resolved.url).catch(error => log(`preview: ${error?.message ?? error}`))
  showWindow()
  return { ok: true, label: resolved.label, page: entry.id }
}

/**
 * Whether a URL is the dsh UI's own.
 *
 * It is not a document to preview beside itself, and a page served from its
 * origin would be same-origin with the API this shell exists to hold.
 * Nothing legitimate asks for it.
 */
function isHarnessOrigin(url) {
  if (!state.port) return false
  try {
    return new URL(url).port === String(state.port)
  } catch {
    return false
  }
}

/**
 * The furniture: the strip and the seam. Pages come and go under it.
 *
 * Built on first use and kept until the panel closes, because they are the
 * panel — a page is what the panel is currently showing, and there can be
 * several of those.
 */
function openPanel() {
  if (state.panel) return state.panel
  const window = state.window

  const chrome = new WebContentsView({ webPreferences: { preload: path.join(here, 'preview-preload.cjs') } })
  chrome.webContents.loadFile(path.join(assets, 'preview.html'))
  const divider = new WebContentsView({ webPreferences: { preload: path.join(here, 'preview-preload.cjs') } })
  divider.webContents.loadFile(path.join(assets, 'divider.html'))
  for (const view of [divider, chrome]) window.contentView.addChildView(view)
  // The strip may still be loading when the first page is handed over; this
  // is what puts the address in it when it arrives.
  chrome.webContents.on('did-finish-load', pushPanelState)

  state.panel = { chrome, divider }
  state.panelWidth = panelWidth()
  layoutWindow()
  // The menu carries a checkmark for this, and the panel opens on the agent's
  // say-so as often as on the user's.
  buildMenu()
  refreshTrayMenu()
  return state.panel
}

/**
 * Opens another page.
 *
 * Pages are views of the same window, shown one at a time. A background page
 * is one the panel is not currently showing: it loads, runs, and answers
 * every verb exactly like the visible one — which is what lets an agent work
 * through a list of URLs without the panel flickering through all of them —
 * and `show` brings any of them to the front.
 *
 * @param {{ background?: boolean }} [options]
 * @returns {{ id: string, view: WebContentsView, console: object[], network: object[] }}
 */
function createPage({ background = false } = {}) {
  openPanel()
  const view = new WebContentsView({
    // No preload, its own partition, sandboxed. It is somebody else's HTML,
    // and quite possibly HTML a model wrote a minute ago.
    webPreferences: {
      partition: PANEL_PARTITION,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  state.window.contentView.addChildView(view)
  const contents = view.webContents
  const id = `page_${state.pageSeq = (state.pageSeq ?? 0) + 1}`
  const entry = { id, view, console: [], network: [] }
  state.pages.set(id, entry)

  prepareSession(contents.session)
  attachInspector(entry)
  contents.setWindowOpenHandler(({ url }) => {
    // A link that wants a new window gets one — a page of ours, in the
    // background, so the agent can find it in `pages` and the user's panel
    // does not jump to it. Anything that is not a web page still goes out to
    // the real browser rather than becoming a page here.
    if (/^(http|https):/i.test(url) && !isHarnessOrigin(url)) {
      const opened = createPage({ background: true })
      opened.view.webContents.loadURL(url).catch(() => {})
    } else if (/^(http|https):/i.test(url)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    // A scheme no browser should follow, and the harness's own origin, which
    // is not a document and is the one origin where being a page would mean
    // something.
    if (!/^(file|http|https):/i.test(url) || isHarnessOrigin(url)) event.preventDefault()
  })
  // A new document starts a new log.
  //
  // This is the difference between a usable development loop and a
  // misleading one: the agent changes a file, reloads, asks what the console
  // says, and must not be told about the error it just fixed. Cleared on the
  // navigation starting rather than on it committing, because the request for
  // the document itself completes before the commit and belongs to the page
  // it is fetching.
  contents.on('did-start-navigation', (...args) => {
    const details = args[0] && typeof args[0] === 'object' && 'isMainFrame' in args[0] ? args[0] : undefined
    const isMainFrame = details ? details.isMainFrame : args[3]
    const isSameDocument = details ? details.isSameDocument : args[2]
    if (!isMainFrame || isSameDocument) return
    entry.console.length = 0
    entry.network.length = 0
    entry.pending?.clear()
    if (entry.inspector === true) enableInspectorDomains(entry)
  })
  // Kept for the agent to ask about after the fact: a page that failed is
  // usually diagnosed by what it logged, not by what it renders.
  contents.on('console-message', (...args) => {
    // Silent while the inspector is reporting: it sees the same messages with
    // a stack attached, and two recorders would log everything twice.
    if (entry.inspectorConsole) return
    // Electron changed this signature: newer versions pass one details
    // object, older ones pass (event, level, message, line, source).
    const details = args[0] && typeof args[0] === 'object' && 'message' in args[0] ? args[0] : undefined
    const message = String(details?.message ?? args[2] ?? '')
    // Electron's own development-build warnings are not the page talking, and
    // an agent reading this buffer to find out why a page misbehaved should
    // not have to scroll past them. They do not appear in a packaged build.
    if (message.includes('Electron Security Warning')) return
    // Where it came from, when the page says. "Cannot read properties of
    // null" names no file, and an agent that has to go and find the line
    // spends a round trip guessing at a bundle it cannot see. Absent for a
    // message with no script behind it, so it is carried only when there is
    // one rather than reported as an empty file at line zero.
    const source = details?.sourceId ?? args[4]
    const line = Number(details?.lineNumber ?? args[3]) || undefined
    remember(entry.console, {
      level: String(details?.level ?? args[1] ?? 'info'),
      message,
      ...(source ? { source: String(source), line } : {}),
    })
  })
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (isMainFrame) remember(entry.console, { level: 'error', message: `load failed (${code} ${description}) ${url}` })
  })
  // Every one of these changes a tab, not only the front one: a background
  // page finishing its load is exactly what the user wants to see in the
  // strip while the agent works through a list of systems.
  for (const event of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) {
    contents.on(event, () => pushPanelState())
  }
  contents.on('destroyed', () => { state.pages.delete(id) })

  if (!background || state.front === undefined) showPage(id)
  else {
    // Behind whatever is in front, at the same size: it renders, it runs, and
    // it takes clicks — it is simply not the one on top.
    layoutWindow()
    if (state.front) showPage(state.front)
    pushPanelState()
  }
  return entry
}

/**
 * The DevTools protocol, attached to one page.
 *
 * Three of the things a developer asks a browser for are not in Electron's
 * own API at all: the body a request came back with, a stack under an error,
 * and a viewport that is not the size of the panel. All three are one
 * protocol away, so the panel opens that protocol per page and keeps the
 * plainer listeners as the fallback.
 *
 * A fallback is needed because there is exactly one debugger slot per page
 * and the user may take it by opening DevTools. That is not an error worth
 * refusing over — it costs bodies and stacks, not the browser — so the attach
 * is attempted, the outcome is remembered on the entry, and the two
 * listeners in {@link createPage} and {@link prepareSession} keep recording
 * whenever it did not take.
 *
 * @param {{id: string, view: object, console: object[], network: object[]}} entry
 */
function attachInspector(entry) {
  const contents = entry.view.webContents
  entry.pending = new Map()
  entry.userAgent = contents.getUserAgent()
  try {
    contents.debugger.attach('1.3')
  } catch (error) {
    entry.inspector = String(error?.message ?? error)
    entry.ready = Promise.resolve()
    return
  }
  // Claimed synchronously, before the domains are enabled, because the page
  // starts loading immediately and `enable` resolves a tick later: a flag set
  // on the reply leaves a window in which both recorders are live and the
  // first two requests of every page get logged twice.
  entry.inspector = true
  entry.inspectorNetwork = true
  entry.inspectorConsole = true
  contents.debugger.on('detach', (_event, reason) => {
    // Everything degrades together: the other recorders are watching these
    // same flags to decide whether to stay quiet.
    entry.inspector = `the inspector detached (${reason})`
    entry.inspectorNetwork = false
    entry.inspectorConsole = false
  })
  contents.debugger.on('message', (_event, method, params) => inspectorEvent(entry, method, params))
  // A domain that refuses hands its recorder back to the plain listener,
  // which is why the two are tracked apart rather than as one flag.
  const [network, runtime] = enableInspectorDomains(entry)
  // Waited for before the first load, and only there. Enabling a domain is a
  // round trip to the renderer, and a page told to navigate inside that round
  // trip reports nothing for the requests it makes first — which are the
  // document and its scripts, the two an agent asks about most.
  //
  // Raced against a deadline because this is instrumentation: a protocol that
  // does not answer costs a few early log lines, and must never be the reason
  // the browser will not open a page.
  entry.ready = Promise.race([
    Promise.allSettled([network, runtime]),
    sleep(INSPECTOR_READY_MS),
  ]).then(() => {})
}

/**
 * Turns the two domains on, and returns the promises for doing so.
 *
 * Repeated on every cross-document navigation, not only at attach. A load
 * that swaps the renderer — which the first real load always does, coming
 * from the blank page a view starts on — leaves the previous renderer's
 * domain state behind, and the requests the new one makes before the domains
 * come back are simply not reported. That window is short, but the page's own
 * script sits inside it: the one request an agent looking at a blank page
 * most needs to see.
 *
 * Sent rather than awaited, because the document is already on its way and
 * the point is to be enabled before its subresources are requested.
 */
function enableInspectorDomains(entry) {
  const { debugger: inspector } = entry.view.webContents
  return [
    inspector.sendCommand('Network.enable', {
      maxResourceBufferSize: 16 * 1024 * 1024,
      maxTotalBufferSize: 64 * 1024 * 1024,
    }).catch(() => { entry.inspectorNetwork = false }),
    inspector.sendCommand('Runtime.enable').catch(() => { entry.inspectorConsole = false }),
  ]
}

/** One protocol event, folded into the page's logs. */
function inspectorEvent(entry, method, params) {
  if (method === 'Network.requestWillBeSent') {
    const url = String(params.request?.url ?? '').slice(0, 300)
    const requestMethod = params.request?.method
    // Either recorder can be first — the browser process sees a short request
    // complete before the renderer's protocol events have made their way
    // across — so each claims the other's row rather than assuming it leads.
    const existing = matchingRow(entry, requestMethod, url, row => row.id === undefined)
    const row = existing ?? { method: requestMethod, url }
    row.id = params.requestId
    row.kind = params.type
    if (existing) existing[CLAIMED] = true
    entry.pending.set(params.requestId, row)
    // Remembered when it is sent rather than when it finishes, so a request
    // that never comes back is still visible — the pending request is often
    // the whole answer.
    if (!existing) remember(entry.network, row)
    return
  }
  // Mutated in place: the row is already in the log, and the agent asking
  // later wants one line per request rather than one per protocol event.
  const row = entry.pending?.get(params?.requestId)
  if (method === 'Network.responseReceived' && row) {
    row.status = params.response?.status
    row.mime = params.response?.mimeType
  } else if (method === 'Network.loadingFinished' && row) {
    row.bytes = params.encodedDataLength
  } else if (method === 'Network.loadingFailed' && row) {
    row.error = params.errorText
  } else if (method === 'Runtime.consoleAPICalled') {
    const message = params.args?.map(describeRemote).join(' ') ?? ''
    // The same exclusion the plain listener makes, for the same reason: these
    // are the shell talking about itself, not the page, and they do not
    // appear in a packaged build at all.
    if (message.includes('Electron Security Warning')) return
    remember(entry.console, {
      level: String(params.type ?? 'log'),
      message,
      ...frameOf(params.stackTrace),
    })
  } else if (method === 'Runtime.exceptionThrown') {
    const detail = params.exceptionDetails ?? {}
    remember(entry.console, {
      level: 'error',
      message: String(detail.exception?.description ?? detail.text ?? 'uncaught exception').split('\n')[0],
      source: detail.url,
      line: detail.lineNumber === undefined ? undefined : detail.lineNumber + 1,
      column: detail.columnNumber === undefined ? undefined : detail.columnNumber + 1,
      ...frameOf(detail.stackTrace, { keepSource: false }),
      stack: framesOf(detail.stackTrace),
    })
  }
}

/**
 * The row the other recorder logged for this same request, if there is one.
 *
 * Matched on method and URL, and each row can be matched once — so a page
 * that asks for the same URL five times ends with five rows rather than one,
 * even though the pairing between them is only as good as the order they
 * arrived in. Which of the five carries which id does not change any answer.
 */
function matchingRow(entry, method, url, wanted) {
  return entry.network.find(row => row[CLAIMED] !== true && row.method === method && row.url === url && wanted(row))
}

/** A protocol value as the short text a log line wants. */
function describeRemote(argument) {
  if (argument?.value !== undefined) return typeof argument.value === 'string' ? argument.value : JSON.stringify(argument.value)
  return String(argument?.description ?? argument?.unserializableValue ?? argument?.type ?? '')
}

/** Where a call came from: the top frame, in the fields a console line reads. */
function frameOf(trace, { keepSource = true } = {}) {
  const frame = trace?.callFrames?.[0]
  if (!frame || !keepSource) return {}
  return {
    source: frame.url || undefined,
    // The protocol counts from zero and every editor counts from one.
    line: frame.lineNumber === undefined ? undefined : frame.lineNumber + 1,
    column: frame.columnNumber === undefined ? undefined : frame.columnNumber + 1,
  }
}

/** The frames under an error, shortened to what fits in a log. */
function framesOf(trace) {
  const frames = trace?.callFrames ?? []
  if (frames.length === 0) return undefined
  return frames.slice(0, INSPECTOR_STACK_MAX).map(frame => {
    const where = `${shortSource(frame.url) || '<anonymous>'}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`
    return frame.functionName ? `${frame.functionName} (${where})` : where
  })
}

/**
 * One-time setup for the partition every page shares.
 *
 * Shared on purpose: a login the user performs in the panel is a login the
 * agent can then work behind, which is the whole point of driving a browser
 * that lives in the user's own application. It is also the sharp edge — a
 * page can talk the agent into acting as the user — so it is one decision,
 * made once, in one place, rather than a property of whichever page happens
 * to be open.
 *
 * The listeners are registered against the session, not the page, so they are
 * registered once and route by `webContentsId`; adding them per page would
 * leave a handler behind for every page ever opened.
 */
function prepareSession(partition) {
  if (state.panelSessionReady) return
  state.panelSessionReady = true
  partition.on('will-download', event => event.preventDefault())
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const record = (details, extra) => {
    const entry = [...state.pages.values()].find(page => page.view.webContents.id === details.webContentsId)
    if (!entry) return
    // Claimed rather than skipped.
    //
    // These two recorders each see something the other cannot. The inspector
    // carries ids and retrievable bodies; this listener lives in the browser
    // process and therefore sees every request, including the ones a renderer
    // makes in the moment after a cross-document navigation swaps it, while
    // the inspector's domains are still coming back up. That window reliably
    // swallows the page's own script — the one request a blank page is about.
    //
    // So the inspector's row is matched and marked, and only an unmatched
    // request is added here. The list is complete because of this listener,
    // and detailed because of the inspector.
    const claimable = matchingRow(entry, details.method, String(details.url).slice(0, 300), row => row.id !== undefined)
    if (claimable) {
      claimable[CLAIMED] = true
      return
    }
    remember(entry.network, {
      method: details.method,
      url: String(details.url).slice(0, 300),
      ...extra,
    })
  }
  partition.webRequest.onCompleted(details => record(details, { status: details.statusCode }))
  partition.webRequest.onErrorOccurred(details => record(details, { error: details.error }))
}

/** A bounded log: the recent past is worth keeping, the whole past is not. */
function remember(buffer, item) {
  buffer.push(item)
  if (buffer.length > PANEL_LOG_MAX) buffer.splice(0, buffer.length - PANEL_LOG_MAX)
}

/**
 * Brings a page to the panel — by raising it, not by hiding the others.
 *
 * Re-adding a child view moves it to the top of the window's stack, and the
 * page in front covers the ones behind it exactly. The chrome and the seam
 * occupy their own rectangles, so where they sit in the stack never shows.
 *
 * @param {string} id
 */
function showPage(id) {
  const entry = state.pages.get(id)
  if (!entry) return false
  state.front = id
  state.window.contentView.removeChildView(entry.view)
  state.window.contentView.addChildView(entry.view)
  layoutWindow()
  pushPanelState()
  return true
}

/** The page verbs act on unless one is named. @returns {object | undefined} */
function frontPage() {
  return state.front === undefined ? undefined : state.pages.get(state.front)
}

/** Resolves the `page` parameter every verb accepts. */
function pageFor(id) {
  if (id === undefined || id === null || id === '') return frontPage()
  return state.pages.get(String(id))
}

/** Closes one page, and the panel with it when it was the last. @param {string} id */
function closePage(id) {
  const entry = state.pages.get(id)
  if (!entry) return false
  state.pages.delete(id)
  state.window.contentView.removeChildView(entry.view)
  entry.view.webContents.close()
  if (state.front === id) {
    state.front = undefined
    const next = state.pages.keys().next()
    if (next.done) closePanel()
    else showPage(next.value)
  } else {
    pushPanelState()
  }
  return true
}

/** What the strip shows about the page in front of it. */
function pushPanelState() {
  const panel = state.panel
  const entry = frontPage()
  if (!panel || panel.chrome.webContents.isDestroyed()) return
  const contents = entry?.view.webContents
  const url = contents?.getURL() ?? ''
  panel.chrome.webContents.send('preview:state', {
    url,
    label: previewLabel(url),
    loading: Boolean(contents?.isLoading()),
    canGoBack: Boolean(contents?.navigationHistory.canGoBack()),
    canGoForward: Boolean(contents?.navigationHistory.canGoForward()),
    tabs: [...state.pages.values()].map(page => {
      const pageUrl = page.view.webContents.getURL()
      return {
        page: page.id,
        front: state.front === page.id,
        // The title when the page has one, and the tail of its address when
        // it does not: a tab reading "page_3" tells the user nothing about
        // which of four systems the agent is working in. Chromium titles a
        // blank page after its URL, which is not a title anybody wants to
        // read on a tab.
        title: pageUrl === 'about:blank' ? '' : page.view.webContents.getTitle(),
        label: previewLabel(pageUrl).split('/').filter(Boolean).pop() ?? '',
        url: pageUrl,
        loading: page.view.webContents.isLoading(),
      }
    }),
  })
}

/** Closes the panel and every page in it; the conversation gets the width back. */
function closePanel() {
  const panel = state.panel
  if (!panel) return
  state.panel = undefined
  state.front = undefined
  for (const entry of state.pages.values()) {
    state.window.contentView.removeChildView(entry.view)
    entry.view.webContents.close()
  }
  state.pages.clear()
  for (const view of [panel.chrome, panel.divider]) {
    state.window.contentView.removeChildView(view)
    // Destroyed rather than kept for next time: a panel holding a page is a
    // renderer process, and the next open is a different document anyway.
    view.webContents.close()
  }
  layoutWindow()
  buildMenu()
  refreshTrayMenu()
}

/**
 * Unpacks the shipped skills and names their directory for the server.
 *
 * An environment that already carries `DSH_BUNDLED_SKILL_DIR` is left alone.
 * dsh takes one bundled root, not a list, so setting ours would silently
 * replace whatever the user pointed it at — and somebody who set that
 * variable by hand meant it.
 *
 * @returns {Record<string, string>} environment for the server child
 */
function bundledSkillEnv() {
  if (process.env.DSH_BUNDLED_SKILL_DIR) {
    log('bundled skills: leaving DSH_BUNDLED_SKILL_DIR as the environment set it')
    return {}
  }
  try {
    const dir = deployBundledSkills({
      sourceDir: path.join(assets, 'skills'),
      destDir: paths.bundledSkills,
    })
    return { DSH_BUNDLED_SKILL_DIR: dir }
  } catch (error) {
    // A skill the agent does not get is a worse agent, not a broken app.
    log(`bundled skills unavailable: ${error?.message ?? error}`)
    return {}
  }
}

/**
 * Puts the browser tools in front of the model, or takes them away.
 *
 * A setting, because this writes into the user's dsh home and changes what
 * their agent can do — and because an agent driving a browser that shares the
 * user's logins is a capability worth being able to switch off without
 * uninstalling the app.
 *
 * @param {string} command the MCP stub's absolute path
 */
async function registerTools(commands) {
  const settings = readSettings()
  const patchPath = path.join(paths.dshHome, 'cordis.patch.yml')
  // Each surface is its own row and its own switch. They are separate
  // capabilities — a browser that shares the user's logins and a simulator
  // that drives somebody else's application are worth being able to refuse
  // one at a time.
  const servers = [
    { name: 'browser', setting: 'browserTools', stub: commands['dsh-browser-mcp'] },
    { name: 'miniapp', setting: 'miniappTools', stub: commands['dsh-miniapp-mcp'] },
    { name: 'phone', setting: 'phoneTools', stub: commands['dsh-phone-mcp'] },
  ]
  for (const { name, setting, stub } of servers) {
    const wanted = settings[setting] !== false
    const outcome = await registerMcpTools({
      patchPath,
      name,
      ...(wanted ? { command: stub } : {}),
    }).catch(error => `failed: ${error?.message ?? error}`)
    if (outcome !== 'unchanged') log(`${name} tools ${outcome}`)
  }
}

/**
 * Opens the browser panel, or closes it.
 *
 * The panel appears on its own whenever a page is opened in it, which covers
 * every case the agent drives. This is the other direction: somebody who
 * wants a browser, before anything has asked for one. It opens on a blank
 * tab, because a blank tab with an address field is a browser and an empty
 * panel is a puzzle.
 */
function toggleBrowserPanel() {
  if (state.panel) {
    closePanel()
    return
  }
  const entry = createPage()
  entry.view.webContents.loadURL('about:blank').catch(() => {})
  showWindow()
}

/**
 * Where the user said their tools are.
 *
 * Read at the point of use rather than held, because the point of a setting
 * is that changing it takes effect — and the engines that consume this are
 * long-lived.
 */
const chosenAndroid = () => readSettings().androidSdk
const chosenDevTools = () => readSettings().devtoolsPath

/**
 * Asks which Android SDK to use, checks it, and says what it found.
 *
 * A picker on its own would be a setting that fails later, somewhere else,
 * with a message about a missing `adb`. So the directory is judged while the
 * user is still standing in front of it, and the answer names what is there
 * and what is not — a usable SDK, or one that needs an image, or a directory
 * that is not an SDK at all.
 */
async function chooseAndroidSdk() {
  const picked = await dialog.showOpenDialog(state.window, {
    title: t('dialog.pickAndroidSdk'),
    properties: ['openDirectory'],
    defaultPath: chosenAndroid() || undefined,
    message: t('dialog.pickAndroidSdkHint'),
  })
  const directory = picked.filePaths?.[0]
  if (picked.canceled || !directory) return

  const found = verifyAndroid(directory)
  if (!found.root) {
    await dialog.showMessageBox(state.window, {
      type: 'warning',
      message: t('dialog.androidSdkBad'),
      detail: t('dialog.androidSdkNotOne', { dir: directory }),
      buttons: [t('button.ok')],
    })
    return
  }

  writeSettings({ androidSdk: found.root })
  // The engine caches what it was told; dropping it is how the next call
  // picks up the location that was just chosen, without a restart.
  state.phone?.dispose()
  state.phone = undefined
  buildMenu()
  log(`android sdk: using ${found.root}`)

  // Usable is usable: nothing more is needed for the agent's tools, which are
  // already mounted, so the answer says so rather than implying another step.
  const detail = found.ok
    ? t('dialog.androidSdkReady', { dir: found.root, images: found.images.join(', '), avds: found.avds.join(', ') })
    : t('dialog.androidSdkIncomplete', {
      dir: found.root,
      missing: found.missing.map(part => t(`dialog.androidMissing.${part}`)).join('、'),
    })
  await dialog.showMessageBox(state.window, {
    type: found.ok ? 'info' : 'warning',
    message: found.ok ? t('dialog.androidSdkOk') : t('dialog.androidSdkBad'),
    detail,
    buttons: [t('button.ok')],
  })
}

/** The same, for the WeChat DevTools. */
async function chooseDevToolsPath() {
  const picked = await dialog.showOpenDialog(state.window, {
    title: t('dialog.pickDevTools'),
    // The DevTools is an application bundle on macOS and a directory on
    // Windows, and a picker that only takes one of those refuses the right
    // answer on the other platform.
    properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openDirectory'],
    defaultPath: chosenDevTools() || (process.platform === 'darwin' ? '/Applications' : undefined),
  })
  const directory = picked.filePaths?.[0]
  if (picked.canceled || !directory) return

  const found = verifyDevTools(directory)
  if (!found) {
    await dialog.showMessageBox(state.window, {
      type: 'warning',
      message: t('dialog.devtoolsBad'),
      detail: t('dialog.devtoolsNotOne', { dir: directory }),
      buttons: [t('button.ok')],
    })
    return
  }
  writeSettings({ devtoolsPath: found.installPath })
  state.miniapp?.dispose()
  state.miniapp = undefined
  buildMenu()
  log(`devtools: using ${found.installPath}`)
  await dialog.showMessageBox(state.window, {
    type: 'info',
    message: t('dialog.devtoolsOk'),
    detail: t('dialog.devtoolsReady', { dir: found.installPath, version: found.version }),
    buttons: [t('button.ok')],
  })
}

/** Verbs bound for the mini program simulator rather than the browser. */
const MINIAPP_PREFIX = 'miniapp.'
/** Verbs bound for the phone. */
const PHONE_PREFIX = 'phone.'
/** What a virtual device this app creates is called. */
const AVD_NAME = 'dsh-phone'

/**
 * The simulator engine, made when something first asks for it.
 *
 * Lazily, because it starts nothing on its own: an app that never opens a
 * mini program should never have looked for a DevTools, and most launches
 * never will.
 */
function miniapp() {
  state.miniapp ??= createEngine({ log, chosen: chosenDevTools() })
  return state.miniapp
}

/** The phone engine, on the same terms. */
function phone() {
  state.phone ??= createPhoneEngine({ log, chosen: chosenAndroid(), managed: paths.androidSdk })
  return state.phone
}

/**
 * Opens a project in the simulator, or lets go of the one that is open.
 *
 * The menu's half of what the agent reaches through the socket, and the same
 * engine underneath — so a simulator opened from here is the one the agent
 * then drives, rather than a second of its own.
 */
async function toggleSimulator() {
  const engine = miniapp()
  const { state: current } = await engine.run('status', {}, process.cwd())
  if (current === 'open') {
    const result = await engine.run('close', {}, process.cwd())
    buildMenu()
    if (!result.ok) errorDialog(t('menu.miniapp'), new Error(result.why))
    return
  }
  const picked = await dialog.showOpenDialog(state.window, {
    title: t('dialog.pickMiniapp'),
    properties: ['openDirectory'],
  })
  const directory = picked.filePaths?.[0]
  if (picked.canceled || !directory) return
  const result = await engine.run('open', { project: directory }, process.cwd())
  buildMenu()
  if (!result.ok) errorDialog(t('dialog.miniappFailed'), new Error(result.why))
}

/**
 * Starts a phone, or lets go of the one that is running.
 *
 * The choosing is done here rather than in the engine because it is a
 * conversation: which device, and — when there is no device to choose — what
 * would have to be downloaded first. The engine answers questions; a dialog
 * is what asks one.
 */
async function togglePhone() {
  const engine = phone()
  if (engine.isOpen()) {
    const result = await engine.run('close', {}, process.cwd())
    buildMenu()
    if (!result.ok) errorDialog(t('menu.phone'), new Error(result.why))
    return
  }

  const seen = inspectPhones({ chosen: chosenAndroid(), managed: paths.androidSdk })
  if (seen.android === 'ready') {
    const result = await engine.run('open', {}, process.cwd())
    buildMenu()
    if (!result.ok) errorDialog(t('dialog.phoneFailed'), new Error(result.why))
    return
  }
  if (seen.android !== 'stopped') {
    // Nothing to start. Which of the three reasons it is decides what the
    // offer should be, so the reason is what gets shown rather than a blanket
    // "unavailable" — see the ladder in phone-tool.js.
    const asked = await dialog.showMessageBox(state.window, {
      type: 'info',
      message: t('menu.phone'),
      detail: t(`dialog.phone.${seen.android}`),
      buttons: [t('button.install'), t('button.cancel')],
      cancelId: 1,
      defaultId: 0,
    })
    if (asked.response === 0) await installAndroid(seen)
    return
  }

  const avds = seen.sdk?.avds ?? []
  let chosen = avds[0]
  if (avds.length > 1) {
    // Buttons rather than a list window: a handful of names is what this is,
    // and a whole window for four buttons is a window to dismiss.
    const picked = await dialog.showMessageBox(state.window, {
      type: 'question',
      message: t('dialog.phonePick'),
      buttons: [...avds.slice(0, 6), t('button.cancel')],
      cancelId: Math.min(avds.length, 6),
    })
    if (picked.response >= Math.min(avds.length, 6)) return
    chosen = avds[picked.response]
  }
  const result = await engine.run('open', { avd: chosen }, process.cwd())
  buildMenu()
  if (!result.ok) errorDialog(t('dialog.phoneFailed'), new Error(result.why))
}

/**
 * Downloads an Android SDK, with the user's agreement to Google's terms.
 *
 * The agreement is the reason this is a flow and not a button. `sdkmanager`
 * will not install anything until its licences are accepted, it accepts them
 * from stdin, and this app could therefore send a `y` and never mention it.
 * That would make a contract between the user and Google into something that
 * happened while they were looking elsewhere. So the terms are named, the
 * size is named, the directory it lands in is named, and none of it starts
 * until somebody has read that and pressed the button.
 *
 * Progress goes to the log rather than to a progress bar. This is minutes of
 * downloading and unpacking, the menu says it is happening, and a modal
 * progress window over a long job is a window the user cannot put away.
 *
 * @param {import('./phone-tool.js').PhoneInspection} seen
 */
async function installAndroid(seen) {
  if (state.phoneInstalling) return
  if (!await hasJava()) {
    await dialog.showMessageBox(state.window, {
      type: 'warning',
      message: t('menu.phone'),
      detail: t('dialog.phoneNoJava'),
      buttons: [t('button.ok')],
    })
    return
  }

  // Into the user's own SDK when they have one — that is where their images
  // already live and where they would install the missing one themselves —
  // and into ours only when there is nothing to add to.
  const sdkRoot = seen.sdk?.root ?? paths.androidSdk
  const agreed = await dialog.showMessageBox(state.window, {
    type: 'question',
    message: t('dialog.phoneLicenceTitle'),
    detail: t('dialog.phoneLicence', { url: LICENCE_URL, dir: sdkRoot }),
    buttons: [t('button.agreeInstall'), t('button.cancel')],
    cancelId: 1,
    defaultId: 1,
  })
  if (agreed.response !== 0) return

  state.phoneInstalling = true
  state.phoneInstallAbort = new AbortController()
  const { signal } = state.phoneInstallAbort
  buildMenu()
  const window = openPhoneInstallWindow()
  const say = update => {
    if (window && !window.isDestroyed()) window.webContents.send('phone-install:state', update)
  }
  const step = key => { log(`android sdk: ${t(`phoneInstall.${key}`)}`); say({ step: t(`phoneInstall.${key}`) }) }

  try {
    // Our own two downloads report their own bytes; the packages do not, and
    // are watched on disk instead — see watchDownloads.
    if (!seen.sdk) {
      step('tools')
      await installTools({ sdkRoot, signal, onProgress: (received, total) => say({ received, total }) })
    }
    if (seen.android !== 'noDevice') {
      // The tools no longer manage packages themselves; they forward to a CLI
      // they would otherwise bootstrap over a download this app cannot watch
      // fail. Fetched here so that a failure is one we can describe.
      step('cli')
      await installCli({ sdkRoot, signal, onProgress: (received, total) => say({ received, total }) })

      step('packages')
      const packages = requiredPackages()
      const { total } = await packageSizes(packages).catch(() => ({ total: 0 }))
      say({ received: 0, total })
      const stopWatching = watchDownloads({ sdkRoot, total, onProgress: say })
      try {
        await installPackages({
          sdkRoot,
          packages,
          agreed: true,
          signal,
          onLine: line => { log(`android sdk: ${line}`); say({ line }) },
        })
      } finally {
        stopWatching()
      }
    }
    step('avd')
    await createAvd({ sdkRoot, name: AVD_NAME, onLine: line => { log(`android sdk: ${line}`); say({ line }) } })
    log('android sdk: ready')
    say({ step: t('dialog.phoneInstalled', { name: AVD_NAME }), done: true })
  } catch (error) {
    const cancelled = signal.aborted
    log(`android sdk: ${cancelled ? 'cancelled' : error?.message ?? error}`)
    say({
      step: cancelled ? t('phoneInstall.cancelled') : String(error?.message ?? error),
      failed: true,
    })
    if (!cancelled) errorDialog(t('dialog.phoneInstallFailed'), error)
  } finally {
    state.phoneInstalling = false
    state.phoneInstallAbort = undefined
    buildMenu()
  }
}

/**
 * The window that shows an install happening.
 *
 * A window rather than a modal progress dialog, because this is minutes long
 * and a modal over a long job is a thing the user cannot put away. It can be
 * closed and the install carries on; the menu still says it is running.
 */
function openPhoneInstallWindow() {
  const existing = state.phoneInstallWindow
  if (existing && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    return existing
  }
  const win = new BrowserWindow({
    width: 560,
    height: 380,
    title: t('dialog.phoneLicenceTitle'),
    ...ownedByMainWindow(),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(here, 'phone-install-preload.cjs') },
  })
  if (process.platform !== 'darwin') win.removeMenu()
  win.loadFile(path.join(here, '..', 'assets', 'phone-install.html'))
  win.on('closed', () => { state.phoneInstallWindow = undefined })
  state.phoneInstallWindow = win
  return win
}

/** The remembered panel width, or a sensible one. */
function panelWidth() {
  const saved = readSettings().previewPanelWidth
  return Number.isFinite(saved) && saved >= PANEL_MIN ? saved : PANEL_DEFAULT
}

/**
 * What the address strip shows at rest.
 *
 * Not the URL. A `file:` URL is percent-encoded, starts with three slashes
 * and is mostly directories nobody is reading; a deep http URL is mostly
 * path. The field is a few hundred pixels wide inside a side panel, and a
 * label clipped by CSS keeps whatever happened to fit — which for a long
 * path is the middle, the one part that identifies nothing.
 *
 * So it is shortened here, by meaning rather than by character count: the
 * host, or the last two path segments, which is what tells one page from
 * another. The whole URL is still a keystroke away — the field shows it the
 * moment it is focused.
 *
 * @param {string} url @returns {string}
 */
function previewLabel(url) {
  try {
    // A blank tab has nothing to say about itself; the strip's own wording
    // for that is better than the word "blank".
    if (url === '' || url === 'about:blank') return ''
    const parsed = new URL(url)
    if (parsed.protocol === 'file:') {
      const segments = decodeURIComponent(parsed.pathname).split('/').filter(Boolean)
      return segments.length <= 2 ? `/${segments.join('/')}` : `…/${segments.slice(-2).join('/')}`
    }
    const segments = parsed.pathname.split('/').filter(Boolean)
    const tail = segments.length <= 1 ? parsed.pathname : `/…/${segments[segments.length - 1]}`
    return `${parsed.host}${tail === '/' ? '' : tail}${parsed.search ? '?…' : ''}`
  } catch {
    return url
  }
}


// ── Driving it ──────────────────────────────────────────────────────────────
// The verbs in src/browser-ops.js, executed against a page. Two callers reach
// them: the MCP server the model gets its tools from, and `dsh-browser` on
// the command line — both over the socket in src/open-bridge.js, both landing
// here.
//
// Two decisions run through all of it. Input is real: a click is a click at a
// point, delivered to the compositor, not a DOM event the page can tell apart
// from a person's. And an action that changes the page answers with a fresh
// snapshot, because the next thing the agent needs is always what the page
// became — asking separately costs a round trip and, worse, invites acting on
// refs that the last action already invalidated.

/** How long to let a page settle after an action before describing it again. */
const SETTLE_MS = 350
/** A `eval` result longer than this is summarised rather than returned whole. */
const EVAL_MAX = 20_000

/**
 * Runs one browser verb.
 *
 * Never throws: every caller is a program the agent is reading the output of,
 * and a stack trace on stderr is not an answer it can act on. Failures come
 * back as `{ok: false, why}` in words that say what to do instead.
 *
 * @param {string} op @param {object} params
 * @returns {Promise<object>}
 */
async function runBrowserOp(op, params = {}) {
  if (!Object.hasOwn(BROWSER_VERBS, op)) return { ok: false, why: `unknown command "${op}"` }
  if (!state.window || state.window.isDestroyed()) return { ok: false, why: 'the app has no window open' }
  try {
    return await BROWSER_VERBS[op](params ?? {})
  } catch (error) {
    return { ok: false, why: error?.message ?? String(error) }
  }
}

/** Resolves the page a verb acts on, or says why it cannot. */
function requirePage(params) {
  const entry = pageFor(params.page)
  if (entry) return entry
  return params.page
    ? { error: { ok: false, why: `no page "${params.page}"; use pages to list them` } }
    : { error: { ok: false, why: 'no page open; use navigate first' } }
}

/** @type {Record<string, (params: object) => Promise<object>>} */
const BROWSER_VERBS = {
  async navigate(params) {
    const resolved = previewTarget(String(params.url ?? ''), { wide: true, exists: existsSync })
    if (!resolved) return { ok: false, why: 'not an http(s) URL or a readable local page' }
    if (isHarnessOrigin(resolved.url)) return { ok: false, why: 'that is the harness itself' }
    const entry = pageFor(params.page) ?? frontPage() ?? createPage()
    // A verb aimed at a named page leaves the panel where it is: an agent
    // working through four systems in four tabs should not drag the window
    // forward four times.
    if (params.page === undefined) {
      if (state.front !== entry.id) showPage(entry.id)
      showWindow()
    }
    await entry.ready
    // A load that is superseded or refused rejects; the page then still says
    // what it is showing, which is more useful than the error alone.
    await entry.view.webContents.loadURL(resolved.url).catch(error => {
      remember(entry.console, { level: 'error', message: String(error?.message ?? error) })
    })
    return describe(entry)
  },

  back: params => history(params, 'goBack', 'canGoBack'),
  forward: params => history(params, 'goForward', 'canGoForward'),
  async reload(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    found.view.webContents.reload()
    return describe(found)
  },

  async snapshot(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const described = await describe(found, {
      settle: 0,
      snapshot: {
        ref: params.ref === undefined ? undefined : refNumber(params.ref),
        within: params.within,
        filter: params.filter,
        depth: params.depth,
        max: params.max,
      },
    })
    // A root that no longer exists is a ref problem, and reads better in the
    // words every other ref failure already uses.
    if (described.snapshotError === 'no-match') return { ok: false, why: `nothing on the page matches ${params.within}` }
    if (described.snapshotError && params.ref !== undefined) return refFailure({ why: described.snapshotError })
    return described
  },

  async find(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const result = await found.view.webContents.executeJavaScript(findScript(params.query), true)
    if (!result.ok) {
      return result.why === 'no-query'
        ? { ok: false, why: 'find needs something to look for' }
        : refFailure({ why: result.why })
    }
    return result.hits.length === 0
      ? { ok: true, page: found.id, elements: [], why: 'nothing in the last snapshot matched' }
      : { ok: true, page: found.id, elements: result.hits }
  },

  async text(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const max = Number.isInteger(params.max) && params.max > 0 ? params.max : DEFAULT_TEXT_MAX
    const result = await found.view.webContents.executeJavaScript(textScript(max), true)
    return { ok: true, page: found.id, ...result }
  },

  async click(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const contents = found.view.webContents
    let point = { x: params.x, y: params.y }
    let covered
    if (params.ref !== undefined) {
      const located = await locate(contents, params.ref)
      if (!located.ok) return refFailure(located)
      point = { x: located.x, y: located.y }
      covered = located.coveredBy
    }
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return { ok: false, why: 'click needs a ref, or x and y' }
    const button = ['left', 'right', 'middle'].includes(params.button) ? params.button : 'left'
    sendClick(contents, point, button, params.doubleClick ? 2 : 1)
    // Reported rather than refused: clicking a covered point is what a person
    // clicking there would do, and the agent needs to know a banner ate it.
    return { ...await describe(found), ...(covered ? { coveredBy: covered } : {}) }
  },

  async hover(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const located = await locate(found.view.webContents, params.ref)
    if (!located.ok) return refFailure(located)
    found.view.webContents.sendInputEvent({ type: 'mouseMove', x: located.x, y: located.y })
    return describe(found)
  },

  async type(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const contents = found.view.webContents
    if (params.ref !== undefined) {
      const located = await locate(contents, params.ref)
      if (!located.ok) return refFailure(located)
      // Clicked rather than focused: a field inside a widget that opens on
      // click needs the click, and focus() alone leaves such widgets shut.
      sendClick(contents, located, 'left', 1)
      await sleep(60)
    }
    if (params.clear && params.ref !== undefined) {
      await contents.executeJavaScript(clearScript(refNumber(params.ref)), true)
    }
    // insertText rather than a key event per character: it goes to whatever
    // has focus, fires the input events a controlled component listens for,
    // and does not take a second per sentence.
    contents.insertText(String(params.text ?? ''))
    if (params.submit) {
      await sleep(40)
      pressKey(contents, 'Enter', [])
    }
    return describe(found)
  },

  async select(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const result = await found.view.webContents.executeJavaScript(
      selectScript(refNumber(params.ref), String(params.value ?? '')), true)
    if (!result.ok) return { ok: false, why: result.why, ...(result.options ? { options: result.options } : {}) }
    return describe(found)
  },

  async key(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const parts = String(params.name ?? '').split('+').map(part => part.trim()).filter(Boolean)
    const keyCode = parts.pop()
    if (!keyCode) return { ok: false, why: 'key needs a name, e.g. Enter or Control+a' }
    pressKey(found.view.webContents, keyCode, parts.map(part => part.toLowerCase()))
    return describe(found)
  },

  async scroll(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    if (params.ref !== undefined) {
      const result = await found.view.webContents.executeJavaScript(scrollToScript(refNumber(params.ref)), true)
      if (!result.ok) return refFailure(result)
      return describe(found)
    }
    const { height } = found.view.getBounds()
    const amount = Number.isInteger(params.amount) ? params.amount : Math.round(height * 0.8)
    const direction = params.direction ?? 'down'
    const delta = { up: [0, -amount], down: [0, amount], left: [-amount, 0], right: [amount, 0] }[direction]
    if (!delta) return { ok: false, why: 'scroll takes up, down, left or right' }
    const moved = await found.view.webContents.executeJavaScript(scrollScript(delta[0], delta[1]), true)
    return { ...await describe(found), scrolled: moved.moved, atEnd: moved.atEnd }
  },

  async eval(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const value = await found.view.webContents.executeJavaScript(String(params.js ?? ''), true)
    let text
    try {
      text = value === undefined ? 'undefined' : JSON.stringify(value)
    } catch {
      // A circular or exotic value still has a shape worth reporting.
      text = String(value)
    }
    return text !== undefined && text.length > EVAL_MAX
      ? { ok: true, page: found.id, truncated: true, result: text.slice(0, EVAL_MAX) }
      : { ok: true, page: found.id, result: text }
  },

  async screenshot(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const region = ['x', 'y', 'width', 'height'].every(name => Number.isInteger(params[name]))
      ? { x: params.x, y: params.y, width: params.width, height: params.height }
      : undefined
    if (region && (region.width <= 0 || region.height <= 0)) return { ok: false, why: 'a region needs a positive width and height' }
    const image = await found.view.webContents.capturePage(region)
    const png = image.toPNG()
    if (params.path) {
      const file = path.resolve(String(params.path))
      writeFileSync(file, png)
      return { ok: true, page: found.id, path: file, bytes: png.length }
    }
    return { ok: true, page: found.id, png: png.toString('base64') }
  },

  async console(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    let rows = found.console
    if (params.onlyErrors) rows = rows.filter(row => row.level === 'error')
    if (params.pattern !== undefined) {
      const test = compilePattern(params.pattern)
      if (test.error) return test.error
      rows = rows.filter(row => test.re.test(row.message))
    }
    return { ok: true, page: found.id, messages: lastOf(rows, params.limit) }
  },

  async network(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    let rows = found.network
    // A failure is a non-2xx as much as it is a transport error; an agent
    // asking for "what went wrong" means both.
    if (params.onlyErrors) rows = rows.filter(row => row.error !== undefined || (row.status ?? 0) >= 400)
    if (params.urlPattern !== undefined) {
      const test = compilePattern(params.urlPattern)
      if (test.error) return test.error
      rows = rows.filter(row => test.re.test(row.url))
    }
    const shown = await withPreviews(found, lastOf(rows, params.limit))
    // Said once rather than marked on every line. A request the inspector
    // missed still appears — the other recorder saw it — but it has no id, so
    // its body cannot be asked for, and the fix is a word rather than a
    // mystery: the requests of a reload are all caught.
    const bodiless = found.inspectorNetwork && shown.some(row => row.id === undefined)
    return {
      ok: true,
      page: found.id,
      requests: shown,
      ...(bodiless ? { why: 'rows with no id were seen too early for the inspector; reload to make their bodies readable' } : {}),
    }
  },

  async body(params) {
    const { error, ...found } = requirePage(params)
    return error ?? responseBody(found, String(params.requestId ?? ''))
  },

  async viewport(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    if (found.inspector !== true) return { ok: false, why: `the viewport cannot be changed: ${found.inspector}` }
    const contents = found.view.webContents
    if (params.preset !== undefined && !Object.hasOwn(VIEWPORTS, params.preset)) {
      return { ok: false, why: `no such preset; try ${Object.keys(VIEWPORTS).join(', ')}` }
    }
    const named = params.preset ? VIEWPORTS[params.preset] : undefined
    const width = Number.isInteger(params.width) ? params.width : named?.width
    const height = Number.isInteger(params.height) ? params.height : named?.height
    const notes = []
    if (params.reset) {
      await inspectorCommand(contents, 'Emulation.clearDeviceMetricsOverride')
      await inspectorCommand(contents, 'Emulation.setTouchEmulationEnabled', { enabled: false })
      await inspectorCommand(contents, 'Emulation.setUserAgentOverride', { userAgent: found.userAgent })
      notes.push('viewport back to the panel')
    } else if (width && height) {
      const mobile = params.mobile ?? named?.mobile ?? false
      await inspectorCommand(contents, 'Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: named?.scale ?? 1, mobile,
      })
      // Touch and the user agent travel with the metrics on purpose: a layout
      // that is only narrow is not what a phone gets, and the bugs live in
      // the difference — hover menus with no hover, and desktop pages served
      // by sniffing.
      await inspectorCommand(contents, 'Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 })
      await inspectorCommand(contents, 'Emulation.setUserAgentOverride', { userAgent: mobile ? MOBILE_USER_AGENT : found.userAgent })
      notes.push(`viewport ${width}x${height}${mobile ? ', touch, mobile user agent' : ''}`)
    }
    if (params.colorScheme !== undefined) {
      if (!['dark', 'light', 'auto'].includes(params.colorScheme)) {
        return { ok: false, why: 'colorScheme takes dark, light or auto' }
      }
      await inspectorCommand(contents, 'Emulation.setEmulatedMedia', params.colorScheme === 'auto'
        ? { features: [] }
        : { features: [{ name: 'prefers-color-scheme', value: params.colorScheme }] })
      notes.push(`prefers-color-scheme: ${params.colorScheme}`)
    }
    if (notes.length === 0) return { ok: false, why: 'viewport takes a preset, a width and height, colorScheme, or reset' }
    return { ...await describe(found), why: notes.join('; ') }
  },

  async drag(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const contents = found.view.webContents
    // Both ends are resolved before the button goes down: locating a ref
    // scrolls it into view, and scrolling mid-drag would move the target out
    // from under the pointer that is already holding something.
    const from = await endpoint(contents, params.ref, params.x, params.y)
    if (from.error) return from.error
    const to = await endpoint(contents, params.toRef, params.toX, params.toY)
    if (to.error) return to.error
    contents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 })
    // Stepped rather than jumped: a drag that never moves is a drag most
    // implementations ignore, because they start on the first move event.
    const steps = 12
    for (let step = 1; step <= steps; step += 1) {
      contents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(from.x + ((to.x - from.x) * step) / steps),
        y: Math.round(from.y + ((to.y - from.y) * step) / steps),
      })
      await sleep(16)
    }
    contents.sendInputEvent({ type: 'mouseUp', x: to.x, y: to.y, button: 'left', clickCount: 1 })
    return describe(found)
  },

  async wait(params) {
    const { error, ...found } = requirePage(params)
    if (error) return error
    const contents = found.view.webContents
    if (params.text === undefined && params.selector === undefined) {
      await sleep(Math.min(Number.isInteger(params.ms) ? params.ms : 1000, DEFAULT_WAIT_MS))
      return describe(found, { settle: 0 })
    }
    const deadline = Date.now() + (Number.isInteger(params.timeoutMs) ? params.timeoutMs : DEFAULT_WAIT_MS)
    const script = waitScript({ text: params.text, selector: params.selector })
    while (Date.now() < deadline) {
      if (await contents.executeJavaScript(script, true).catch(() => false)) {
        return describe(found, { settle: 0 })
      }
      await sleep(150)
    }
    return { ...await describe(found, { settle: 0 }), ok: false, why: 'timed out waiting' }
  },

  async pages() {
    const rows = []
    for (const entry of state.pages.values()) {
      const contents = entry.view.webContents
      rows.push({
        page: entry.id,
        front: state.front === entry.id,
        title: contents.getTitle(),
        url: contents.getURL(),
        loading: contents.isLoading(),
      })
    }
    return { ok: true, pages: rows }
  },

  async newPage(params) {
    const entry = createPage({ background: Boolean(params.background) })
    if (!params.url) return { ok: true, page: entry.id, front: state.front === entry.id }
    return BROWSER_VERBS.navigate({ url: params.url, page: entry.id })
  },

  async show(params) {
    if (!showPage(String(params.page ?? ''))) return { ok: false, why: `no page "${params.page}"` }
    showWindow()
    return describe(pageFor(params.page), { settle: 0 })
  },

  async closePage(params) {
    if (!closePage(String(params.page ?? ''))) return { ok: false, why: `no page "${params.page}"` }
    return { ok: true, closed: params.page, remaining: state.pages.size }
  },

  async close() {
    closePanel()
    return { ok: true, closed: true }
  },
}

/** back and forward differ by two method names and nothing else. */
async function history(params, go, can) {
  const { error, ...found } = requirePage(params)
  if (error) return error
  const contents = found.view.webContents
  if (!contents.navigationHistory[can]()) return { ok: false, why: `nothing to go ${go === 'goBack' ? 'back' : 'forward'} to` }
  contents.navigationHistory[go]()
  return describe(found)
}

/**
 * What a page looks like now: url, title, and the list of things to act on.
 *
 * Returned by every verb that changes something, because the refs the agent
 * holds were collected before that change and may no longer mean anything.
 */
async function describe(entry, { settle = SETTLE_MS, snapshot: options } = {}) {
  if (settle) await sleep(settle)
  const contents = entry.view.webContents
  // A page still loading is described anyway rather than waited for: a slow
  // page that never finishes is exactly the case where the agent needs to see
  // what did arrive, and `wait` is there for when it needs more.
  const snapshot = await contents.executeJavaScript(snapshotScript(options), true).catch(error => ({
    nodes: [], truncated: false, url: contents.getURL(), title: contents.getTitle(),
    error: String(error?.message ?? error),
  }))
  return {
    ok: true,
    page: entry.id,
    url: snapshot.url,
    title: snapshot.title,
    loading: contents.isLoading(),
    truncated: snapshot.truncated,
    elements: snapshot.nodes,
    ...(snapshot.error ? { snapshotError: snapshot.error } : {}),
  }
}

/**
 * What somebody typing in the address field probably meant.
 *
 * A person types `example.com`, not `https://example.com`, and an absolute
 * path is a path. Everything already carrying a scheme is left exactly as it
 * is — including the ones the browser will refuse, because guessing at a
 * `javascript:` line would be the wrong kind of helpful.
 *
 * @param {string} typed @returns {string}
 */
function typedUrl(typed) {
  const text = typed.trim()
  if (text === '' || path.isAbsolute(text)) return text
  if (/^[a-z][a-z\d+.-]*:/i.test(text)) return text
  // A bare word with a dot and no space is a host; anything else is not
  // something this field can turn into an address.
  return /^[^\s/]+\.[^\s/]+/.test(text) ? `https://${text}` : text
}

/** `ref_12` and `12` both name the twelfth. */
function refNumber(ref) {
  const match = /(\d+)/.exec(String(ref ?? ''))
  return match ? Number(match[1]) : -1
}

function locate(contents, ref) {
  return contents.executeJavaScript(locateScript(refNumber(ref)), true)
}

/** The four ways a ref can fail, in words that say what to do about it. */
/** One protocol command, for the verbs that reach past Electron's own API. */
function inspectorCommand(contents, method, params = {}) {
  return contents.debugger.sendCommand(method, params)
}

/**
 * A filter the agent wrote, as a regular expression.
 *
 * Taken as a pattern rather than a substring because the useful questions are
 * alternations — `404|500`, `/api/(users|orders)` — and a bad pattern is
 * answered with the reason rather than with an empty list, which would read
 * as "nothing matched" and send the agent looking in the wrong place.
 */
function compilePattern(pattern) {
  try {
    return { re: new RegExp(String(pattern), 'i') }
  } catch (error) {
    return { error: { ok: false, why: `not a regular expression: ${error?.message ?? error}` } }
  }
}

/** The tail of a log, which is the part a question is almost always about. */
function lastOf(rows, limit) {
  return Number.isInteger(limit) && limit > 0 ? rows.slice(-limit) : rows
}

/**
 * What one request actually came back with.
 *
 * The reason the inspector is attached at all. Without it an agent that wants
 * to know why an endpoint misbehaved has to fetch the URL a second time —
 * from a different client, without the page's cookies, and with whatever side
 * effects a second POST carries. This returns the bytes the page itself got.
 *
 * The browser drops bodies when the page navigates and when its buffer fills,
 * so a miss is normal rather than broken, and says so.
 */
async function responseBody(entry, requestId) {
  if (!entry.inspectorNetwork) {
    return { ok: false, why: `response bodies need the inspector: ${entry.inspector === true ? 'it is attached but not recording' : entry.inspector}` }
  }
  if (!entry.network.some(row => row.id === requestId)) {
    return { ok: false, why: `no request ${requestId} on this page; call network to list them` }
  }
  const result = await inspectorCommand(entry.view.webContents, 'Network.getResponseBody', { requestId })
    .catch(error => ({ failed: String(error?.message ?? error) }))
  if (result.failed !== undefined || result.body === undefined) {
    return { ok: false, why: 'the browser no longer holds that body; it is dropped on navigation and when the buffer fills' }
  }
  const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : String(result.body)
  return text.length > BODY_MAX
    ? { ok: true, page: entry.id, truncated: true, text: text.slice(0, BODY_MAX) }
    : { ok: true, page: entry.id, text }
}

/**
 * Puts the start of the interesting bodies into the request list.
 *
 * Because a status code can lie. A service that answers 200 with
 * `{"error": …}` reads as a healthy request in any listing, and the agent
 * that believes the listing goes looking for the bug in the arithmetic that
 * consumed it. The body is the evidence, and evidence that has to be asked
 * for separately is evidence that gets skipped — the model reaches for the
 * shell it already knows instead.
 *
 * So a body the page had to parse, or one that failed, arrives with the list.
 * Bounded on both axes: a few rows, a couple of hundred characters, and each
 * row asked about once however often the list is read.
 */
async function withPreviews(entry, rows) {
  if (!entry.inspectorNetwork) return rows
  const wanted = rows.filter(row => row.id !== undefined && row[PREVIEWED] !== true && worthPreviewing(row))
  // The newest few: an agent asking what just happened means the end of the
  // list, and fetching every JSON response on a busy page would turn reading
  // the log into a hundred round trips.
  for (const row of wanted.slice(-PREVIEW_ROWS)) {
    row[PREVIEWED] = true
    const result = await inspectorCommand(entry.view.webContents, 'Network.getResponseBody', { requestId: row.id })
      .catch(() => undefined)
    if (!result || result.body === undefined) continue
    const text = result.base64Encoded ? Buffer.from(result.body, 'base64').toString('utf8') : String(result.body)
    const flat = text.replace(/\s+/g, ' ').trim()
    if (flat) row.preview = flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX)}…` : flat
  }
  return rows
}

/**
 * Whether a body belongs in the list unasked.
 *
 * JSON whatever its status, because that is the shape a page parses and the
 * shape that lies; anything that failed, because the reason is in the body.
 * Not the document itself and not assets — a listing full of HTML and CSS
 * is a listing nobody reads. A transport error has no body at all.
 */
function worthPreviewing(row) {
  if (row.error !== undefined) return false
  if ((row.status ?? 0) >= 400) return true
  return /json/i.test(row.mime ?? '')
}

/** One end of a drag: a ref, or a point, or the reason it is neither. */
async function endpoint(contents, ref, x, y) {
  if (ref !== undefined) {
    const located = await locate(contents, ref)
    return located.ok ? { x: located.x, y: located.y } : { error: refFailure(located) }
  }
  if (Number.isFinite(x) && Number.isFinite(y)) return { x, y }
  return { error: { ok: false, why: 'drag needs a ref, or an x and y, at each end' } }
}

function refFailure(located) {
  const why = {
    'no-snapshot': 'no snapshot on this page yet; call snapshot first',
    'unknown-ref': 'no such ref in the last snapshot; call snapshot again',
    'stale-ref': 'that element is gone; the page changed, call snapshot again',
    'not-visible': 'that element has no size on screen',
    'not-a-select': 'that element is not a <select>',
  }[located.why]
  return { ok: false, why: why ?? located.why ?? 'could not locate that element' }
}

/** A press and a release at a point — what the compositor sees from a mouse. */
function sendClick(contents, { x, y }, button, clickCount) {
  const at = { x, y, button, clickCount }
  contents.sendInputEvent({ type: 'mouseDown', ...at })
  contents.sendInputEvent({ type: 'mouseUp', ...at })
}

/**
 * Keys that carry a character, and therefore need the `char` event.
 *
 * Without it a printable key moves focus and types nothing — and Enter, which
 * looks like a named key, is the one that matters most: a form submits on the
 * keypress, so `type --submit` with only keyDown/keyUp fills the field and
 * then does nothing at all.
 */
function carriesCharacter(keyCode, modifiers) {
  if (modifiers.length > 0) return false
  return keyCode.length === 1 || keyCode === 'Enter' || keyCode === 'Return' || keyCode === 'Tab'
}

/** A key press: down, the character if it has one, up. */
function pressKey(contents, keyCode, modifiers) {
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
  if (carriesCharacter(keyCode, modifiers)) contents.sendInputEvent({ type: 'char', keyCode, modifiers })
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Panel buttons, the seam, and the page's own request to be previewed. */
function registerPreviewIpc() {
  const withPage = handler => () => {
    const entry = frontPage()
    if (entry) handler(entry.view.webContents)
  }
  ipcMain.on('preview:back', withPage(page => page.navigationHistory.goBack()))
  ipcMain.on('preview:forward', withPage(page => page.navigationHistory.goForward()))
  ipcMain.on('preview:reload', withPage(page => page.reload()))
  ipcMain.on('preview:close', () => closePanel())
  ipcMain.on('preview:external', withPage(page => {
    const url = page.getURL()
    // file: included, deliberately: "open in the system browser" on a local
    // page is the escape hatch back to the behaviour this replaced.
    if (/^(file|http|https):/i.test(url)) shell.openExternal(url).catch(error => log(`preview external: ${error?.message ?? error}`))
  }))
  // The seam reports where the pointer is on screen, not how far it moved:
  // a drag that outruns the layout would otherwise accumulate the difference
  // and leave the seam somewhere the pointer is not.
  ipcMain.on('preview:seam', (_event, screenX) => {
    if (!state.panel || !Number.isFinite(screenX)) return
    const bounds = state.window.getContentBounds()
    // Clamped before it is stored, not only before it is drawn: a drag that
    // ran past the conversation's floor would otherwise be remembered as the
    // width the user wanted, and restored on a wider window as a panel that
    // takes nearly everything.
    state.panelWidth = clampPanel(Math.round(bounds.x + bounds.width - screenX), bounds.width)
    layoutWindow()
  })
  ipcMain.on('preview:seam-done', () => {
    if (state.panel) writeSettings({ previewPanelWidth: state.panelWidth })
  })
  ipcMain.on('preview:navigate', (_event, typed) => {
    runBrowserOp('navigate', { url: typedUrl(String(typed ?? '')) })
      .then(result => { if (!result.ok) log(`address bar: ${result.why}`) })
  })
  ipcMain.on('preview:select-tab', (_event, id) => { showPage(String(id)) })
  ipcMain.on('preview:close-tab', (_event, id) => { closePage(String(id)) })
  ipcMain.on('preview:new-tab', () => {
    createPage()
    pushPanelState()
  })
  // From the dsh UI's own page, through the wrapper in src/preview.js. It
  // gets a plain boolean: the page is not ours, and "why not" is a sentence
  // for the agent's console, not for a fetch that is about to fall through.
  ipcMain.handle('preview:open', (event, target) => {
    if (event.sender !== state.chat?.webContents) return false
    return openPreview(String(target ?? '')).ok
  })
}

/**
 * Starts the agent's side of it: the socket, and the command that writes to it.
 *
 * Needs the toolchain, because the command it writes is a stub around the
 * bundled Node. Failure here costs the agent one way of showing a page and
 * nothing else, so it is logged rather than raised — the UI's own chips still
 * work, and so does the system browser.
 *
 * @returns {Promise<{ DSH_DESKTOP_OPEN_SOCKET: string, DSH_DESKTOP_OPEN_TOKEN: string } | undefined>}
 */
async function startOpenBridge() {
  try {
    const address = bridgeAddress(app.getPath('userData'))
    const token = mintToken()
    state.openBridge = await startBridge({
      address,
      token,
      run: async (op, params, cwd) => {
        // One socket, two surfaces. The browser's verbs are bare because they
        // were here first and `dsh-open` already sends them that way;
        // everything since carries its own prefix. Without one, `close` and
        // `navigate` and half the rest would each mean two things.
        const result = op.startsWith(MINIAPP_PREFIX)
          ? await miniapp().run(op.slice(MINIAPP_PREFIX.length), params, cwd)
          : op.startsWith(PHONE_PREFIX)
            ? await phone().run(op.slice(PHONE_PREFIX.length), params, cwd)
            : await runBrowserOp(op, params)
        // One line per call, and the answer is not in it: a snapshot is
        // hundreds of elements and the log is for support, not for a
        // transcript of everything the agent looked at.
        log(`${op}${params?.url ? ` ${params.url}` : ''}${result?.ok === false ? `: ${result.why}` : ''}`)
        // Opening or closing a simulator changes what the menu should say.
        if (/\.(open|close)$/.test(op)) buildMenu()
        return result
      },
      log,
    })
    const commands = writeOpenCommand({ binDir: paths.binDir, nodeBin: state.toolchain.nodeBin, srcDir: here })
    await registerTools(commands)
    return { DSH_DESKTOP_OPEN_SOCKET: address, DSH_DESKTOP_OPEN_TOKEN: token, ...bundledSkillEnv() }
  } catch (error) {
    log(`open bridge unavailable: ${error?.message ?? error}`)
    return undefined
  }
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
  // A build under a brand that names no repository takes no updates: asking
  // the original's would offer this app a replacement wearing another name.
  if (!REPO) {
    if (!silent) await dialog.showMessageBox(state.window, { message: t('error.updateNoRepo') })
    return
  }
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
    ...ownedByMainWindow(),
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
  dismissOnOutsideFocus(win)
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
  ipcMain.on('phone-install:cancel', () => { state.phoneInstallAbort?.abort() })
  ipcMain.on('phone-install:close', () => {
    const win = state.phoneInstallWindow
    if (win && !win.isDestroyed()) win.close()
  })
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
    // Whatever the server was actually given, so the window lists the skills
    // the agent has rather than the ones this shell would have supplied.
    bundledDir: state.childEnv?.DSH_BUNDLED_SKILL_DIR ?? process.env.DSH_BUNDLED_SKILL_DIR,
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
    ...ownedByMainWindow(),
    webPreferences: { preload: path.join(here, 'skills-preload.cjs') },
  })
  if (process.platform !== 'darwin') win.removeMenu()
  win.loadFile(path.join(assets, 'skills.html'))
  dismissOnOutsideFocus(win)
  win.on('closed', () => { state.skillsWindow = null })
  state.skillsWindow = win
}

/**
 * Marks a skill operation as in flight, for the badge to report.
 *
 * Not a lock — skills have no profile to corrupt and two installs can run —
 * only a flag, so that the seconds a download takes are seconds the badge
 * can account for instead of showing "ready" while the user waits.
 */
async function withSkillWork(work) {
  state.skillBusy = (state.skillBusy ?? 0) + 1
  try {
    return await work()
  } finally {
    state.skillBusy -= 1
    if (state.skillBusy <= 0) state.skillBusy = undefined
  }
}

/**
 * The page's storage, held for the next origin.
 *
 * Written whole and read whole, with nothing here understanding a single key
 * of it: this is a courier, and the moment it started interpreting the cargo
 * it would start breaking when the cargo changed.
 */
function registerUiStateIpc() {
  ipcMain.on('ui-state:load', event => {
    try {
      event.returnValue = JSON.parse(readFileSync(paths.uiStateFile, 'utf8'))
    } catch {
      // No snapshot yet, or one that will not parse. Either way the page keeps
      // whatever it has, which is the safe direction to fail in.
      event.returnValue = undefined
    }
  })

  ipcMain.on('ui-state:save', (_event, payload) => {
    if (!payload || typeof payload.origin !== 'string' || typeof payload.data !== 'object') return
    try {
      writeFileSync(paths.uiStateFile, `${JSON.stringify({
        origin: payload.origin, data: payload.data, savedAt: new Date().toISOString(),
      }, null, 2)}\n`)
    } catch (error) {
      log(`could not save the interface state: ${error?.message ?? error}`)
    }
  })
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

  ipcMain.handle('skills:install-directory', (_event, source) => withSkillWork(() => installFromDirectory({
    source: String(source), skillsDir: skillsDir(), log: skillsLog,
  })))
  ipcMain.handle('skills:install-zip', (_event, zipPath) => withSkillWork(() => installFromZip({
    zipPath: String(zipPath), skillsDir: skillsDir(), log: skillsLog,
  })))
  ipcMain.handle('skills:install-github', (_event, input) => withSkillWork(() => installFromGitHub({
    input: String(input), skillsDir: skillsDir(), originsFile: paths.skillOrigins,
    fetchImpl: net.fetch, log: skillsLog,
  })))

  // Origins are read here rather than in the window so the page never sees
  // a path on this machine; it only needs to know which entries can update.
  ipcMain.handle('skills:check-updates', async () => findSkillUpdates({
    origins: await readOrigins(paths.skillOrigins), fetchImpl: net.fetch, log: skillsLog,
  }))
  ipcMain.handle('skills:update', async (_event, entry) => {
    const skill = await writableSkill(entry)
    return updateSkill({
      entry: skill.entry, skillsDir: skillsDir(), originsFile: paths.skillOrigins,
      fetchImpl: net.fetch, log: skillsLog,
    })
  })

  // The same catalog and the same cache as the plugin market: one document
  // classifies both, and a second copy of it would go stale separately.
  ipcMain.handle('skills:catalog', async (_event, force) => {
    const catalog = await loadCatalog({
      url: catalogUrl(), cacheFile: paths.marketCache, force: force === true,
      fetchImpl: net.fetch, log: skillsLog,
    })
    return { ...catalog, entries: catalog.entries.filter(entry => entry.kind === 'skill') }
  })
  // A constant, not a fetch: what is in each repository comes from the
  // repository when the user opens it, so nothing here can go stale.
  ipcMain.handle('skills:recommended', () => RECOMMENDED_SOURCES)
  // One request, no downloads: enough to show what a repository holds so
  // the user can take one skill instead of twenty.
  ipcMain.handle('skills:list-repo', async (_event, repo) => {
    const { skills } = await listRepoSkills({ repo: String(repo), fetchImpl: net.fetch })
    return skills.map(skill => ({ subpath: skill.subpath, files: skill.files.length }))
  })
  ipcMain.handle('skills:open-link', (_event, url) => openMarketLink(url))

  ipcMain.handle('skills:set-enabled', async (_event, entry, enabled) => {
    const skill = await writableSkill(entry)
    await setSkillEnabled(skill, enabled === true)
    skillsLog(`${skill.name ?? skill.entry} ${enabled === true ? 'on' : 'off'}`)
  })

  ipcMain.handle('skills:remove', async (_event, entry) => {
    const skill = await writableSkill(entry)
    await removeSkill({ skillsDir: skillsDir(), entry: skill.entry, originsFile: paths.skillOrigins })
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

// ── Performance badge ────────────────────────────────────────────────────────
// A small always-on-top window showing what the harness is costing right now.
// It samples only while it is open: the reading comes from spawning `ps`, and
// a badge nobody has asked for has no business doing that once a second
// forever.

/** How often to read. Windows pays hundreds of milliseconds per sample. */
const HUD_INTERVAL_MS = process.platform === 'win32' ? 2000 : 1000
/** Below this two readings are the clock's resolution, not the process's work. */
const MIN_HUD_SAMPLE_MS = 400
/**
 * How far past its style's width the badge may grow to fit its contents.
 *
 * A style's width is a starting point, not a promise: CPU is reported per
 * core, so it runs from one digit to four, and a badge that clipped the
 * number would be misreporting at exactly the moment the number matters. The
 * cap is here so a bad measurement cannot put a window across the screen.
 */
const HUD_MAX_GROWTH = 180
/**
 * The layouts the badge comes in, and what each needs to hold its contents.
 *
 * A size per style rather than one window that reflows: the badge is docked
 * in a corner, and a card that kept a standard window's footprint while
 * showing one number would be mostly empty space held over the user's work.
 */
const HUD_STYLES = {
  standard: { width: 232, height: 112 },
  assistant: { width: 246, height: 74 },
  compact: { width: 214, height: 46 },
  minimal: { width: 112, height: 46 },
  // The character layouts: a drawn face, the state in words beside it, and
  // the numbers demoted to a footnote. Same width for the three so switching
  // between them does not move the badge.
  // Wide enough for the worst case rather than the common one: a badge that
  // clipped exactly when the machine was saturated would be useless at the
  // only moment somebody looks at it.
  pup: { width: 288, height: 82 },
  capybara: { width: 288, height: 82 },
  anime: { width: 288, height: 82 },
}
const DEFAULT_HUD_STYLE = 'standard'

/** The chosen layout, or the default when the setting is absent or unknown. */
/**
 * The picture the character layouts draw, when the user has supplied one.
 *
 * The app ships drawings of its own and nothing else. Anything with a face
 * that somebody would actually want here belongs to whoever made it, and
 * bundling that into an installer this project publishes is not this
 * project's to do — so the badge reads a file the user points it at instead.
 * It is copied into the data directory on the way in, because a badge that
 * broke whenever a folder was tidied would be worse than no badge.
 *
 * Any image the renderer can draw works, animated GIF and WebP included,
 * which is most of what makes one of these feel alive.
 *
 * @returns {string|undefined} an absolute path, when one is set and present
 */
function hudCharacter() {
  const saved = readSettings().hudCharacter
  if (typeof saved !== 'string' || saved === '') return undefined
  const base = path.join(paths.hudDir, path.basename(saved))
  if (!existsSync(base)) return undefined

  // One picture is enough and is what the menu produces. Three make it a
  // character rather than a sticker: drop `character-busy` and
  // `character-down` beside it, in any format the first one uses or another,
  // and the badge shows the face that matches what it is reporting. Missing
  // ones fall back to the base picture, so partial sets work.
  const stem = base.slice(0, -path.extname(base).length)
  const variant = suffix => {
    for (const ext of ['.gif', '.webp', '.apng', '.png', '.svg', '.jpg', '.jpeg']) {
      const file = `${stem}-${suffix}${ext}`
      if (existsSync(file)) return file
    }
    return base
  }
  return { idle: base, busy: variant('busy'), down: variant('down') }
}

/**
 * The query string the badge page is loaded with.
 *
 * Layout and pictures both travel this way, for the same reason the language
 * does: the page paints before there is any channel to ask over, and a badge
 * that flickered from one face to another on every open would be worse than
 * one that took a moment longer.
 */
function hudSearch(style) {
  const character = hudCharacter()
  const parts = [`style=${style}`]
  if (character) {
    for (const [key, file] of Object.entries(character)) {
      parts.push(`${key}=${encodeURIComponent(file)}`)
    }
  }
  return parts.join('&')
}

function hudStyle() {
  const saved = readSettings().hudStyle
  return Object.hasOwn(HUD_STYLES, saved) ? saved : DEFAULT_HUD_STYLE
}
/** Clear of the screen edge, and of a menu bar the work area already excludes. */
const HUD_MARGIN = 16

/**
 * Where the badge sits when nothing has been saved.
 *
 * A corner, because Electron's default is the middle of the screen and the
 * middle of the screen is where the user is working. Top right: it is where
 * this kind of readout lives on both platforms, and it is the corner least
 * likely to be under something — a Dock or a taskbar sits at the bottom by
 * default, and the work area only accounts for one that is actually there.
 *
 * @param {{x: number, y: number, width: number, height: number}} workArea
 */
function hudCorner(workArea, size) {
  return {
    x: workArea.x + workArea.width - size.width - HUD_MARGIN,
    y: workArea.y + HUD_MARGIN,
  }
}

function hudOpen() {
  return Boolean(state.hud && !state.hud.isDestroyed())
}

/**
 * What the harness is doing, as far as this shell can honestly say.
 *
 * Every one of these is first-hand: the shell owns the server process, runs
 * the supervision, drives the plugin and skill operations, and performs its
 * own updates. What the agent is doing inside a conversation is deliberately
 * absent — dsh serves no status endpoint (every path under / returns the
 * app's HTML and /api answers 404), the only structured surface is an RPC
 * that needs an attached session, and the alternative of reading the upstream
 * UI's DOM would be a contract that breaks the first time it is restyled.
 * A badge that says less and stays true is worth more than one that guesses.
 *
 * Ordered by specificity: an install running during a restart is the install,
 * because that is the thing a person is waiting on.
 *
 * @returns {{kind: string, detail?: string|number}}
 */
function hudStatus() {
  if (state.update?.phase) return { kind: 'updating' }
  if (state.pluginBusy) return { kind: 'plugin' }
  if (state.skillBusy) return { kind: 'skill' }
  if (state.restartTimer) return { kind: 'restarting', detail: state.restarts }
  if (!state.child) return { kind: 'stopped' }
  // The port is set when the server answers, so before it there is a process
  // that is not yet a service — which is what the loading window is showing.
  if (!state.port) return { kind: 'starting' }
  return { kind: 'ready' }
}

/**
 * CPU tiers for the character state, in the same per-core percent the badge
 * displays and Activity Monitor reports — so one core fully used is 100.
 *
 * Read them as cores: something is happening at a sixth of a core, a core is
 * working at ninety percent of one, and it is genuinely parallel — a build, a
 * plugin install, a runtime download — at two and a half. Expressed this way
 * they mean the same thing on any machine.
 *
 * The earlier 10/35/70 were per-core too, which put all three tiers inside a
 * single core: on the fourteen-core machine this was written on, "hot" meant
 * dsh was using five percent of the computer, and the top tier fired at
 * something a person would call idle.
 *
 * Thread count is displayed but is not a load signal: a runtime can own a
 * dozen sleeping threads and be doing nothing at all.
 */
/**
 * Logical cores, for turning a per-core reading into a share of the machine.
 *
 * `ps` counts one fully used core as 100, so on this fourteen-core machine a
 * parallel build reads 800 and a runaway one could read 1400. That is the
 * right unit for deciding how hard the harness is working and the wrong one
 * to put on a badge: a four-digit percentage is not something anybody reads
 * at a glance, and it does not answer the question people actually ask, which
 * is how much of their computer this is taking.
 */
const CORES = Math.max(1, cpus().length)

const HUD_ACTIVE_PERCENT = 15
const HUD_BUSY_PERCENT = 90
const HUD_HOT_PERCENT = 250

/**
 * Converts first-hand process and shell state into the five states the badge
 * can honestly show. This is runtime load, not a claim that the shell can see
 * an agent's private reasoning or queue.
 */
function hudLoad(running, cpu, status) {
  if (!running || status.kind === 'stopped') return 'stopped'
  if (['plugin', 'skill', 'updating', 'restarting'].includes(status.kind)) return 'busy'
  if (status.kind === 'starting' || cpu === undefined || cpu === null) return 'active'
  if (cpu >= HUD_HOT_PERCENT) return 'hot'
  if (cpu >= HUD_BUSY_PERCENT) return 'busy'
  if (cpu >= HUD_ACTIVE_PERCENT) return 'active'
  return 'idle'
}

/**
 * Reads once and sends the result to the badge.
 *
 * The previous sample is kept here rather than in the window so that closing
 * and reopening does not inherit a rate computed across the gap, which would
 * be an average over a minute the user was not watching.
 */
async function sampleForHud() {
  if (!hudOpen()) return
  const child = state.child
  const reading = child?.pid === undefined
    ? undefined
    : await sampleUsage({ pid: child.pid, pgid: child.pid })
  const previous = state.hudPrevious
  // A reading that arrives too soon after the last one — the extra sample a
  // style change triggers, or a reopen — cannot produce an honest rate, so it
  // does not become the new baseline either. The next tick then measures
  // across the full interval instead of inheriting a truncated one.
  const tooSoon = previous !== undefined && reading !== undefined
    && reading.at - previous.at < MIN_HUD_SAMPLE_MS
  if (!tooSoon) state.hudPrevious = reading
  if (!hudOpen()) return
  // Keeping the last good rate rather than showing nothing: a badge that
  // blanked its own number every time the user changed its shape would look
  // broken by the act of using it.
  const cpu = tooSoon ? state.hudCpu : cpuPercent(previous, reading)
  state.hudCpu = cpu
  // Two units, deliberately. The tiers stay per-core, where a threshold means
  // "about a core" on every machine; the badge shows the share of the whole
  // computer, which is bounded at 100 and is the question a person is asking
  // when they glance at it.
  const share = cpu === undefined ? undefined : cpu / CORES
  const status = hudStatus()
  const load = hudLoad(reading !== undefined, cpu, status)
  state.hud.webContents.send('hud:sample', reading === undefined
    ? { running: false, status, load }
    : {
      running: true,
      cpu: share,
      rssBytes: reading.rssBytes,
      threads: reading.threads,
      processes: reading.processes,
      load,
      // The words stay calm while the pose carries the severity. Busy is a
      // reading, not a durable shell state, and both upper tiers are work.
      status: status.kind === 'ready' && ['busy', 'hot'].includes(load) ? { kind: 'busy' } : status,
    })
}

function openHud() {
  if (hudOpen()) {
    state.hud.show()
    return
  }
  const style = hudStyle()
  const size = HUD_STYLES[style]
  const saved = visibleBounds(readSettings().hudBounds, screen.getAllDisplays().map(d => d.workArea))
  // A saved position that no longer lands on any screen is discarded by
  // visibleBounds, so an unplugged monitor returns the badge to the corner
  // rather than to somewhere it cannot be seen or dragged back from.
  //
  // Only the position is restored, never the size: the size belongs to the
  // layout, and a saved rectangle from another one would show this layout in
  // the last one's footprint.
  const where = saved
    ? { x: saved.x + (saved.width ?? size.width) - size.width, y: saved.y }
    : hudCorner(screen.getPrimaryDisplay().workArea, size)
  const win = new BrowserWindow({
    ...size,
    x: where.x,
    y: where.y,
    // A badge, not a window: no frame to take up half of it, no entry in the
    // task switcher, and above whatever the user is actually working in —
    // which is the only position from which it is worth anything.
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { preload: path.join(here, 'hud-preload.cjs') },
  })
  // Above the app's own windows, and on every desktop.
  //
  // 'floating' rather than a level that outranks every other application:
  // the badge belongs to this app and comes forward with it, so pinning it
  // over whatever else the user is doing would be answering a question they
  // did not ask. What made it look like it "fell behind" was not the level
  // but that nothing brought it forward again — see raiseHud().
  win.setAlwaysOnTop(true, 'floating')
  // Deliberately without `visibleOnFullScreen`. It is the only way to float
  // over another application's full-screen space, and macOS grants that by
  // moving the *application* to the accessory activation policy — which is
  // defined as not appearing in the Dock or the app switcher. The whole app
  // vanishes from both, and closing the badge does not bring it back.
  //
  // Measured rather than reasoned: the Dock icon survives the window flags
  // and survives setAlwaysOnTop at every level, and goes at exactly this
  // call — plain `setVisibleOnAllWorkspaces(true)` leaves it alone. Following
  // the user across spaces is kept because it costs nothing; covering someone
  // else's full-screen window is given up, because a badge is not worth
  // making the application it belongs to unreachable.
  win.setVisibleOnAllWorkspaces(true)
  if (process.platform !== 'darwin') win.removeMenu()
  win.loadFile(path.join(assets, 'hud.html'), { search: hudSearch(style) })

  const remember = () => {
    if (!win.isDestroyed()) writeSettings({ hudBounds: win.getBounds() })
  }
  win.on('moved', remember)
  win.on('closed', () => {
    state.hud = undefined
    state.hudPrevious = undefined
    state.hudCpu = undefined
    clearInterval(state.hudTimer)
    state.hudTimer = undefined
    buildMenu()
    refreshTrayMenu()
  })
  state.hud = win
  state.hudPrevious = undefined
  // One reading immediately so the badge is not blank while it waits, and
  // then on the interval; the first shows memory, the second a rate.
  sampleForHud().catch(() => {})
  state.hudTimer = setInterval(() => { sampleForHud().catch(() => {}) }, HUD_INTERVAL_MS)
  buildMenu()
  refreshTrayMenu()
}

/**
 * Brings the badge forward with the application.
 *
 * An always-on-top window is above the windows that were there when it was
 * created; it is not a promise that macOS will keep it in front through a
 * space switch, another app going full-screen, or the app being hidden and
 * activated again. Nothing was putting it back, which is what "it falls
 * behind" was describing. Re-asserting the level and moving it to the top of
 * its own app's stack is cheap, so it happens on every activation rather than
 * on a guess about which ones matter.
 */
function raiseHud() {
  if (!hudOpen()) return
  state.hud.setAlwaysOnTop(true, 'floating')
  state.hud.setVisibleOnAllWorkspaces(true)
  // showInactive rather than show: bringing the badge forward must not take
  // the keyboard away from the window the user just clicked into.
  if (!state.hud.isVisible()) state.hud.showInactive()
  state.hud.moveTop()
}

/**
 * Adopts an image as the badge's character.
 *
 * Copied rather than referenced: the file the user picked is in their
 * Downloads or on a volume that will be unplugged, and a badge that lost its
 * face when either happened would be a bug reported as "it broke by itself".
 */
async function pickHudCharacter() {
  const { canceled, filePaths } = await dialog.showOpenDialog(state.hud ?? state.window, {
    title: t('menu.hudCharacter'),
    filters: [{ name: 'Image', extensions: ['png', 'gif', 'webp', 'jpg', 'jpeg', 'svg', 'apng'] }],
    properties: ['openFile'],
  })
  const source = canceled ? undefined : filePaths?.[0]
  if (source === undefined) return
  await mkdir(paths.hudDir, { recursive: true })
  const target = path.join(paths.hudDir, `character${path.extname(source).toLowerCase()}`)
  // One at a time: the old picture goes, so switching does not leave the data
  // directory collecting every image ever tried.
  for (const stale of await readdir(paths.hudDir).catch(() => [])) {
    if (stale !== path.basename(target)) await rm(path.join(paths.hudDir, stale), { force: true }).catch(() => {})
  }
  await copyFile(source, target)
  writeSettings({ hudCharacter: path.basename(target) })
  reopenHud()
}

function clearHudCharacter() {
  writeSettings({ hudCharacter: '' })
  reopenHud()
}

/** Reloads the badge in place so a new picture or style is on screen at once. */
function reopenHud() {
  if (hudOpen()) setHudStyle(hudStyle())
  buildMenu()
  refreshTrayMenu()
}

function closeHud() {
  if (hudOpen()) state.hud.close()
}

/**
 * Switches layout, in place when the badge is on screen.
 *
 * The right edge stays where it was rather than the left. The badge lives in
 * a corner — the top right by default — and a narrower layout that kept its
 * left edge would drift away from that corner every time it shrank.
 *
 * @param {keyof HUD_STYLES} style
 */
function setHudStyle(style) {
  if (!Object.hasOwn(HUD_STYLES, style)) return
  writeSettings({ hudStyle: style })
  if (hudOpen()) {
    const size = HUD_STYLES[style]
    const bounds = state.hud.getBounds()
    state.hud.setBounds({ x: bounds.x + bounds.width - size.width, y: bounds.y, ...size })
    writeSettings({ hudBounds: state.hud.getBounds() })
    state.hud.loadFile(path.join(assets, 'hud.html'), { search: hudSearch(style) })
    // The reload throws away the rendered numbers; the reading behind them is
    // still current, so send it again rather than showing dashes until the
    // next tick comes round.
    state.hud.webContents.once('did-finish-load', () => { sampleForHud().catch(() => {}) })
  }
  buildMenu()
  refreshTrayMenu()
}

function toggleHud() {
  const open = hudOpen()
  if (open) closeHud()
  else openHud()
  // Remembered so it comes back with the app: a badge somebody chose to have
  // on screen is a preference, not a one-off.
  writeSettings({ hudVisible: !open })
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
 * The things this app can put a screen in front of the agent.
 *
 * A browser and a mini program simulator are the same kind of thing from
 * here: something with a screen, opened and closed, that the agent drives
 * through the same socket and the user watches. They were two loose items
 * beside Settings until there were two of them, at which point the grouping
 * is what says they are alternatives rather than unrelated features — and it
 * is where a phone goes when there is one.
 *
 * The accelerator stays on the browser inside the submenu. A keystroke does
 * not care how deeply its item is nested, and moving the browser one level
 * down should not cost anyone the shortcut they already use.
 */
function deviceItems() {
  return [
    {
      label: `${state.panel ? '\u2713' : '\u2007\u2007'} ${t('menu.browser')}`,
      accelerator: 'CommandOrControl+B',
      click: toggleBrowserPanel,
    },
    {
      label: `${state.miniapp?.isOpen() ? '\u2713' : '\u2007\u2007'} ${t('menu.miniapp')}`,
      click: () => { toggleSimulator().catch(error => errorDialog(t('menu.miniapp'), error)) },
    },
    state.phoneInstalling
      ? { label: t('menu.phoneInstalling'), enabled: false }
      : {
        label: `${state.phone?.isOpen() ? '\u2713' : '\u2007\u2007'} ${t('menu.phone')}`,
        click: () => { togglePhone().catch(error => errorDialog(t('menu.phone'), error)) },
      },
    { type: 'separator' },
    {
      label: t('menu.locations'),
      submenu: [
        {
          label: t('menu.locationDevtools'),
          click: () => { chooseDevToolsPath().catch(error => errorDialog(t('menu.locations'), error)) },
        },
        {
          label: t('menu.locationAndroid'),
          click: () => { chooseAndroidSdk().catch(error => errorDialog(t('menu.locations'), error)) },
        },
      ],
    },
  ]
}

/**
 * Everything that is not plugins. Plugins are a menu of their own in the
 * menu bar; the tray has no menu bar, so it nests the same items instead.
 */
function actionItems() {
  return [
    { label: t('menu.devices'), submenu: deviceItems() },
    { type: 'separator' },
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
          label: t('menu.hud'),
          submenu: [
            {
              label: `${hudOpen() ? '\u2713' : '\u2007\u2007'} ${t('menu.hudShow')}`,
              click: toggleHud,
            },
            { type: 'separator' },
            ...Object.keys(HUD_STYLES).map(style => ({
              label: `${hudStyle() === style ? '\u2713' : '\u2007\u2007'} ${t(`hud.style.${style}`)}`,
              click: () => setHudStyle(style),
            })),
            { type: 'separator' },
            { label: t('menu.hudCharacter'), click: () => { pickHudCharacter().catch(e => errorDialog(t('menu.hudCharacter'), e)) } },
            ...(hudCharacter() ? [{ label: t('menu.hudCharacterClear'), click: clearHudCharacter }] : []),
          ],
        },
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
        {
          label: `${readSettings().browserTools !== false ? '\u2713' : '\u2007\u2007'} ${t('menu.browserTools')}`,
          click: () => {
            writeSettings({ browserTools: readSettings().browserTools === false })
            // Written into the user's dsh home, which dsh watches: the tools
            // appear or disappear without restarting anything.
            registerTools(path.join(paths.binDir, process.platform === 'win32' ? 'dsh-browser-mcp.cmd' : 'dsh-browser-mcp'))
              .catch(error => log(`browser tools: ${error?.message ?? error}`))
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
    // An app update staged from a source run is a bundle boot.js will refuse
    // to start, so the dialog would promise a restart that changes nothing —
    // and hand the installed app a new shell on the way past. The runtime
    // update below stays: that one lands in the data directory and is exactly
    // what a source run is usually here to exercise.
    sourceLaunch
      ? { label: t('menu.appUpdateSource'), enabled: false }
      : state.update
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
    // Spelled out rather than `role: 'windowMenu'`, whose contents the system
    // fills in and which therefore cannot be checked from here. Close is the
    // item that matters: without it there is no Cmd+W, and a window offering
    // nothing but the title-bar button is one people report as unclosable.
    {
      label: t('menu.window'),
      submenu: [
        { role: 'close', label: t('menu.closeWindow') },
        { role: 'minimize', label: t('menu.minimize') },
      ],
    },
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
    tray.setToolTip(t('tray.tooltip', { app: BRAND.name, version: state.runtime?.version ?? '' }))
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
  // Only for `npm run start:electron`, which lives inside the unbranded
  // Electron.app under node_modules. The icon is the half that can be fixed at
  // runtime; the Dock's tooltip stays "Electron" because it comes from that
  // bundle, which is what the branded development app exists to solve.
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
  registerUiStateIpc()
  ipcMain.on('hud:close', () => closeHud())
  // The badge measures what it rendered and asks for the room to show it.
  // The right edge is held so a wider badge grows leftwards, away from the
  // screen edge it is docked against rather than off it.
  ipcMain.on('hud:resize', (_event, width) => {
    if (!hudOpen()) return
    const base = HUD_STYLES[hudStyle()]?.width ?? 232
    const wanted = Math.round(Number(width))
    if (!Number.isFinite(wanted)) return
    const next = Math.min(Math.max(wanted, base), base + HUD_MAX_GROWTH)
    const bounds = state.hud.getBounds()
    if (Math.abs(bounds.width - next) < 4) return
    state.hud.setBounds({ x: bounds.x + bounds.width - next, y: bounds.y, width: next, height: bounds.height })
    writeSettings({ hudBounds: state.hud.getBounds() })
  })
  registerSettingsIpc()
  registerFileHandoff()
  registerPreviewIpc()
  // Before the first child is spawned and before anything is fetched: the
  // runtime install on a first launch is exactly the thing a user behind a
  // proxy needs this for.
  await applyProxy(proxySetting()).catch(error => log(`could not apply the proxy setting: ${error?.message ?? error}`))
  const settings = readSettings()
  const bounds = savedBounds()
  // A BaseWindow rather than a BrowserWindow: the window holds views side by
  // side — the dsh UI, and the panel a previewed page opens in — and a
  // BrowserWindow's own web contents always fills it, leaving nowhere for the
  // second one to go. The UI is a view like any other from here on.
  const window = new BaseWindow({
    width: 1280,
    height: 840,
    ...bounds,
    title: BRAND.name,
    // Starting hidden means starting in the tray: the server comes up, the
    // window is built and loaded, and nothing appears until it is asked for.
    show: !settings.startHidden,
  })
  const chat = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Files dropped on the window, the view state the origin would lose,
      // and the one call the page may make into the shell.
      preload: path.join(here, 'chat-preload.cjs'),
    },
  })
  window.contentView.addChildView(chat)
  state.window = window
  state.chat = chat
  layoutWindow()
  window.on('resize', layoutWindow)
  if (settings.windowMaximized) window.maximize()
  rememberBounds(window)
  // On every load, not once: the UI is reloaded when the server restarts and
  // when the user asks for it, and each reload is a fresh page with an
  // unwrapped `fetch`. Cheap enough to repeat — the script installs nothing
  // the second time.
  chat.webContents.on('did-finish-load', () => {
    chat.webContents.executeJavaScript(interceptScript(), true)
      // Only the surprising answer is logged. `false` means the page had no
      // bridge to install against — the UI's file chips will be going to the
      // system browser, and this line is the difference between diagnosing
      // that and guessing at it.
      .then(installed => { if (!installed) log('preview interception: not installed') })
      .catch(error => log(`preview interception: ${error?.message ?? error}`))
  })
  // Close hides; the server keeps running until the app itself quits.
  window.on('close', event => {
    if (state.quitting) return
    event.preventDefault()
    window.hide()
  })
  await loadChat(path.join(assets, 'loading.html'))
  try {
    // Packaged builds prefer the app-bundled Node; the system search is the
    // dev-mode path and the fallback for a missing/corrupt bundle.
    state.toolchain = (!sourceLaunch
      ? ensureBundledToolchain({
        tarPath: path.join(process.resourcesPath, 'node-runtime.tgz'),
        versionFile: path.join(process.resourcesPath, 'node-runtime.version'),
        destBase: app.getPath('userData'),
        log,
      })
      : undefined) ?? findToolchain()
    log(`toolchain: ${state.toolchain.nodeBin}`)
    // Before the server: its environment carries the socket address, and a
    // bridge started afterwards would reach a child that never heard of it.
    state.childEnv = await startOpenBridge()
    state.runtime = await ensureRuntime({
      baseDir: paths.runtimeBase,
      toolchain: state.toolchain,
      // Packaged builds carry a runtime snapshot in Resources/runtime-seed.tar,
      // so first launch deploys offline instead of downloading from npm.
      seedTar: !sourceLaunch ? path.join(process.resourcesPath, 'runtime-seed.tar') : undefined,
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
  if (!sourceLaunch) {
    setTimeout(() => { updateApp({ silent: true }).catch(error => log(`silent update check: ${error?.message ?? error}`)) }, 30_000)
  }

  // The badge comes back if it was on screen when the app last closed. After
  // the window, not with it: it reads the server, and until the server is up
  // there is nothing for it to say.
  if (readSettings().hudVisible === true) openHud()
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
  // For a source run it is worse than invisible. The instance being handed to
  // wears the same name, the same icon and the same data directory, so the
  // developer is left reading the installed build as though it were the code
  // they just changed. Written to stderr, which is where `npm start` is
  // looking, and with a failing exit code, because nothing they asked for ran.
  if (sourceLaunch) {
    process.stderr.write(`\n${BRAND.name} is already running — the installed build, or another source run.\n`
      + `It owns ${locations.dataDir}; this launch exited without starting anything.\n`
      + 'Quit that instance first, then run npm start again.\n\n')
    app.exit(1)
  } else app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  // And when a window is reached without going through showWindow — clicked
  // directly, or switched to with the keyboard. Focusing the badge itself is
  // not a reason to reorder anything.
  app.on('browser-window-focus', (_event, window) => {
    if (window !== state.hud) raiseHud()
  })
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
    // Before anything waits on the server: the badge samples it, and an
    // always-on-top window outliving the app it reports on looks like a crash.
    clearInterval(state.hudTimer)
    state.hudTimer = undefined
    if (hudOpen()) state.hud.destroy()
    // Closing the socket unlinks it, so the next launch does not have to
    // decide whether a leftover address belongs to a live app or a dead one.
    state.openBridge?.close()
    state.openBridge = undefined
    // Nothing is awaited: a DevTools this app started is asked to quit, and
    // one it merely borrowed is left exactly as it was found.
    state.miniapp?.dispose()
    state.miniapp = undefined
    state.phone?.dispose()
    state.phone = undefined
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
