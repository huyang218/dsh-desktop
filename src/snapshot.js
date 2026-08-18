/**
 * Snapshots of the data directory: the sessions, profiles and settings.
 *
 * Everything else this app manages already has a way back. The runtime keeps
 * the previous version in the other slot, the shell keeps the packaged copy
 * behind a hot update, a plugin can be switched off, a config value can be
 * cleared. The one thing with no way back is what the user actually made:
 * the conversations. This is that way back.
 *
 * The whole of DSH_HOME goes in, `node_modules` included. It is the bulkiest
 * part and the only reinstallable one, but leaving it out would make a
 * restore a two-step operation ending in a network install — exactly what
 * someone restoring a backup is least able to rely on. pnpm is configured
 * `hoisted` in these profiles, so the tree is real directories rather than a
 * symlink farm, and it travels.
 *
 * tar does the work, as it already does for the runtime seed: it ships with
 * macOS and with Windows 10 1803 and later, which this app requires anyway.
 *
 * Deliberately free of Electron imports.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { t } from './i18n.js'

/** Entries a directory must have to be treated as a data directory. */
const MARKERS = ['profiles', 'sessions', 'settings.yaml', 'cordis.patch.yml']

/**
 * Writes a snapshot of `dshHome` to `file`.
 *
 * @param {{dshHome: string, file: string, log?: (line: string) => void}} options
 * @returns {Promise<{file: string, bytes: number}>}
 */
export async function createSnapshot({ dshHome, file, log }) {
  await mkdir(path.dirname(file), { recursive: true })
  await rm(file, { force: true })
  // `-C <dir> .` keeps the archive rooted at the directory's contents rather
  // than at an absolute path, so a restore is not tied to where it came from.
  await runTar(['-czf', file, '-C', dshHome, '.'], log)
  const { size } = await stat(file)
  log?.(`snapshot: ${file} (${Math.round(size / 1024 / 1024)} MB)`)
  return { file, bytes: size }
}

/**
 * Restores a snapshot, keeping the directory it replaces.
 *
 * Never extracted over the live directory: an archive is unpacked into a
 * fresh one, checked for the things a data directory has, and only then
 * swapped in — so a truncated download or somebody's holiday photos cannot
 * half-replace a session history. The directory being replaced is renamed
 * aside rather than deleted, because "restore" is exactly when the user is
 * least sure they picked the right file.
 *
 * The caller must have stopped the server first: this moves the directory
 * out from under it.
 *
 * @param {{dshHome: string, file: string, log?: (line: string) => void}} options
 * @returns {Promise<{backup: string}>} where the replaced directory now is
 */
export async function restoreSnapshot({ dshHome, file, log }) {
  const staging = `${dshHome}.restore-${Date.now()}`
  const backup = `${dshHome}.backup-${Date.now()}`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    await runTar(['-xzf', file, '-C', staging], log)
    const entries = await readdir(staging)
    if (!MARKERS.some(marker => entries.includes(marker))) {
      throw new Error(t('error.snapshotNotData'))
    }
    if (existsSync(dshHome)) await rename(dshHome, backup)
    await rename(staging, dshHome)
    log?.(`snapshot restored from ${file}; previous data directory kept at ${backup}`)
    return { backup }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * What an archive claims to hold, without unpacking it.
 *
 * Reading the table of contents is cheap and answers the only question worth
 * asking before a restore: is this a snapshot of a data directory at all.
 *
 * @returns {Promise<{looksRight: boolean, entries: number}>}
 */
export async function inspectSnapshot({ file, log }) {
  const listing = await runTar(['-tzf', file], log)
  const names = listing.split('\n').map(line => line.replace(/^\.\//, '').replace(/\/.*$/, '')).filter(Boolean)
  return { looksRight: MARKERS.some(marker => names.includes(marker)), entries: new Set(names).size }
}

/** Runs tar, resolving with its stdout. */
function runTar(args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { err = (err + chunk).slice(-2000) })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) return resolve(out)
      log?.(`tar ${args[0]} failed: ${err.trim()}`)
      reject(new Error(t('error.snapshotTar', { code, tail: err.trim().slice(-300) })))
    })
  })
}
