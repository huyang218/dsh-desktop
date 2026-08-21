/**
 * Locates a usable Node.js toolchain on the user's machine.
 *
 * The shell runs under Electron, whose bundled Node cannot be assumed to
 * satisfy dsh's engines range, and GUI-launched apps on macOS do not inherit
 * the user's shell PATH. So we resolve a real `node` binary once and reuse it
 * for every spawn (npm runs as `node <npm-cli.js>` so it needs no separate
 * lookup).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { t } from './i18n.js'

const MIN_MAJOR = 22

const isWindows = process.platform === 'win32'

/** Node's executable name on this platform. */
export const NODE_BIN = isWindows ? 'node.exe' : 'node'

/**
 * npm's package tree, relative to the directory holding the Node binary.
 * Windows keeps node.exe at the install root with npm beside it; POSIX puts
 * the binary in bin/ and npm under lib/.
 */
const NPM_TREE_FROM_BIN_DIR = isWindows
  ? ['node_modules', 'npm']
  : ['..', 'lib', 'node_modules', 'npm']

/**
 * Removes the copies that are not the wanted version, and shrugs when it
 * cannot. A previous version's node.exe may still be running — Windows will
 * refuse, and refusing is fine: the only cost is disk, and the alternative
 * is failing a launch over a directory nobody needs.
 */
function discardOtherRuntimes(base, wanted, log) {
  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name === wanted) continue
    try {
      rmSync(path.join(base, entry.name), { recursive: true, force: true })
      log?.(`removed the superseded Node runtime ${entry.name}`)
    } catch { /* in use, or someone else's; disk is the only cost */ }
  }
}

/** Directories searched for the Node binary in addition to the inherited PATH. */
function candidateDirs() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
  if (isWindows) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) dirs.push(path.join(base, 'nodejs'))
    }
    // nvm-windows symlinks the active version and keeps the rest beside it;
    // search both so a machine without nodejs on PATH still resolves.
    for (const base of [process.env.NVM_SYMLINK, process.env.NVM_HOME]) {
      if (!base || !existsSync(base)) continue
      dirs.push(base)
      for (const entry of readdirSync(base).sort().reverse()) {
        dirs.push(path.join(base, entry))
      }
    }
    return dirs
  }
  // What the user's shell would resolve first, then the usual places.
  dirs.push(...loginShellDirs())
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  dirs.push(...nvmBinDirs())
  return dirs
}

function nodeMajor(nodeBin) {
  try {
    const out = execFileSync(nodeBin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    const major = Number.parseInt(out.replace(/^v/, ''), 10)
    return Number.isInteger(major) ? major : 0
  } catch {
    return 0
  }
}

/**
 * Finds a Node.js >= 22 binary and the npm CLI script installed beside it.
 *
 * @returns {{ nodeBin: string, nodeDir: string, npmCli: string }}
 * @throws {Error} when no suitable Node installation exists.
 */
export function findToolchain() {
  for (const dir of candidateDirs()) {
    const nodeBin = path.join(dir, NODE_BIN)
    if (!existsSync(nodeBin)) continue
    if (nodeMajor(nodeBin) < MIN_MAJOR) continue
    // npm ships beside node as a script; run it as `node npm-cli.js` so it
    // works regardless of shebang/PATH (and of Windows having no shebangs).
    const npmCandidates = [
      path.join(dir, ...NPM_TREE_FROM_BIN_DIR, 'bin', 'npm-cli.js'),
      path.join(dir, 'npm'),
    ]
    for (const npmCli of npmCandidates) {
      if (existsSync(npmCli)) return { nodeBin, nodeDir: dir, npmCli }
    }
  }
  throw new Error(t('error.noNode', { major: MIN_MAJOR }))
}

/**
 * Deploys and returns the app-bundled Node toolchain, or undefined when the
 * bundle is absent or incomplete (callers then fall back to the system
 * search). Extraction into `<destBase>/node-runtime` happens once per bundled
 * version: a VERSION marker written by the packaging step keys re-extraction
 * after an app update ships a newer Node.
 *
 * @param {object} options
 * @param {string} options.tarPath bundled `node-runtime.tgz` inside app resources
 * @param {string} options.versionFile bundled `node-runtime.version` beside it
 * @param {string} options.destBase directory owning the extracted runtime
 * @param {(line: string) => void} [options.log]
 * @returns {{ nodeBin: string, nodeDir: string, npmCli: string } | undefined}
 */
export function ensureBundledToolchain({ tarPath, versionFile, destBase, log }) {
  if (!existsSync(tarPath) || !existsSync(versionFile)) return undefined
  const wanted = readFileSync(versionFile, 'utf8').trim()
  // One directory per version, never a single one emptied and refilled.
  // Windows refuses to delete a running executable, and node.exe in here is
  // exactly what the dsh server runs — so an update that arrived while an
  // older server was still alive used to fail with EPERM and take the whole
  // launch down. A new version is now written beside the old one, which
  // needs nothing deleted at all.
  const base = path.join(destBase, 'node-runtime')
  const dest = path.join(base, wanted)
  const marker = path.join(dest, 'VERSION')
  const current = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined
  if (current !== wanted) {
    try {
      log?.(`deploying bundled Node runtime ${wanted} …`)
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dest, { recursive: true })
      // `tar` by name, not /usr/bin/tar: Windows 10 1803+ ships bsdtar as
      // System32\tar.exe, which handles this archive identically.
      execFileSync('tar', ['-xzf', tarPath, '-C', dest])
    } catch (error) {
      // Not fatal on its own: the caller falls back to a Node found on the
      // machine, which is a far better answer than an app that will not open.
      log?.(`could not deploy the bundled Node runtime: ${error?.message ?? error}`)
      return undefined
    }
  }
  discardOtherRuntimes(base, wanted, log)
  // The staged layout mirrors the platform's own Node install, so the same
  // relative lookups work here as in findToolchain().
  const nodeDir = isWindows ? dest : path.join(dest, 'bin')
  const nodeBin = path.join(nodeDir, NODE_BIN)
  const npmCli = path.join(nodeDir, ...NPM_TREE_FROM_BIN_DIR, 'bin', 'npm-cli.js')
  if (!existsSync(nodeBin) || !existsSync(npmCli)) return undefined
  return { nodeBin, nodeDir, npmCli }
}

