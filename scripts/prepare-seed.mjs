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
 */
import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPointer, slotDir, installedVersion, DSH_PACKAGE } from '../src/runtime.js'

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
// Mirrors the userData pin in src/main.js; macOS-only, like the dist target.
const runtimeBase = path.join(homedir(), 'Library', 'Application Support', 'dsh-shell', 'runtime')

const pointer = await readPointer(runtimeBase)
if (!pointer) {
  console.error(`No active local dsh runtime under ${runtimeBase}.`)
  console.error('Launch the app once (it installs the runtime) before packaging.')
  process.exit(1)
}
const source = slotDir(runtimeBase, pointer.slot)
if (!existsSync(path.join(source, 'node_modules', DSH_PACKAGE, 'package.json'))) {
  console.error(`Active slot ${source} is incomplete; reinstall before packaging.`)
  process.exit(1)
}

const seedTar = path.join(projectRoot, 'seed.tar')
rmSync(seedTar, { force: true })
execFileSync('/usr/bin/tar', ['-cf', seedTar, '-C', source, '.'])
console.log(`seeded ${DSH_PACKAGE}@${await installedVersion(source)} from ${pointer.slot} into seed.tar`)
