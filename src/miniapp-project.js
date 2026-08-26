/**
 * Recognising a mini program on disk.
 *
 * The agent works in a session's workspace and writes a mini program into
 * some directory of it. Before any of that can be opened in a simulator,
 * somebody has to decide which directory is the project — and asking the user
 * to type a path is the wrong answer twice over: they would be telling us
 * something already written down in the files the agent just produced, and an
 * agent driving the simulator on its own has nobody to ask.
 *
 * So the workspace is read instead. `project.config.json` is what the
 * DevTools itself opens a directory by, which makes it the only honest marker
 * — a directory the DevTools would refuse is not a project no matter how much
 * it looks like one.
 *
 * Electron-free, so it can be exercised under plain Node.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

/** The file the DevTools opens a project by. */
export const PROJECT_CONFIG = 'project.config.json'
/**
 * Local overrides, kept out of version control.
 *
 * Read second and allowed to win, because that is what it is for: a checkout
 * shared by several people carries one appid in the tracked file and each
 * person's own in this one.
 */
export const PRIVATE_CONFIG = 'project.private.config.json'

/**
 * What each kind of project is entered through.
 *
 * The entry file is not decoration — it is the difference between a project
 * and a directory containing a stale config. Both look identical until you
 * ask whether the thing the config describes is actually there.
 */
const ENTRIES = {
  miniprogram: { rootKey: 'miniprogramRoot', entry: 'app.json' },
  plugin: { rootKey: 'pluginRoot', entry: 'plugin.json' },
  game: { rootKey: 'miniprogramRoot', entry: 'game.json' },
}

/** Directories a project never hides inside, and that are expensive to walk. */
const SKIP = new Set(['node_modules', 'miniprogram_npm', 'dist', 'build', 'unpackage', 'coverage'])

/**
 * @typedef {object} Project
 * @property {string} dir the directory the DevTools would be pointed at
 * @property {string} name for showing; the directory name when the config has none
 * @property {string} [appid] absent on a project that has never been bound
 * @property {'miniprogram'|'plugin'|'game'} type
 * @property {string} root the sources' directory, relative to `dir`
 * @property {string} entry absolute path to `app.json` and its siblings
 */

/**
 * Reads one directory as a project, or decides it is not one.
 *
 * Strict on purpose: a config whose entry file is missing is not returned at
 * all. Listing something that will fail the moment it is opened is worse than
 * leaving it out — the user would pick it, watch it fail, and learn nothing
 * about why.
 *
 * @param {string} dir
 * @returns {Project | undefined}
 */
export function readProject(dir) {
  const config = readJson(path.join(dir, PROJECT_CONFIG))
  if (!config) return undefined
  const merged = { ...config, ...(readJson(path.join(dir, PRIVATE_CONFIG)) ?? {}) }

  const type = merged.compileType in ENTRIES ? merged.compileType : 'miniprogram'
  const { rootKey, entry } = ENTRIES[type]
  const root = typeof merged[rootKey] === 'string' ? merged[rootKey] : ''
  const entryPath = path.join(dir, root, entry)
  if (!existsSync(entryPath)) return undefined

  return {
    dir,
    name: projectName(merged.projectname) ?? path.basename(dir),
    appid: typeof merged.appid === 'string' && merged.appid !== '' ? merged.appid : undefined,
    type,
    root,
    entry: entryPath,
  }
}

/**
 * Walks a workspace and returns the projects in it, shallowest first.
 *
 * Bounded in three directions, because this runs against whatever directory a
 * session happens to be open on and that may be a home directory: a depth, a
 * count, and a skip list. A project's own subdirectories are never descended
 * into — sub-packages and a cloud-function root are parts of one project, not
 * projects of their own, and returning them would offer the user the same
 * program several times under different names.
 *
 * @param {string} root
 * @param {object} [options]
 * @param {number} [options.depth] directories below `root` to look, `root` being 0
 * @param {number} [options.limit] stop after this many
 * @returns {Project[]}
 */
export function findProjects(root, { depth = 3, limit = 50 } = {}) {
  const found = []
  /** @type {{dir: string, level: number}[]} */
  let level = [{ dir: path.resolve(root), level: 0 }]
  while (level.length > 0 && found.length < limit) {
    /** @type {{dir: string, level: number}[]} */
    const next = []
    for (const { dir, level: at } of level) {
      const project = readProject(dir)
      if (project) {
        found.push(project)
        if (found.length >= limit) break
        continue
      }
      if (at >= depth) continue
      for (const name of subdirectories(dir)) {
        next.push({ dir: path.join(dir, name), level: at + 1 })
      }
    }
    level = next
  }
  return found
}

/** @param {string} dir @returns {string[]} */
function subdirectories(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name))
      .map(entry => entry.name)
  } catch {
    // Unreadable, or gone since the parent was listed. Neither is ours to
    // report: the walk is a search, and a directory that cannot be searched
    // simply holds no projects.
    return []
  }
}

/**
 * The project's display name.
 *
 * The DevTools percent-encodes this field, so a project called 测试 is stored
 * as `%E6%B5%8B%E8%AF%95` and shown raw by anything that does not know. A
 * name that was never encoded decodes to itself, and one that is malformed is
 * returned as written rather than thrown away.
 *
 * @param {unknown} raw
 * @returns {string | undefined}
 */
function projectName(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** @param {string} file @returns {Record<string, any> | undefined} */
function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}
