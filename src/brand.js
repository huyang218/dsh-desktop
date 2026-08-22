/**
 * The identity this build ships under.
 *
 * Everything that names the application — the window and Dock name, the
 * bundle identifier, the directory it keeps data in, the log beside it, the
 * repository it takes updates from, the icons the installer carries — comes
 * from one file, so producing a build under someone else's brand is editing
 * that file rather than hunting the name through eight of them.
 *
 * It lives in `assets/` rather than at the project root because the hot
 * update ships `src`, `assets` and `package.json` and nothing else: a brand
 * at the root would stay behind on the first hot update, and the shell that
 * arrived would run from the data directory where a relative path to it no
 * longer resolves. In `assets/` it travels with the code that reads it.
 *
 * Which is also why `updateRepo` is part of a brand and not a constant. A
 * branded build pointing at the original's releases hot-updates itself back
 * into the original's name and icons — a few hundred kilobytes that quietly
 * undo the rebrand. A brand with no repository of its own takes no updates
 * at all, which is the safe reading of "not configured".
 *
 * Deliberately free of Electron imports: the build reads this too, from
 * plain Node, before there is an app.
 */
import { readFileSync } from 'node:fs'

/**
 * @typedef {object} Brand
 * @property {string} name shown in the window, the Dock and the tray
 * @property {string} appId bundle identifier, and the Windows AppUserModelID
 * @property {string} dataDir directory name under the platform's app-data root
 * @property {string} [legacyDataDir] a previous name, migrated on first run
 * @property {string} logFile derived from `dataDir`, so the two never drift
 * @property {string|null} updateRepo `owner/name`, or null for no updates
 * @property {{mac?: string, win?: string}} icons paths from the project root
 */

/** What a build gets when the file is missing a field, or missing entirely. */
const FALLBACK = {
  name: 'DeepSeek Harness',
  appId: 'io.github.huyang218.dsh-desktop',
  dataDir: 'dsh-desktop',
  updateRepo: null,
  icons: {},
}

/**
 * Reads a brand document.
 *
 * @param {string|URL} file
 * @returns {Brand}
 */
export function readBrand(file) {
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // A build with no brand file is the original, unbranded one; a corrupt
    // file is a mistake worth surviving rather than a reason not to start.
    raw = {}
  }
  const text = (key, fallback) => (typeof raw[key] === 'string' && raw[key].trim() !== '' ? raw[key].trim() : fallback)
  const dataDir = safeDirName(text('dataDir', FALLBACK.dataDir)) ?? FALLBACK.dataDir
  return {
    name: text('name', FALLBACK.name),
    appId: text('appId', FALLBACK.appId),
    dataDir,
    ...safeDirName(text('legacyDataDir', '')) ? { legacyDataDir: safeDirName(raw.legacyDataDir) } : {},
    // Derived rather than configured: two names for one thing is two chances
    // to disagree, and nobody wants a log called something else.
    logFile: `${dataDir}.log`,
    updateRepo: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(text('updateRepo', '')) ? text('updateRepo', '') : null,
    icons: raw.icons && typeof raw.icons === 'object' ? raw.icons : {},
  }
}

/**
 * A directory name, or nothing.
 *
 * This one string decides where every byte the app owns is written, and it
 * arrives from a file somebody edited by hand. A separator in it would put
 * the data somewhere nobody chose, so anything that is not a plain name is
 * refused rather than sanitised into something adjacent.
 */
function safeDirName(value) {
  const name = String(value ?? '').trim()
  if (name === '' || name === '.' || name === '..') return undefined
  return /[/\\]/.test(name) ? undefined : name
}

/** The brand this build ships under. */
export const BRAND = readBrand(new URL('../assets/brand.json', import.meta.url))
