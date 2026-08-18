/**
 * Installing a plugin from a zip package.
 *
 * `dsh plugin add <absolute path>` already accepts a directory, and pnpm
 * records it as a `link:` dependency — the profile keeps pointing at that
 * directory for as long as the plugin stays installed. A zip therefore
 * cannot be unpacked somewhere temporary: the unpacked tree IS the installed
 * plugin, so it goes to a stable directory the shell owns
 * (`<DSH_HOME>/plugins/<package name>`) and stays there until the plugin is
 * removed.
 *
 * Unpacking happens in a staging directory next to the destination and is
 * moved into place only once the archive has proven to contain a package:
 * a broken or unrelated zip then leaves the previously installed copy of
 * that plugin exactly as it was.
 */
import { readdir, readFile, mkdir, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { t } from './i18n.js'
import { extractZip } from './zip.js'

/** Directory under DSH_HOME that holds every zip-installed plugin. */
export const PLUGIN_DIR = 'plugins'

/**
 * npm's package-name grammar, which is also what pnpm accepts as a link
 * target, and — since the name becomes a directory — the guard that keeps a
 * hand-written `package.json` from choosing where the plugin gets written.
 * Uppercase is allowed because names published before npm forbade it are
 * still installable.
 */
const PACKAGE_NAME = /^(?:@[A-Za-z0-9-~][A-Za-z0-9-._~]*\/)?[A-Za-z0-9-~][A-Za-z0-9-._~]*$/

/**
 * Unpacks a plugin zip into its own directory under `pluginsDir`.
 *
 * @param {object} options
 * @param {string} options.zipPath the archive the user picked
 * @param {string} options.pluginsDir `<DSH_HOME>/plugins`, created if missing
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ name: string, version: string|undefined, dir: string }>}
 *   the package it contained and where it now lives
 */
export async function unpackPluginZip({ zipPath, pluginsDir, log }) {
  await mkdir(pluginsDir, { recursive: true })
  // Same parent as the destination, so moving into place is a rename within
  // one filesystem rather than a copy that can half-finish.
  const staging = path.join(pluginsDir, `.staging-${process.pid}-${Date.now()}`)
  try {
    const { files } = await extractZip(zipPath, staging, { log })
    log?.(`zip: unpacked ${files} file${files === 1 ? '' : 's'} from ${path.basename(zipPath)}`)
    const root = await findPackageRoot(staging)
    const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
    const name = manifest.name
    if (typeof name !== 'string' || !PACKAGE_NAME.test(name)) {
      throw new Error(t('error.zipBadName', { name: String(name) }))
    }
    // A scoped name becomes a nested directory, exactly as it would inside
    // node_modules; the name is validated above, so it cannot walk out.
    const dir = path.join(pluginsDir, ...name.split('/'))
    // Replacing an earlier copy of the same plugin: pnpm's link points at
    // this path, so reinstalling has to overwrite in place rather than pick
    // a new directory the profile knows nothing about.
    await rm(dir, { recursive: true, force: true })
    await mkdir(path.dirname(dir), { recursive: true })
    await rename(root, dir)
    log?.(`zip: ${name} unpacked into ${dir}`)
    // A local directory is installed as a pnpm `link:`, and pnpm does not
    // install a linked package's own dependencies. A zip that ships none is
    // the likeliest way to end up with a plugin that installs cleanly and
    // then fails to load, so say so while the log is still on screen.
    if (Object.keys(manifest.dependencies ?? {}).length > 0 && !await hasNodeModules(dir)) {
      log?.(t('plugins.zipDepsWarning', { name }))
    }
    return { name, version: manifest.version, dir }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
}

/**
 * Finds the directory holding the package manifest.
 *
 * Both shapes people actually have are accepted: a zip of the package
 * contents (`package.json` at the top), and a zip of the package directory
 * or a GitHub source download (one wrapper directory containing it).
 * Anything deeper is ambiguous — a zip of several packages has no single
 * right answer — and is refused rather than guessed at.
 *
 * @param {string} dir the freshly unpacked staging directory
 * @returns {Promise<string>}
 */
async function findPackageRoot(dir) {
  if (await hasManifest(dir)) return dir
  const children = (await readdir(dir, { withFileTypes: true }))
    .filter(child => child.isDirectory() && !child.name.startsWith('.'))
  if (children.length === 1) {
    const nested = path.join(dir, children[0].name)
    if (await hasManifest(nested)) return nested
  }
  throw new Error(t('error.zipNoPackage'))
}

async function hasNodeModules(dir) {
  try {
    return (await readdir(path.join(dir, 'node_modules'))).length > 0
  } catch {
    return false
  }
}

async function hasManifest(dir) {
  try {
    await readFile(path.join(dir, 'package.json'), 'utf8')
    return true
  } catch {
    return false
  }
}