/**
 * Environment for spawned children: inherits the current env with the chosen
 * Node's directory prepended to PATH so tools that re-invoke `node` resolve
 * the same installation.
 *
 * @param {{ nodeDir: string }} toolchain resolved by {@link findToolchain}
 * @param {Record<string, string>} [extra] additional variables to set
 * @returns {Record<string, string | undefined>}
 */
export function childEnv(toolchain, extra = {}) {
  return {
    ...process.env,
    PATH: [toolchain.nodeDir, process.env.PATH ?? '', ...loginShellDirs(), ...globalBinDirs()]
      .filter(Boolean)
      .join(path.delimiter),
    ...extra,
  }
}

const PATH_START = '__dsh_path_start__'
const PATH_END = '__dsh_path_end__'

/** @type {string[] | undefined} the answer, asked for at most once */
let shellDirs

/**
 * The PATH the user's own shell would hand a program.
 *
 * Every list of likely directories is a guess about how someone installed
 * their tools, and this machine answers with `.bun/bin`, `.cargo/bin`,
 * `/usr/local/opt/node@22/bin` and four more that no such list would have
 * contained. The shell already knows: it is where the user put those
 * directories, and asking it costs one launch, about half a second, once per
 * run.
 *
 * Login *and* interactive, because PATH is set in `.zshrc` at least as often
 * as in `.zprofile`. That runs the user's startup files, which is exactly
 * what a terminal does; the sentinels are there because those files may print
 * things, and the timeout because one of them may block forever.
 *
 * @returns {string[]} the directories, or none when the shell cannot be asked
 */
