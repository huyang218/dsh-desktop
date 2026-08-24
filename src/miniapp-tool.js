/**
 * Finding the WeChat DevTools installation, and asking whether it will talk.
 *
 * The simulator this app integrates is not ours and cannot ship inside it:
 * the DevTools licence forbids redistribution, so the only honest arrangement
 * is to find the copy the user installed and drive that one. Discovery is
 * therefore a feature rather than a detail — everything built on top of it is
 * unavailable until this file answers, and "not installed" and "installed
 * somewhere we did not look" reach the user as the same silence.
 *
 * Three things have to be located, and they are not the same thing:
 *
 *   - the **install directory**, which holds the `cli` this shell spawns;
 *   - the **user directory**, where the IDE writes its port files;
 *   - the **service port**, which exists only while the IDE is running, and
 *     only when the user has switched the service port on. It is off by
 *     default, and that switch is the single most likely reason this feature
 *     will fail on a machine where everything is installed correctly.
 *
 * The second is derived from the first through a hash the DevTools computes
 * over its own install path — the fragile step, and the reason
 * {@link userDirFor} does not trust its own arithmetic.
 *
 * Nothing here launches the IDE. Launching goes through the DevTools' own
 * `cli`, which is the interface its authors support; this file only says
 * where that `cli` is and whether talking to it is worth attempting.
 *
 * Electron-free, so it can be exercised under plain Node.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import net from 'node:net'
import { homedir } from 'node:os'
import path from 'node:path'

const isWindows = process.platform === 'win32'

/**
 * The product's own name for itself.
 *
 * A DATA FORMAT, not branding: this exact string is the directory the
 * DevTools creates under the platform's app-data root, taken from its
 * `package.nw/package.json` `name`. Translating it, or tidying it into
 * something Latin, would send us looking for a directory nobody creates.
 */
export const PRODUCT_NAME = '微信开发者工具'

/**
 * Names an installation this file would not have guessed.
 *
 * Every candidate list below is a claim about where somebody installs their
 * software, and every such claim is eventually wrong. This is the escape
 * hatch that keeps being wrong from being fatal: it accepts the `.app`
 * bundle, the directory beside `cli`, or anything in between.
 */
export const INSTALL_ENV = 'DSH_WECHAT_DEVTOOLS'

/** What the IDE writes into `.ide-status` while the service port is on. */
const SERVICE_ON = 'On'

/**
 * @typedef {object} DevTools
 * @property {string} installPath directory holding the `cli`
 * @property {string} cliPath the command every later feature spawns
 * @property {string} version e.g. `2.01.2510260`
 * @property {string} [userDir] where the port files live, when it exists yet
 */

/**
 * Locates the installed DevTools, or nothing.
 *
 * Ordered by confidence rather than by cost: the override first because a
 * user who set it has already told us the answer, then the default install
 * locations, then the platform's own index of installed software — which is
 * the slow one, and the only one that finds an installation somewhere nobody
 * anticipated.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.home]
 * @returns {DevTools | undefined}
 */
export function findDevTools({ env = process.env, home = homedir() } = {}) {
  const seen = new Set()
  for (const candidate of candidateInstalls({ env, home })) {
    const installPath = path.resolve(candidate)
    if (seen.has(installPath)) continue
    seen.add(installPath)
    const found = describeInstall(installPath, { env, home })
    if (found) return found
  }
  return undefined
}

/**
 * Confirms one candidate directory really is an installation, and reads what
 * it is.
 *
 * The `cli` alone is not proof — the name is generic enough to belong to
 * something else entirely — so the package manifest has to agree that this is
 * the product we are looking for. Its `name` is the same string the IDE uses
 * to name its own data directory, which is what makes it a usable check
 * rather than a guess.
 *
 * @param {string} installPath
 * @param {{env: Record<string, string | undefined>, home: string}} context
 * @returns {DevTools | undefined}
 */
function describeInstall(installPath, { env, home }) {
  const cliPath = path.join(installPath, isWindows ? 'cli.bat' : 'cli')
  if (!existsSync(cliPath)) return undefined
  // Mirrors the DevTools' own `installPkgPath`: macOS keeps the package
  // beside the executables under Resources, Windows one level down in code/.
  const manifest = isWindows
    ? path.join(installPath, 'code', 'package.nw', 'package.json')
    : path.join(installPath, '..', 'Resources', 'package.nw', 'package.json')
  let pkg
  try {
    pkg = JSON.parse(readFileSync(manifest, 'utf8'))
  } catch {
    return undefined
  }
  if (pkg?.name !== PRODUCT_NAME) return undefined
  return {
    installPath,
    cliPath,
    version: typeof pkg.version === 'string' ? pkg.version : '',
    userDir: userDirFor(installPath, { env, home }),
  }
}

