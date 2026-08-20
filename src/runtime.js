/**
 * Dual-slot dsh runtime manager.
 *
 * The dsh package is installed by npm into one of two slot directories under
 * the app's data dir. A pointer file names the active slot. Updates install
 * into the inactive slot and only swap the pointer after the new version
 * passes a boot test, so a failed update can never take down a working
 * installation.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { childEnv } from './toolchain.js'
import { t } from './i18n.js'

export const DSH_PACKAGE = '@deepseek-ai/dsh'
const SLOTS = ['slot-a', 'slot-b']

/** @param {string} baseDir runtime base directory (e.g. <userData>/runtime) */
function pointerPath(baseDir) {
  return path.join(baseDir, 'current.json')
}

/**
 * Reads the active-slot pointer.
 *
 * @param {string} baseDir runtime base directory
 * @returns {Promise<{ slot: string, version: string } | undefined>}
 */
export async function readPointer(baseDir) {
  try {
    const raw = JSON.parse(await readFile(pointerPath(baseDir), 'utf8'))
    if (SLOTS.includes(raw.slot) && typeof raw.version === 'string') return raw
  } catch { /* missing or corrupt pointer: treated as "no active slot" */ }
  return undefined
}

/** @param {string} baseDir @param {{ slot: string, version: string }} pointer */
async function writePointer(baseDir, pointer) {
  await writeFile(pointerPath(baseDir), `${JSON.stringify(pointer, null, 2)}\n`)
}

/** Absolute directory of a slot. @param {string} baseDir @param {string} slot */
export function slotDir(baseDir, slot) {
  return path.join(baseDir, slot)
}

/** The slot an update should install into. @param {string | undefined} activeSlot */
export function inactiveSlot(activeSlot) {
  return activeSlot === SLOTS[0] ? SLOTS[1] : SLOTS[0]
}

/**
 * Resolves the installed dsh bin script inside a slot.
 *
 * @param {string} dir slot directory
 * @returns {Promise<string>} absolute path to the CLI entry module
 */
export async function dshBinPath(dir) {
  const pkgDir = path.join(dir, 'node_modules', DSH_PACKAGE)
  const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.dsh
  if (!bin) throw new Error(`${DSH_PACKAGE} declares no dsh bin`)
  return path.join(pkgDir, bin)
}

/** Installed dsh version inside a slot, or undefined. @param {string} dir */
export async function installedVersion(dir) {
  try {
    const pkg = JSON.parse(
      await readFile(path.join(dir, 'node_modules', DSH_PACKAGE, 'package.json'), 'utf8'),
    )
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Installs (or reinstalls) dsh into a slot with npm.
 *
 * @param {object} options
 * @param {{ nodeBin: string, nodeDir: string, npmCli: string }} options.toolchain
 * @param {string} options.dir slot directory, recreated from scratch
 * @param {string} [options.spec] package spec (defaults to `${DSH_PACKAGE}@latest`)
 * @param {(line: string) => void} [options.log] receives npm output lines
 * @returns {Promise<string>} the installed version
 */
export async function installIntoSlot({ toolchain, dir, spec = `${DSH_PACKAGE}@latest`, log }) {
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  await new Promise((resolve, reject) => {
    const child = spawn(
      toolchain.nodeBin,
      [toolchain.npmCli, 'install', spec, '--prefix', dir, '--no-audit', '--no-fund', '--loglevel=error'],
      { env: childEnv(toolchain), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', chunk => log?.(chunk.trimEnd()))
    }
    child.on('error', reject)
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(t('error.npmExit', { code })))))
  })
  const version = await installedVersion(dir)
  if (!version) throw new Error(t('error.npmNoPackage'))
  return version
}

/**
 * The update channels, named by the dist-tags dsh publishes under.
 *
 * `latest` is where a release lands once it is meant for everyone; `next`
 * carries the newest build, which for a package still in `-rc` is often the
 * only place a new version appears for days.
 */
export const CHANNELS = ['latest', 'next']

/** @param {string} channel @returns {string} a channel, whatever came in */
export function normalizeChannel(channel) {
  return CHANNELS.includes(channel) ? channel : CHANNELS[0]
}

