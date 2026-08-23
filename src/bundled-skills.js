/**
 * The skills that ship with the application.
 *
 * dsh scans a "bundled" skill root named by `DSH_BUNDLED_SKILL_DIR` — a root
 * for skills that come with a deployment rather than with a user. That is
 * exactly what a skill describing this app's own browser is, so the shell
 * fills that root in and points the server at it.
 *
 * Copied out of the application rather than pointed at in place. In a
 * packaged build `assets/` lives inside `app.asar`, which Electron's own fs
 * can read and the plain Node running the dsh server cannot; a path into the
 * archive would be a skill that works from source and vanishes when packaged.
 *
 * Rewritten on every launch, never merged: these files belong to the app the
 * way the menu bar does. A user who wants to change one copies it into their
 * own skills directory, where it also takes precedence.
 *
 * Electron-free — but note that the *caller* must be Electron for an asar
 * source to be readable at all.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Deploys the shipped skills into a directory the dsh server can read.
 *
 * @param {object} options
 * @param {string} options.sourceDir where the skills ship (inside the app)
 * @param {string} options.destDir where to write them
 * @returns {string} destDir, for `DSH_BUNDLED_SKILL_DIR`
 */
export function deployBundledSkills({ sourceDir, destDir }) {
  // Emptied first, so a skill withdrawn in an update stops being offered
  // rather than lingering as a file nothing rewrites.
  rmSync(destDir, { recursive: true, force: true })
  copyTree(sourceDir, destDir)
  return destDir
}

/**
 * A recursive copy written by hand.
 *
 * `cpSync` would be shorter and does not reliably read an asar source; these
 * three calls do, because Electron patches exactly them.
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) copyTree(source, target)
    else writeFileSync(target, readFileSync(source))
  }
}
