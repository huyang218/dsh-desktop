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
import { appendFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { childEnv, ensureBundledToolchain, findToolchain } from './toolchain.js'
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
  mkdirSync(paths.dshHome, { recursive: true })
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
    detail: `${error?.message ?? error}\n日志:${paths.logFile}`,
    buttons: ['退出'],
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
    message: '启动失败',
    detail: `${error?.message ?? error}\n\n服务可能只是启动较慢(首次安装或磁盘繁忙时)。`,
    buttons: ['重试', '退出'],
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
    throw new Error(`服务在超时时间内未就绪(端口 ${port})。日志:${paths.logFile}`)
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
    await state.window.loadFile(path.join(assets, 'loading.html'))
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
    offerRestart(code, signal, `已连续自动重启 ${MAX_AUTO_RESTARTS} 次仍未稳定。`)
    return
  }
  const attempt = ++state.restarts
  const delayMs = RESTART_BACKOFF_MS[Math.min(attempt, RESTART_BACKOFF_MS.length) - 1]
  log(`auto-restarting in ${delayMs}ms (attempt ${attempt}/${MAX_AUTO_RESTARTS})`)
  if (state.window && !state.window.isDestroyed()) {
    state.window.loadFile(path.join(assets, 'loading.html')).catch(() => {})
  }
  state.restartTimer = setTimeout(() => {
    state.restartTimer = undefined
    if (state.quitting || state.child) return
    launchServer().catch(error => {
      log(`automatic restart failed: ${error?.stack ?? error}`)
      offerRestart(code, signal, `自动重启失败:${error?.message ?? error}`)
    })
  }, delayMs)
}

/** Reports an exit the shell could not recover from, with a retry button. */
function offerRestart(code, signal, detail) {
  dialog.showMessageBox(state.window, {
    type: 'error',
    message: `dsh 服务已退出(${describeExit(code, signal)})`,
    detail: `${detail}\n日志:${paths.logFile}`,
    buttons: ['重启服务', '忽略'],
    defaultId: 0,
    cancelId: 1,
  }).then(({ response }) => {
    if (response === 0) restartServer().catch(e => errorDialog('重启失败', e))
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
    dialog.showMessageBox(state.window, { message: `已是最新版本(${version})。` })
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
  if (!ok) throw new Error(`新版本 ${version} 启动自检失败,保留当前版本。日志:${paths.logFile}`)
  await activateSlot(paths.runtimeBase, { slot: target, version })
  state.runtime = { slot: target, dir, version }
  log(`activated ${version} in ${target}`)
  const { response } = await dialog.showMessageBox(state.window, {
    message: `已更新到 dsh ${version}`,
    detail: '重启服务以使用新版本?未完成的对话会被中断。',
    buttons: ['重启服务', '稍后'],
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
    child.on('exit', code => (code === 0
      ? resolve()
      : reject(new Error(`dsh plugin 退出码 ${code}\n${tail.slice(-400)}`))))
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
  if (state.pluginBusy) throw new Error('另一个插件操作正在进行,请稍候')
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
    title: '插件管理',
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
    log: pluginsLog,
  }))
  ipcMain.handle('plugins:config-get', (_event, name) => getPluginConfigValues(pluginProfileDir(), String(name)))
  ipcMain.handle('plugins:config-set', (_event, name, rowId, values) => withPluginLock(
    () => setPluginConfig(pluginProfileDir(), String(name), String(rowId), values),
  ))
}

/** Shared between the application menu and the tray context menu. */
function actionItems() {
  return [
    { label: '插件管理…', click: openPluginManager },
    { type: 'separator' },
    { label: '检查更新', click: () => updateRuntime().catch(e => errorDialog('更新失败', e)) },
    { label: '重启服务', click: () => restartServer().catch(e => errorDialog('重启失败', e)) },
    { type: 'separator' },
    { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
    { label: '打开日志', click: () => shell.openPath(paths.logFile) },
  ]
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'dsh', submenu: actionItems() },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
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
  tray.setToolTip(`DeepSeek Harness(dsh ${state.runtime.version})`)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: showWindow },
    { type: 'separator' },
    ...actionItems(),
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]))
  state.tray = tray
}

async function main() {
  initPaths()
  log('dsh Desktop starting')
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
  await window.loadFile(path.join(assets, 'loading.html'))
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
    await fatal('启动失败', error)
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
