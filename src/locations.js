/**
 * Where the app keeps its data and its log.
 *
 * The data directory is relocatable, which creates a bootstrap problem: the
 * setting cannot live inside the directory it points at. A small pointer file
 * therefore stays at the DEFAULT location for good and names the real one.
 *
 * Imports nothing from Electron so it can be exercised under plain Node; the
 * caller supplies the platform's app-data directory.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Directory name under the platform's app-data root. */
export const DATA_DIR = 'dsh-desktop'
/** Data directory name used before the project was renamed. */
export const LEGACY_DATA_DIR = 'dsh-shell'
/** Names the relocated directories; always read from the default location. */
export const POINTER_FILE = 'location.json'

/**
 * Resolves where data and logs actually live.
 *
 * Every failure prefers a directory that exists over one that does not: a
 * pointer naming a directory that has gone away falls back to the default
 * rather than leaving the app with nowhere to write, and a failed migration
 * keeps using the old directory rather than starting empty beside it. Losing
 * sight of an installed runtime and a user's sessions is the worst outcome
 * available here, so nothing is allowed to cause it silently.
 *
 * @param {string} appData the platform's app-data root
 * @returns {{ dataDir: string, logDir: string, defaultDir: string,
 *   pointerFile: string, migrated?: string, notes: string[] }}
 */
export function resolveLocations(appData) {
  const notes = []
  const defaultDir = path.join(appData, DATA_DIR)
  const legacy = path.join(appData, LEGACY_DATA_DIR)
  let migrated

  if (existsSync(legacy)) {
    if (existsSync(defaultDir)) {
      // Both present: a half-finished move, or a restored backup. Neither is
      // ours to merge, so take the current name and say where the other is.
      notes.push(`legacy data directory left in place at ${legacy}`)
    } else {
      try {
        renameSync(legacy, defaultDir)
        migrated = legacy
      } catch (error) {
        notes.push(`could not migrate ${legacy}: ${error?.message ?? error}`)
        return { dataDir: legacy, logDir: legacy, defaultDir, pointerFile: path.join(legacy, POINTER_FILE), notes }
      }
    }
  }

  const pointerFile = path.join(defaultDir, POINTER_FILE)
  const pointer = readPointer(pointerFile)

  let dataDir = defaultDir
  if (pointer.dataDir && pointer.dataDir !== defaultDir) {
    if (existsSync(pointer.dataDir)) dataDir = pointer.dataDir
    else notes.push(`configured data directory is missing, using the default: ${pointer.dataDir}`)
  }

  let logDir = dataDir
  if (pointer.logDir && pointer.logDir !== dataDir) {
    if (existsSync(pointer.logDir)) logDir = pointer.logDir
    else notes.push(`configured log directory is missing, using the data directory: ${pointer.logDir}`)
  }

  return { dataDir, logDir, defaultDir, pointerFile, migrated, notes }
}

/** @param {string} pointerFile @returns {{dataDir?: string, logDir?: string}} */
function readPointer(pointerFile) {
  try {
    const raw = JSON.parse(readFileSync(pointerFile, 'utf8'))
    return {
      dataDir: typeof raw.dataDir === 'string' ? raw.dataDir : undefined,
      logDir: typeof raw.logDir === 'string' ? raw.logDir : undefined,
    }
  } catch {
    // Missing or corrupt: the defaults are always a valid answer.
    return {}
  }
}

/**
 * Records a relocation. Writes to the default location, never to the
 * directory being pointed at — that one may be about to change.
 *
 * @param {string} pointerFile from {@link resolveLocations}
 * @param {{ dataDir?: string|null, logDir?: string|null }} patch null clears an entry
 */
export function saveLocations(pointerFile, patch) {
  const current = readPointer(pointerFile)
  const next = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (typeof value === 'string') next[key] = value
  }
  mkdirSync(path.dirname(pointerFile), { recursive: true })
  writeFileSync(pointerFile, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