/**
 * Where the DevTools might be, best guess first.
 *
 * @param {{env: Record<string, string | undefined>, home: string}} context
 * @returns {Generator<string>}
 */
function* candidateInstalls({ env, home }) {
  const override = env[INSTALL_ENV]?.trim()
  if (override) yield normalizeInstall(override)
  if (isWindows) {
    // The installer's folder still carries the product's previous name on
    // machines that upgraded rather than reinstalled, so both are offered.
    const names = ['微信web开发者工具', PRODUCT_NAME]
    const bases = [
      env['ProgramFiles(x86)'],
      env.ProgramFiles,
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'),
    ].filter(Boolean)
    for (const base of bases) {
      for (const name of names) {
        yield path.join(base, 'Tencent', name)
        yield path.join(base, name)
      }
    }
    yield* registryInstalls()
    return
  }
  yield path.join('/Applications', 'wechatwebdevtools.app', 'Contents', 'MacOS')
  yield path.join(home, 'Applications', 'wechatwebdevtools.app', 'Contents', 'MacOS')
  yield* spotlightInstalls()
}

/**
 * Accepts whichever end of the installation the user pointed at.
 *
 * Somebody setting {@link INSTALL_ENV} by hand is as likely to paste the path
 * Finder shows them — the `.app` — as the directory this file actually wants,
 * and refusing the more natural of the two would make the escape hatch
 * something else to get wrong.
 *
 * @param {string} target @returns {string}
 */
function normalizeInstall(target) {
  const trimmed = target.replace(/[/\\]+$/, '')
  if (isWindows) return trimmed
  if (trimmed.endsWith('.app')) return path.join(trimmed, 'Contents', 'MacOS')
  if (existsSync(path.join(trimmed, 'Contents', 'MacOS'))) return path.join(trimmed, 'Contents', 'MacOS')
  return trimmed
}

/**
 * Installations macOS itself knows about.
 *
 * Spotlight indexes bundle identifiers, so this finds a DevTools the user
 * dragged somewhere unusual without us having to enumerate the places people
 * drag things to. It is allowed to fail — indexing can be switched off, and a
 * machine without it is exactly the machine {@link INSTALL_ENV} is for.
 *
 * @returns {string[]}
 */
