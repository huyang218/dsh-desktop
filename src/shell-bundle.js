/**
 * Where hot-updated copies of the shell live, and which one boots.
 *
 * A shell update is just JavaScript and markup: the window, the plugin
 * manager, the market, every rule in this directory. None of it needs the
 * app bundle in /Applications to change — and leaving that bundle alone is
 * the whole point. macOS binds privacy permissions to an app's code
 * signature, so replacing the installed app revokes what the user granted
 * (see permission.js); an update that never touches the bundle keeps the
 * signature, the permissions, and Gatekeeper's opinion exactly as they were.
 *
 * So a downloaded shell is unpacked into the data directory and booted from
 * there, with the packaged copy as the floor:
 *
 *   <data>/shell/current.json   { version, confirmed, attempts }
 *   <data>/shell/0.1.2/         src/, assets/, shell.json
 *
 * The rollback rule is the same one the dsh runtime slots use, adapted to
 * code that boots the app rather than code the app spawns: a bundle that has
 * not yet proven it can start gets a bounded number of attempts, and the
 * packaged copy takes over when they run out. Nothing here can leave the app
 * unable to start — every failure path resolves to the code that shipped.
 *
 * Deliberately synchronous and Electron-free: it runs before anything else.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Directory under the data directory that holds downloaded shells. */
export const SHELL_DIR = 'shell'
/** Manifest a bundle must carry, written by the build that produced it. */
export const MANIFEST = 'shell.json'
const POINTER = 'current.json'

/**
 * Boots a not-yet-confirmed bundle at most this many times. Two, because the
 * first failure may be a coincidence (a machine going to sleep mid-launch)
 * and the second is a pattern.
 */
export const MAX_ATTEMPTS = 2

/** @param {string} dataDir @returns {string} */
export function shellDirOf(dataDir) {
  return path.join(dataDir, SHELL_DIR)
}

export function bundleDir(shellDir, version) {
  return path.join(shellDir, version)
}

/** The entry module of a staged bundle: the same main.js the package ships. */
export function bundleEntry(shellDir, version) {
  return path.join(bundleDir(shellDir, version), 'src', 'main.js')
}

/** @returns {{version: string, confirmed?: boolean, attempts?: number} | undefined} */
export function readPointer(shellDir) {
  try {
    const raw = JSON.parse(readFileSync(path.join(shellDir, POINTER), 'utf8'))
    return typeof raw?.version === 'string' ? raw : undefined
  } catch {
    return undefined
  }
}

export function writePointer(shellDir, pointer) {
  mkdirSync(shellDir, { recursive: true })
  writeFileSync(path.join(shellDir, POINTER), `${JSON.stringify(pointer, null, 2)}\n`)
}

/** @returns {{version: string, electron: string} | undefined} */
export function readManifest(dir) {
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, MANIFEST), 'utf8'))
    return typeof raw?.version === 'string' && typeof raw?.electron === 'string' ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a bundle can run on this Electron.
 *
 * Major version only: the shell talks to Electron's own API surface, which
 * is what a major bump breaks. A bundle built against a different major is
 * not a hot update at all — it needs the packaged app to change, which is a
 * full reinstall.
 */
export function isCompatible(manifest, electronVersion) {
  return Number(String(manifest?.electron).split('.')[0]) === Number(String(electronVersion).split('.')[0])
}

/**
 * Picks the shell to boot, and records the attempt.
 *
 * Called before anything else runs, so it validates rather than assumes: a
 * pointer to a directory that is gone, a bundle without a manifest, a
 * manifest for another Electron, or one that has used up its attempts all
 * resolve to "boot what shipped".
 *
 * @param {string} shellDir
 * @param {{electronVersion: string, log?: (line: string) => void}} options
 * @returns {{version: string, dir: string, entry: string} | undefined}
 *   undefined means: run the packaged shell
 */
export function selectBundle(shellDir, { electronVersion, log }) {
  const pointer = readPointer(shellDir)
  if (!pointer) return undefined
  const dir = bundleDir(shellDir, pointer.version)
  const entry = bundleEntry(shellDir, pointer.version)
  const manifest = readManifest(dir)

  const reject = reason => {
    log?.(`shell ${pointer.version}: ${reason}; falling back to the packaged shell`)
    discard(shellDir, pointer.version)
    return undefined
  }
  if (!existsSync(entry)) return reject('no entry module')
  if (!manifest) return reject(`no readable ${MANIFEST}`)
  if (manifest.version !== pointer.version) return reject('manifest names a different version')
  if (!isCompatible(manifest, electronVersion)) {
    return reject(`built for Electron ${manifest.electron}, running ${electronVersion}`)
  }

  if (!pointer.confirmed) {
    const attempts = (pointer.attempts ?? 0) + 1
    if (attempts > MAX_ATTEMPTS) return reject(`failed to start ${MAX_ATTEMPTS} times`)
    // Written BEFORE the bundle runs: a boot that never returns still counts.
    writePointer(shellDir, { ...pointer, attempts })
    log?.(`shell ${pointer.version}: attempt ${attempts} of ${MAX_ATTEMPTS} (unconfirmed)`)
  }
  return { version: pointer.version, dir, entry }
}

/** Marks the active bundle as one that starts, ending the attempt budget. */
export function confirmBundle(shellDir, version) {
  const pointer = readPointer(shellDir)
  if (!pointer || pointer.version !== version || pointer.confirmed) return false
  writePointer(shellDir, { version, confirmed: true, attempts: 0 })
  return true
}

/** Drops a bundle and the pointer to it. The packaged shell boots next time. */
export function discard(shellDir, version) {
  rmSync(path.join(shellDir, POINTER), { force: true })
  rmSync(bundleDir(shellDir, version), { recursive: true, force: true })
}

/**
 * Makes a freshly unpacked directory the bundle to boot next launch.
 * The staging directory is renamed into place, so a half-written download is
 * never pointed at.
 */
export function activate(shellDir, version, stagingDir) {
  const dir = bundleDir(shellDir, version)
  rmSync(dir, { recursive: true, force: true })
  renameSync(stagingDir, dir)
  writePointer(shellDir, { version, confirmed: false, attempts: 0 })
  return dir
}
