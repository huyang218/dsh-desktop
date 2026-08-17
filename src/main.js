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
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnv, ensureBundledToolchain, findToolchain } from './toolchain.js'
import { getLocale, LOCALES, messages, resolveLocale, setLocale, t } from './i18n.js'
import { getPluginConfigValues, probePluginConfig, setPluginConfig } from './plugin-config.js'
import {
  activateSlot, DSH_PACKAGE, dshBinPath, ensureRuntime, inactiveSlot,
  installIntoSlot, readPointer, slotDir,
} from './runtime.js'
import { getFreePort, startServer, stopServer, waitHealthy } from './server.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const assets = path.join(here, '..', 'assets')

const DATA_DIR = 'dsh-desktop'
/** Data directory name used before the project was renamed. */
const LEGACY_DATA_DIR = 'dsh-shell'

/**
 * Resolves the data directory, moving the pre-rename one across on first run.
 *
 * The directory holds the installed dsh runtime, sessions, and settings — a
 * rename that leaves them behind silently resets the user to a fresh install,
 * so every failure here prefers the OLD directory over starting empty beside
 * it. Runs before the single-instance lock, which is keyed on this path.
 *
 * @returns {{ dir: string, migrated?: string, note?: string }}
 */
function resolveUserData() {
  const appData = app.getPath('appData')
  const target = path.join(appData, DATA_DIR)
  const legacy = path.join(appData, LEGACY_DATA_DIR)
  if (!existsSync(legacy)) return { dir: target }
  if (existsSync(target)) {
    // Both present: a half-finished move, or a restored backup. Neither is
    // ours to merge, so take the current name and say so in the log.
    return { dir: target, note: `legacy data directory left in place at ${legacy}` }
  }
  try {
    renameSync(legacy, target)
    return { dir: target, migrated: legacy }
  } catch (error) {
    // A cross-volume or permission failure must not cost the user their
    // runtime and sessions: keep using the directory that actually has them.
    return { dir: legacy, note: `could not migrate ${legacy}: ${error?.message ?? error}` }
  }
}

const dataLocation = resolveUserData()
app.setPath('userData', dataLocation.dir)

/**
 * @type {{
 *   child?: import('node:child_process').ChildProcess, port?: number,
 *   window?: BrowserWindow, tray?: Tray, runtime?: { slot: string, dir: string, version: string },
 *   toolchain?: ReturnType<typeof findToolchain>, quitting: boolean,
 *   restarts: number, restartTimer?: NodeJS.Timeout,
 * }}
 */
