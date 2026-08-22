/**
 * Packaging step: snapshots the currently active local dsh runtime into
 * `seed.tar`, which electron-builder bundles into the app as
 * `Resources/runtime-seed.tar`. First launch then extracts the seed instead
 * of downloading from npm, so a fresh install boots offline and instantly.
 *
 * A tar archive rather than a directory because electron-builder's
 * extraResources copier silently skips `node_modules` directories.
 *
 * Run the app (or let it install) at least once locally so an active slot
 * exists before packaging.
 *
 * `--bootstrap` (or DSH_SEED_BOOTSTRAP=1, which survives the npm pre-hooks)
 * installs the runtime first when there is none. That is for build machines:
 * CI has never launched the app, so it has nothing to snapshot. The env var
 * exists so a CI job can run the very same `npm run dist:*` a person runs,
 * rather than a special-cased command that then goes untested locally.
 */
import { execFileSync } from 'node:child_process'
import { BRAND } from '../src/brand.js'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureRuntime, readPointer, slotDir, installedVersion, DSH_PACKAGE } from '../src/runtime.js'
import { findToolchain } from '../src/toolchain.js'

/** Electron's `app.getPath('appData')`, resolved without booting Electron. */
function appDataDir() {
  if (process.platform === 'win32') {
    return process.env.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming')
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support')
  }
  return process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config')
}

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// Mirrors the userData resolution in src/main.js. The pre-rename directory is
// still read when the app has not been launched since the rename, so packaging
// works before the migration has run.
const appSupport = appDataDir()
// This brand's own directory first, then the original's. What is being
// snapshotted is a dsh install — an npm tree — and which application's data
// directory it happens to sit in says nothing about its contents. Without the
// fallback, the first build of a new brand fails on a machine that has run
// the app a hundred times, merely under another name.
const runtimeBase = [...new Set([BRAND.dataDir, BRAND.legacyDataDir, 'dsh-desktop', 'dsh-shell'].filter(Boolean))]
  .map(dir => path.join(appSupport, dir, 'runtime'))
  .find(dir => existsSync(dir)) ?? path.join(appSupport, BRAND.dataDir, 'runtime')

const bootstrap = process.argv.includes('--bootstrap') || process.env.DSH_SEED_BOOTSTRAP === '1'
const isComplete = dir => existsSync(path.join(dir, 'node_modules', DSH_PACKAGE, 'package.json'))

let pointer = await readPointer(runtimeBase)
if (bootstrap && (!pointer || !isComplete(slotDir(runtimeBase, pointer.slot)))) {
  // The same installer the app runs on first launch, minus Electron:
  // src/runtime.js imports none of it, which is what makes this possible.
  const runtime = await ensureRuntime({ baseDir: runtimeBase, toolchain: findToolchain(), log: console.log })
  pointer = { slot: runtime.slot, version: runtime.version }
}
if (!pointer) {
  console.error(`No active local dsh runtime under ${runtimeBase}.`)
  console.error('Launch the app once (it installs the runtime) before packaging,')
  console.error('or pass --bootstrap to install one now (what CI does).')
  process.exit(1)
}
const source = slotDir(runtimeBase, pointer.slot)
if (!isComplete(source)) {
  console.error(`Active slot ${source} is incomplete; reinstall before packaging.`)
  process.exit(1)
}

const seedTar = path.join(projectRoot, 'seed.tar')
rmSync(seedTar, { force: true })
execFileSync('tar', ['-cf', seedTar, '-C', source, '.'])
console.log(`seeded ${DSH_PACKAGE}@${await installedVersion(source)} from ${pointer.slot} into seed.tar`)