function loginShellDirs() {
  if (shellDirs) return shellDirs
  shellDirs = []
  if (isWindows) return shellDirs
  // Windows has no equivalent problem to solve: PATH there lives in the
  // registry, and a GUI app is handed the same one a console gets.
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  // Braced, because `$PATH__dsh_path_end__` names a variable nobody set and
  // expands to nothing at all.
  const script = `echo "${PATH_START}\${PATH}${PATH_END}"`
  // spawnSync rather than execFileSync: an interactive shell may hand back a
  // nonzero status from the last thing a startup file did, and the answer is
  // on stdout either way.
  const { stdout } = spawnSync(shell, ['-ilc', script], {
    encoding: 'utf8',
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const found = (stdout ?? '').match(new RegExp(`${PATH_START}(.*)${PATH_END}`))
  // Split on the delimiter alone: a directory here may well have a space in
  // it, this being macOS.
  if (found) shellDirs = found[1].split(path.delimiter).filter(Boolean)
  return shellDirs
}

/**
 * Where package managers install their global executables.
 *
 * `dsh plugin` forwards to pnpm and looks it up on PATH — but a GUI app does
 * not inherit the user's shell PATH. macOS launchd hands out
 * `/usr/bin:/bin:/usr/sbin:/sbin`, so a pnpm under ~/.local/bin or Homebrew is
 * invisible to a double-clicked app while working perfectly from a terminal;
 * on Windows the npm and pnpm shims live under the user's AppData. These are
 * appended, never prepended, so nothing here can shadow the user's own PATH.
 *
 * pnpm is no longer the only tool this has to find. dsh can delegate to the
 * Claude Code and Codex CLIs, which it expects on PATH and does not probe for,
 * so a missing directory is now a feature that fails with nothing to look at.
 *
 * {@link loginShellDirs} answers that better than any list of likely places
 * can, and this is what remains when it cannot be asked: the shell may be an
 * exotic one, or Windows, or a machine where startup files hang. Nothing here
 * is a version number or an install path we invented — each entry is a
 * documented location a tool puts itself in, read from the tool's own
 * environment variable when it has one.
 *
 * @returns {string[]} the candidate directories that exist
 */
function globalBinDirs() {
  const home = homedir()
  const candidates = process.platform === 'win32'
    ? [
      process.env.PNPM_HOME,
      process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'pnpm'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
      // nvm-windows keeps the selected version behind this symlink, which is
      // usually the ProgramFiles path above but is the user's to move.
      process.env.NVM_SYMLINK,
      process.env.APPDATA && path.join(process.env.APPDATA, 'fnm', 'aliases', 'default', 'bin'),
    ]
    : [
      process.env.PNPM_HOME,
      path.join(home, '.local', 'bin'),
      path.join(home, 'Library', 'pnpm'),
      path.join(home, '.volta', 'bin'),
      // asdf and fnm both keep one stable directory that always points at the
      // active version, so neither needs the enumeration nvm does below. Each
      // says where it lives; the defaults are only for when it has not been
      // asked to live somewhere else.
      path.join(process.env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'shims'),
      ...[
        process.env.FNM_DIR,
        path.join(home, 'Library', 'Application Support', 'fnm'),
        path.join(home, '.local', 'share', 'fnm'),
      ].filter(Boolean).map(dir => path.join(dir, 'aliases', 'default', 'bin')),
      ...nvmBinDirs(),
      '/opt/homebrew/bin',
      '/usr/local/bin',
    ]
  return [...new Set(candidates.filter(Boolean))].filter(dir => existsSync(dir))
}

/**
 * nvm's per-version bin directories, the default version first.
 *
 * nvm is a shell function rather than a directory, so it leaves nothing on
 * PATH for a GUI app to inherit: every global CLI installed under it is
 * invisible to a double-clicked app while working perfectly in a terminal.
 * There is no single directory to add either, because each Node version has
 * its own — and a tool the user installed once lives under exactly one of
 * them.
 *
 * So all of them are offered, ordered so the version the user's own shell
 * would pick answers first: `nvm alias default` when it names something
 * installed, then the rest newest-first. They are appended like the others,
 * so an older version here can never shadow the user's own PATH.
 *
 * @returns {string[]} bin directories, which the caller filters for existence
 */
function nvmBinDirs() {
  const root = process.env.NVM_DIR || path.join(homedir(), '.nvm')
  const versionsDir = path.join(root, 'versions', 'node')
  let versions
  try {
    versions = readdirSync(versionsDir).filter(name => /^v\d/.test(name))
  } catch {
    return []
  }
  versions.sort((a, b) => {
    const [left, right] = [a, b].map(v => v.slice(1).split('.').map(Number))
    for (let i = 0; i < 3; i++) {
      if ((right[i] ?? 0) !== (left[i] ?? 0)) return (right[i] ?? 0) - (left[i] ?? 0)
    }
    return 0
  })
  const preferred = nvmDefault(root, versions)
  const ordered = preferred ? [preferred, ...versions.filter(v => v !== preferred)] : versions
  return ordered.map(version => path.join(versionsDir, version, 'bin'))
}

/**
 * The installed version `nvm alias default` names, if it names one plainly.
 *
 * The alias file holds whatever the user aliased: `24`, `v24.13.0`, `lts/jod`,
 * `node`. Only the forms that point straight at an installed version are
 * resolved — the rest fall through to newest-first, which is what an
 * unresolvable alias would most likely have meant anyway.
 *
 * @param {string} root nvm's directory
 * @param {string[]} versions installed versions, newest first
 * @returns {string | undefined}
 */
function nvmDefault(root, versions) {
  let wanted
  try {
    wanted = readFileSync(path.join(root, 'alias', 'default'), 'utf8').trim()
  } catch {
    return undefined
  }
  if (!/^v?\d/.test(wanted)) return undefined
  const prefix = wanted.startsWith('v') ? wanted : `v${wanted}`
  return versions.find(version => version === prefix || version.startsWith(`${prefix}.`))
}