/**
 * Asks the registry what a channel currently points at.
 *
 * A metadata query rather than an install: checking for an update should cost
 * one request, not a full download into a slot. The install that may follow
 * pins the exact version this returned, so a release landing in between cannot
 * swap what the user agreed to.
 *
 * All the dist-tags come back in that one request, so the channel is resolved
 * here rather than by asking for `pkg@next` and having npm fail the whole
 * check when that tag does not exist — an empty channel falls back to `latest`
 * and says so.
 *
 * @param {object} options
 * @param {{ nodeBin: string, npmCli: string, nodeDir: string }} options.toolchain
 * @param {string} [options.packageName]
 * @param {string} [options.channel]
 * @returns {Promise<{ version: string, channel: string, tags: Record<string, string> }>}
 *   the version, the channel it actually came from, and every tag the request
 *   returned — the caller can say what the other channel holds without asking
 *   again
 */
export async function channelVersion({ toolchain, packageName = DSH_PACKAGE, channel = CHANNELS[0] }) {
  const wanted = normalizeChannel(channel)
  const raw = await npmOutput(toolchain, ['view', packageName, 'dist-tags', '--json'])
  let tags
  try {
    tags = JSON.parse(raw)
  } catch {
    throw new Error(t('error.npmNoDistTags', { package: packageName }))
  }
  for (const from of [wanted, CHANNELS[0]]) {
    if (typeof tags?.[from] === 'string') return { version: tags[from], channel: from, tags }
  }
  throw new Error(t('error.npmNoDistTags', { package: packageName }))
}

/**
 * Runs npm and returns its stdout, rejecting with whatever it said on stderr.
 *
 * @param {{ nodeBin: string, npmCli: string, nodeDir: string }} toolchain
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function npmOutput(toolchain, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      toolchain.nodeBin,
      [toolchain.npmCli, ...args, '--loglevel=error'],
      { env: childEnv(toolchain), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    )
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-400) })
    child.on('error', reject)
    child.on('exit', code => {
      const trimmed = out.trim()
      if (code === 0 && trimmed) return resolve(trimmed)
      reject(new Error(err.trim() || t('error.npmExit', { code })))
    })
  })
}

/**
 * Ensures an active, usable runtime exists. First run prefers copying the
 * bundled seed (offline, seconds); without a seed it installs from npm.
 * Updates always go through npm regardless of how the first slot was made.
 *
 * @param {object} options
 * @param {string} options.baseDir runtime base directory
 * @param {{ nodeBin: string, nodeDir: string, npmCli: string }} options.toolchain
 * @param {string} [options.seedTar] bundled runtime tar snapshot to extract on first run
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ slot: string, dir: string, version: string }>}
 */
export async function ensureRuntime({ baseDir, toolchain, seedTar, log }) {
  await mkdir(baseDir, { recursive: true })
  const pointer = await readPointer(baseDir)
  if (pointer) {
    const dir = slotDir(baseDir, pointer.slot)
    if (existsSync(path.join(dir, 'node_modules', DSH_PACKAGE, 'package.json'))) {
      return { slot: pointer.slot, dir, version: pointer.version }
    }
  }
  const slot = inactiveSlot(pointer?.slot)
  const dir = slotDir(baseDir, slot)
  let version
  if (seedTar && existsSync(seedTar)) {
    log?.(`deploying bundled runtime seed into ${dir} …`)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await new Promise((resolve, reject) => {
      const child = spawn('tar', ['-xf', seedTar, '-C', dir], { stdio: 'ignore', windowsHide: true })
      child.on('error', reject)
      child.on('exit', code => (code === 0 ? resolve() : reject(new Error(t('error.seedExit', { code })))))
    })
    version = await installedVersion(dir)
    if (!version) throw new Error(t('error.seedIncomplete'))
  } else {
    log?.(`installing ${DSH_PACKAGE} into ${dir} …`)
    version = await installIntoSlot({ toolchain, dir, log })
  }
  await writePointer(baseDir, { slot, version })
  return { slot, dir, version }
}

/**
 * Commits a verified update: points the runtime at the freshly installed slot.
 *
 * @param {string} baseDir runtime base directory
 * @param {{ slot: string, version: string }} pointer the new active slot
 */
export async function activateSlot(baseDir, pointer) {
  await writePointer(baseDir, pointer)
}