function spotlightInstalls() {
  try {
    const out = execFileSync('mdfind', ["kMDItemCFBundleIdentifier == 'com.tencent.webplusdevtools'"], {
      encoding: 'utf8',
      timeout: 8_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').map(line => line.trim()).filter(Boolean)
      .map(app => path.join(app, 'Contents', 'MacOS'))
  } catch {
    return []
  }
}

/**
 * Installations Windows recorded when the DevTools was installed.
 *
 * Through PowerShell rather than `reg`, for one reason: every value this has
 * to match or return contains Chinese, and `reg` hands it back in whatever
 * code page the console happens to be using. Forcing UTF-8 output makes the
 * answer readable on a machine whose console is GBK, which is most of them.
 *
 * Best-effort throughout. A missing key, a locked-down execution policy and a
 * machine with no PowerShell all mean the same thing here — that the default
 * locations above were the only answer available.
 *
 * @returns {string[]}
 */
function registryInstalls() {
  const roots = [
    'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ].map(key => `'${key}\\*'`).join(',')
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `Get-ItemProperty ${roots} -ErrorAction SilentlyContinue`,
    "| Where-Object { $_.DisplayName -like '*开发者工具*' -and $_.InstallLocation }",
    '| ForEach-Object { $_.InstallLocation }',
  ].join(' ')
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').map(line => line.trim().replace(/[/\\]+$/, '')).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The directory the IDE writes its port files into.
 *
 * The DevTools names this directory after a hash of its own install path, so
 * two installations never share state. Which would make this pure arithmetic,
 * except that the two copies of that arithmetic inside the DevTools disagree:
 * the launcher beside the app hashes the install path alone, while the code
 * it starts hashes the install path concatenated with a version string. On
 * this machine both produce the same directory, because that version string
 * is empty — but "the two implementations happen to agree today" is not
 * something to build a feature on.
 *
 * So the hash is treated as a strong hint rather than an answer: compute it,
 * use it when the directory is really there, and otherwise look at what
 * directories exist. Enumeration is what stays correct when the formula
 * changes; the hash is what stays correct when the user has several
 * installations and only one of them is ours.
 *
 * @param {string} installPath
 * @param {{env?: Record<string, string | undefined>, home?: string}} [context]
 * @returns {string | undefined} the `Default` directory, when one exists
 */
export function userDirFor(installPath, { env = process.env, home = homedir() } = {}) {
  const root = isWindows
    ? path.join(
      env.LOCALAPPDATA ?? path.join(env.USERPROFILE ?? home, 'AppData', 'Local'),
      PRODUCT_NAME,
      'User Data',
    )
    : path.join(home, 'Library', 'Application Support', PRODUCT_NAME)

  const computed = path.join(root, createHash('md5').update(installPath).digest('hex'), 'Default')
  if (existsSync(computed)) return computed

  // Whatever the formula turned out to be, the IDE still had to create the
  // directory. Most recently written first: on a machine with a stale
  // directory from an installation that has since been replaced, the one
  // being used is the one that was used last.
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return undefined
  }
  const existing = entries
    .map(name => path.join(root, name, 'Default'))
    .filter(dir => existsSync(dir))
    .map(dir => ({ dir, at: modifiedAt(dir) }))
    .sort((a, b) => b.at - a.at)
  return existing[0]?.dir
}

/** @param {string} target @returns {number} */
function modifiedAt(target) {
  try {
    return statSync(target).mtimeMs
  } catch {
    return 0
  }
}

/**
 * @typedef {object} Service
 * @property {boolean | undefined} enabled whether the service port is switched
 *   on; `undefined` when the IDE has never written the file, which is not the
 *   same as `false` and must not be reported as it
 * @property {number | undefined} port the IDE's HTTP port, as last written
 */

/**
 * Reads what the IDE last said about its service port.
 *
 * Two files, written by the IDE and read here exactly as its own `cli` reads
 * them: `.ide-status` holds the literal `On` while the service port is
 * switched on, and `.ide` holds the port. Neither is a liveness signal — both
 * survive a crash — so a port read here is somewhere to knock, not a running
 * IDE.
 *
 * @param {string | undefined} userDir from {@link userDirFor}
 * @returns {Service}
 */
export function readService(userDir) {
  if (!userDir) return { enabled: undefined, port: undefined }
  const status = readTrimmed(path.join(userDir, '.ide-status'))
  const port = Number.parseInt(readTrimmed(path.join(userDir, '.ide')) ?? '', 10)
  return {
    enabled: status === undefined ? undefined : status === SERVICE_ON,
    port: Number.isInteger(port) && port > 0 ? port : undefined,
  }
}

/** @param {string} file @returns {string | undefined} */
function readTrimmed(file) {
  try {
    return readFileSync(file, 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * Whether anything is listening on a port of this machine.
 *
 * @param {number} port
 * @param {number} [timeout]
 * @returns {Promise<boolean>}
 */
export function reachable(port, timeout = 1_500) {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    const settle = answer => {
      socket.destroy()
      resolve(answer)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

/**
 * @typedef {object} Inspection
 * @property {'missing'|'disabled'|'stopped'|'ready'} state
 * @property {DevTools} [tool]
 * @property {Service} [service]
 */

/**
 * The one question everything above this file asks: can we drive a simulator
 * right now, and if not, whose problem is it to fix?
 *
 * Four answers, because collapsing them loses the only thing the user can act
 * on:
 *
 *   - `missing`  — nothing installed. Ours to explain, theirs to install.
 *   - `disabled` — installed, service port switched off. Theirs to switch on,
 *     and the one case worth a pointed instruction rather than an error.
 *   - `stopped`  — installed and willing, simply not running. Ours to start.
 *   - `ready`    — running and answering.
 *
 * A DevTools that has never been opened has written no status file, and that
 * is reported as `stopped` rather than `disabled`. The distinction matters:
 * telling somebody to switch on a setting they have never seen, in an
 * application they have never opened, is worse than saying nothing — so we
 * try to start it instead, and let the attempt produce the real answer. The
 * `service.enabled` field stays `undefined` to say the question is open.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.home]
 * @returns {Promise<Inspection>}
 */
export async function inspectDevTools({ env = process.env, home = homedir() } = {}) {
  const tool = findDevTools({ env, home })
  if (!tool) return { state: 'missing' }
  const service = readService(tool.userDir)
  if (service.enabled === false) return { state: 'disabled', tool, service }
  if (service.port !== undefined && await reachable(service.port)) {
    return { state: 'ready', tool, service }
  }
  return { state: 'stopped', tool, service }
}
