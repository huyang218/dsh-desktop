/**
 * Locates a usable Node.js toolchain on the user's machine.
 *
 * The shell runs under Electron, whose bundled Node cannot be assumed to
 * satisfy dsh's engines range, and GUI-launched apps on macOS do not inherit
 * the user's shell PATH. So we resolve a real `node` binary once and reuse it
 * for every spawn (npm runs as `node <npm-cli.js>` so it needs no separate
 * lookup).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

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
  dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin')
  const nvmVersions = path.join(homedir(), '.nvm', 'versions', 'node')
  if (existsSync(nvmVersions)) {
    // Highest version first so we prefer the newest installed Node.
    const versions = readdirSync(nvmVersions).sort().reverse()
    for (const v of versions) dirs.push(path.join(nvmVersions, v, 'bin'))
  }
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
  throw new Error(
    `未找到 Node.js >= ${MIN_MAJOR}。请安装 Node.js(https://nodejs.org)后重新启动本应用。`,
  )
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
  const dest = path.join(destBase, 'node-runtime')
  const marker = path.join(dest, 'VERSION')
  const current = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined
  if (current !== wanted) {
    log?.(`部署内置 Node 运行时 ${wanted} …`)
    rmSync(dest, { recursive: true, force: true })
    mkdirSync(dest, { recursive: true })
    // `tar` by name, not /usr/bin/tar: Windows 10 1803+ ships bsdtar as
    // System32\tar.exe, which handles this archive identically.
    execFileSync('tar', ['-xzf', tarPath, '-C', dest])
  }
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
    PATH: `${toolchain.nodeDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ...extra,
  }
}
