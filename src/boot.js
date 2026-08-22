/**
 * The app's entry point: chooses which copy of the shell runs.
 *
 * A hot update is a downloaded shell sitting in the data directory. This file
 * is the only part that cannot be hot-updated, so it does as little as
 * possible: pick a bundle, import it, and fall back to the packaged shell if
 * that import throws. Everything about which bundle is eligible lives in
 * shell-bundle.js, next to the rollback rule it implements.
 *
 * The fallback is what makes the whole scheme safe: a broken download cannot
 * be worse than the version the user installed, because that version is still
 * right here.
 */
import { app } from 'electron'
import path from 'node:path'
import { BRAND } from './brand.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appendFileSync } from 'node:fs'
import { resolveLocations } from './locations.js'
import { confirmBundle, discard, selectBundle, shellDirOf } from './shell-bundle.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const packaged = path.join(here, 'main.js')

// The data directory has to be resolved here rather than taken from the shell
// that has not been chosen yet. main.js resolves it again and gets the same
// answer; the call is idempotent.
const locations = resolveLocations(app.getPath('appData'))
const shellDir = shellDirOf(locations.dataDir)

/**
 * Boot lines go straight to the log file: the logger lives in the shell that
 * is being selected, and a boot problem is exactly when it will not be there.
 */
function log(line) {
  try {
    appendFileSync(path.join(locations.logDir, BRAND.logFile), `[${new Date().toISOString()}] boot: ${line}\n`)
  } catch { /* logging must never take the app down */ }
}

const bundle = selectBundle(shellDir, { electronVersion: process.versions.electron, log })

if (bundle) {
  // Announced rather than passed as an argument, because the shell that reads
  // it is a different copy of the code and may be older or newer than this
  // file. A global it can ignore is the smallest contract that survives that.
  globalThis.__dshShellBundle = { version: bundle.version, dir: bundle.dir }
  try {
    log(`starting shell ${bundle.version} from ${bundle.dir}`)
    await import(pathToFileURL(bundle.entry).href)
    // A bundle that has not confirmed itself within a minute of running is
    // still counted as working: it survived startup, which is what the
    // attempt budget is really asking. The shell confirms sooner when it
    // reaches a window and a healthy server.
    setTimeout(() => {
      if (confirmBundle(shellDir, bundle.version)) log(`shell ${bundle.version} confirmed (survived a minute)`)
    }, 60_000).unref?.()
  } catch (error) {
    log(`shell ${bundle.version} failed to load: ${error?.stack ?? error}`)
    discard(shellDir, bundle.version)
    delete globalThis.__dshShellBundle
    await import(pathToFileURL(packaged).href)
  }
} else {
  await import(pathToFileURL(packaged).href)
}