const state = { quitting: false, restarts: 0 }

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
  // A migrated directory keeps its old dsh-shell.log beside this one; that
  // history is the user's, so it is left alone rather than renamed or removed.
  paths.logFile = path.join(userData, 'dsh-desktop.log')
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
    state.tray.destroy()
    state.tray = undefined
    createTray()
  }
  if (state.pluginsWindow && !state.pluginsWindow.isDestroyed()) {
    state.pluginsWindow.reload()
  }
  if (state.window && !state.window.isDestroyed() && !state.port) {
    // Still on the loading page: reload it so its two strings switch too.
    state.window.loadFile(path.join(assets, 'loading.html'), { search: `lang=${getLocale()}` })
      .catch(() => {})
  }
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`
  try {
    appendFileSync(paths.logFile, stamped)
  } catch { /* logging must never take the shell down */ }
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
  const { response } = await dialog.showMessageBox({
    type: 'error',
    message: t('dialog.startFailed'),
    detail: `${error?.message ?? error}\n\n${t('dialog.startFailedDetail')}`,
    buttons: [t('button.retry'), t('button.quit')],
    defaultId: 0,
    cancelId: 1,
  })
  if (response !== 0) {
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
  dialog.showMessageBox(state.window, {
    type: 'error',
    message: t('dialog.serverExited', { cause: describeExit(code, signal) }),
    detail: `${detail}\n${t('dialog.logPath', { path: paths.logFile })}`,
    buttons: [t('button.restartService'), t('button.ignore')],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) restartServer().catch(e => errorDialog(t('dialog.restartFailed'), e))
  })
}

/** Installs latest into the inactive slot, boot-tests it, then swaps. */
async function updateRuntime() {
  const pointer = await readPointer(paths.runtimeBase)
  const target = inactiveSlot(pointer?.slot)
  const dir = slotDir(paths.runtimeBase, target)
  log(`updating ${DSH_PACKAGE} into ${target} …`)
  const version = await installIntoSlot({ toolchain: state.toolchain, dir, log })
  if (pointer?.version === version) {
    dialog.showMessageBox(state.window, { message: t('dialog.upToDate', { version }) })
    return
  }
  // Boot test in the new slot before committing to it.
  const testPort = await getFreePort()
  const probe = await startServer({
    slotDir: dir, port: testPort, dshHome: paths.dshHome,
    cwd: homedir(), toolchain: state.toolchain, log,
  })
  const ok = await waitHealthy(testPort, { timeoutMs: 90_000 })
  await stopServer(probe)
  if (!ok) throw new Error(`${t('error.selfTestFailed', { version })}${t('dialog.logPath', { path: paths.logFile })}`)
  await activateSlot(paths.runtimeBase, { slot: target, version })
  state.runtime = { slot: target, dir, version }
  log(`activated ${version} in ${target}`)
  const { response } = await dialog.showMessageBox(state.window, {
    message: t('dialog.updated', { version }),
    detail: t('dialog.updatedDetail'),
    buttons: [t('button.restartService'), t('button.later')],
    cancelId: 1,
  })
  if (response === 0) await restartServer()
}

// ── Plugin manager ──────────────────────────────────────────────────────────
// Installs/removes dsh plugins by driving the runtime's own `dsh plugin`
// command against the web profile — the shell never touches harness source.

const PLUGIN_PROFILE = 'web'

function pluginsLog(line) {
  log(`[plugins] ${line}`)
  if (state.pluginsWindow && !state.pluginsWindow.isDestroyed()) {
    state.pluginsWindow.webContents.send('plugins:log', line)
  }
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
      reject(new Error(t('error.pluginExit', { code, tail: tail.slice(-400) })))
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
  const plugins = []
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    let version
    try {
      const pkg = JSON.parse(
        await readFile(path.join(profileDir, 'node_modules', name, 'package.json'), 'utf8'),
      )
      version = pkg.version
    } catch { /* not installed yet: version stays undefined */ }
    plugins.push({ name, spec: String(spec), version, active: bundles.includes(name) })
  }
  return plugins
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

function openPluginManager() {
  if (state.pluginsWindow && !state.pluginsWindow.isDestroyed()) {
    state.pluginsWindow.show()
    state.pluginsWindow.focus()
    return
  }
  const win = new BrowserWindow({
    width: 760,
    height: 640,
    title: t('window.plugins'),
    webPreferences: { preload: path.join(here, 'plugins-preload.cjs') },
  })
  win.loadFile(path.join(assets, 'plugins.html'))
  win.on('closed', () => { state.pluginsWindow = undefined })
  state.pluginsWindow = win
}

function pluginProfileDir() {
  return path.join(paths.dshHome, 'profiles', PLUGIN_PROFILE)
}

function registerPluginIpc() {
  // Synchronous by design: the plugin window's preload needs the strings
  // before the page renders. The payload is a plain object of short strings.
  ipcMain.on('i18n:strings', event => {
    event.returnValue = { locale: getLocale(), messages: messages() }
  })
  ipcMain.handle('plugins:list', () => listPlugins())
  ipcMain.handle('plugins:install', (_event, spec) => withPluginLock(() => runDshPlugin(['add', String(spec)])))
  ipcMain.handle('plugins:remove', (_event, name) => withPluginLock(() => runDshPlugin(['remove', String(name)])))
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

function actionItems() {
  return [
    { label: t('menu.plugins'), click: openPluginManager },
    { label: t('menu.settings'), submenu: [{ label: t('menu.language'), submenu: languageItems() }] },
    { type: 'separator' },
    { label: t('menu.checkUpdate'), click: () => updateRuntime().catch(e => errorDialog(t('dialog.updateFailed'), e)) },
    { label: t('menu.restartService'), click: () => restartServer().catch(e => errorDialog(t('dialog.restartFailed'), e)) },
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
    { label: t('menu.edit'), submenu: editItems() },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
  tray.setToolTip(t('tray.tooltip', { version: state.runtime.version }))
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('menu.showWindow'), click: showWindow },
    { type: 'separator' },
    ...actionItems(),
    { type: 'separator' },
    { label: t('menu.quit'), click: () => app.quit() },
  ]))
  state.tray = tray
}

async function main() {
  initPaths()
  // A saved choice wins; otherwise follow the system language, so a fresh
  // install opens in the user's own rather than in a default.
  setLocale(readSettings().locale ?? resolveLocale(app.getLocale()))
  log('dsh Desktop starting')
  log(`locale: ${getLocale()}`)
  if (dataLocation.migrated) log(`migrated data directory from ${dataLocation.migrated}`)
  if (dataLocation.note) log(dataLocation.note)
  registerPluginIpc()
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    title: 'DeepSeek Harness',
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
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
  } catch (error) {
    // Environment problems (no usable Node, a runtime that will not deploy)
    // are not something another attempt fixes.
    await fatal(t('dialog.startFailed'), error)
    return
  }
  // The environment is ready; past this point a failure is about the server
  // itself, and those are worth another try rather than an app that quits.
  await launchServer().catch(offerLaunchRetry)
}

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
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
