/**
 * Whether this process is running a developer's source tree.
 *
 * Hot-update selection, the app-bundled Node and runtime seed, and the app
 * update check all behave differently in a source run, and all of them have
 * to give the same answer — so the answer is decided once, here.
 *
 * A plain checkout answers with app.isPackaged. The branded development app
 * that `npm start` builds cannot: it is a real .app bundle, so Electron is
 * right to call it packaged. It is marked instead, by a file that
 * scripts/start-dev.mjs writes beside the source it copies in. The mark
 * travels inside the bundle rather than in an environment variable, because
 * a bundle that only behaves like development when it is started the right
 * way is a trap: double-clicking it in Finder would quietly hunt for a
 * runtime seed that a development build does not carry.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'

/** Written next to src/ in the development bundle by scripts/start-dev.mjs. */
export const DEV_MARKER = '.dsh-dev'

/**
 * @param {{ isPackaged: boolean }} app Electron's app module
 * @param {string} srcDir the directory the running shell's source sits in
 */
export function isSourceLaunch(app, srcDir) {
  if (!app.isPackaged) return true
  if (existsSync(path.join(srcDir, '..', DEV_MARKER))) return true
  // Kept as an override for running the packaged app against source-run
  // behaviour on purpose; it is no longer how `npm start` says so.
  return process.env.DSH_DESKTOP_SOURCE === '1'
}
