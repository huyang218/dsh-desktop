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

/** Directories searched for `node` in addition to the inherited PATH. */
function candidateDirs() {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)
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
    const nodeBin = path.join(dir, 'node')
    if (!existsSync(nodeBin)) continue
    if (nodeMajor(nodeBin) < MIN_MAJOR) continue
    // npm ships beside node as a script; run it as `node npm-cli.js` so it
    // works regardless of shebang/PATH.
    const npmCandidates = [
      path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
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
    execFileSync('/usr/bin/tar', ['-xzf', tarPath, '-C', dest])
  }
  const nodeBin = path.join(dest, 'bin', 'node')
  const npmCli = path.join(dest, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (!existsSync(nodeBin) || !existsSync(npmCli)) return undefined
  return { nodeBin, nodeDir: path.join(dest, 'bin'), npmCli }
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
