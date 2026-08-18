/**
 * Updating the shell itself, against its GitHub releases.
 *
 * Two kinds of update, because the app is two things in one bundle. The
 * shell — every rule in this directory plus the window markup — is
 * JavaScript, and a new one can simply be downloaded and booted from the
 * data directory (see shell-bundle.js): a hundred kilobytes, no installer,
 * no administrator, and the installed app bundle is never touched, so its
 * signature and the privacy permissions bound to it survive. Everything
 * else — Electron itself, the bundled Node, the runtime seed — is inside
 * that bundle and can only change by installing a new one.
 *
 * Which kind applies is not guessed: each release publishes a small manifest
 * saying what the shell it contains was built against, and a shell built for
 * a different Electron major is not offered as a hot update at all.
 *
 * No dependency does any of this. The download is one fetch, the archive is
 * read by src/zip.js, and the payload is checked against a SHA-256 published
 * beside it — the same trust as the installer download it replaces, which is
 * to say GitHub's TLS.
 *
 * Deliberately free of Electron imports; the caller injects fetch.
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { activate, isCompatible, readManifest } from './shell-bundle.js'
import { extractZip } from './zip.js'
import { t } from './i18n.js'

/** Mirrors package.json's `repository` field; the releases live here. */
export const REPO = 'huyang218/dsh-desktop'

/** The manifest asset a release publishes for hot updates. */
const MANIFEST_ASSET = 'shell-update.json'

const REQUEST_TIMEOUT_MS = 30_000
/** A shell bundle is ~100KB; an installer is ~200MB. */
const MAX_BUNDLE_BYTES = 32 * 1024 * 1024

/**
 * Compares two dotted version strings.
 *
 * Numeric fields only, and a version with a `-rc.1` style suffix sorts below
 * the same version without one. That is the whole of semver this app can
 * produce, and inventing the rest would be code no release exercises.
 *
 * @returns {number} negative when a < b, 0 when equal, positive when a > b
 */
export function compareVersions(a, b) {
  const parse = value => {
    const [core, pre] = String(value ?? '').replace(/^v/, '').split('-')
    return { parts: core.split('.').map(n => Number(n) || 0), pre: pre ?? '' }
  }
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.parts.length, right.parts.length); i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (left.pre === right.pre) return 0
  if (left.pre === '') return 1
  if (right.pre === '') return -1
  return left.pre < right.pre ? -1 : 1
}

/**
 * The newest published release.
 *
 * @param {{fetchImpl?: typeof fetch, repo?: string}} [options]
 * @returns {Promise<{version: string, tag: string, notes: string, url: string,
 *   assets: Array<{name: string, url: string, size: number}>}>}
 */
export async function fetchLatestRelease({ fetchImpl = fetch, repo = REPO } = {}) {
  const release = await getJson(`https://api.github.com/repos/${repo}/releases/latest`, fetchImpl)
  const tag = String(release?.tag_name ?? '')
  if (!tag) throw new Error(t('error.updateNoRelease'))
  return {
    version: tag.replace(/^v/, ''),
    tag,
    notes: String(release.body ?? '').trim(),
    url: String(release.html_url ?? ''),
    assets: (release.assets ?? []).map(asset => ({
      name: String(asset.name),
      url: String(asset.browser_download_url),
      size: Number(asset.size) || 0,
    })),
  }
}

/**
 * Reads a release's hot-update manifest, when it publishes one.
 *
 * Releases made before hot updates existed have none; they are not a failure,
 * they simply cannot be applied without installing.
 *
 * @returns {Promise<{version: string, electron: string, sha256: string, asset: string} | undefined>}
 */
export async function fetchShellManifest(release, { fetchImpl = fetch } = {}) {
  const asset = release.assets.find(candidate => candidate.name === MANIFEST_ASSET)
  if (!asset) return undefined
  const manifest = await getJson(asset.url, fetchImpl)
  const valid = typeof manifest?.version === 'string' && typeof manifest?.electron === 'string'
    && /^[0-9a-f]{64}$/.test(String(manifest?.sha256)) && typeof manifest?.asset === 'string'
  return valid ? manifest : undefined
}

/**
 * Decides what a release means for the running app.
 *
 * @param {object} options
 * @param {string} options.current running shell version
 * @param {string} options.electronVersion running Electron
 * @param {object} options.release from {@link fetchLatestRelease}
 * @param {object} [options.manifest] from {@link fetchShellManifest}
 * @returns {{kind: 'current'|'hot'|'install', version: string}}
 */
export function plan({ current, electronVersion, release, manifest }) {
  if (compareVersions(release.version, current) <= 0) return { kind: 'current', version: current }
  const hot = manifest
    && compareVersions(manifest.version, release.version) === 0
    && isCompatible(manifest, electronVersion)
  return { kind: hot ? 'hot' : 'install', version: release.version }
}

/**
 * Downloads, verifies and stages a shell bundle. It becomes the shell that
 * boots next launch; nothing about the running one changes.
 *
 * @param {object} options
 * @param {object} options.release @param {object} options.manifest
 * @param {string} options.shellDir @param {typeof fetch} [options.fetchImpl]
 * @param {(received: number, total: number) => void} [options.onProgress]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{version: string, dir: string}>}
 */
export async function stageShellUpdate({ release, manifest, shellDir, fetchImpl = fetch, onProgress, log }) {
  const asset = release.assets.find(candidate => candidate.name === manifest.asset)
  if (!asset) throw new Error(t('error.updateNoAsset', { name: manifest.asset }))

  const staging = await mkdtemp(path.join(tmpdir(), 'dsh-shell-'))
  try {
    const archive = path.join(staging, 'bundle.zip')
    const bytes = await download(asset.url, archive, { fetchImpl, onProgress, maxBytes: MAX_BUNDLE_BYTES })
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (digest !== manifest.sha256) throw new Error(t('error.updateChecksum'))
    log?.(`shell ${manifest.version}: ${bytes.length} bytes verified`)

    const unpacked = path.join(staging, 'bundle')
    await extractZip(archive, unpacked, { log })
    // What the boot path will demand later, demanded now, while there is
    // still someone to report it to.
    const staged = readManifest(unpacked)
    if (!staged || staged.version !== manifest.version) throw new Error(t('error.updateBadBundle'))
    await readFile(path.join(unpacked, 'src', 'main.js'), 'utf8')

    await mkdir(shellDir, { recursive: true })
    const dir = activate(shellDir, manifest.version, unpacked)
    log?.(`shell ${manifest.version} staged at ${dir}`)
    return { version: manifest.version, dir }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

/** The installer this platform can run, out of a release's assets. */
export function installerAsset(release, platform = process.platform, arch = process.arch) {
  const wanted = platform === 'win32'
    ? name => name.endsWith('.exe')
    : name => name.endsWith(`-${arch}.dmg`) || name.endsWith('.dmg')
  return release.assets.find(asset => wanted(asset.name))
}

/**
 * Downloads an installer into `dir` and returns its path. Opening it is left
 * to the caller: replacing a running app from inside itself is a good way to
 * end up with neither version, and the platform's own installer already
 * knows how to do it.
 */
export async function downloadInstaller({ release, dir, fetchImpl = fetch, onProgress, log }) {
  const asset = installerAsset(release)
  if (!asset) throw new Error(t('error.updateNoInstaller'))
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, asset.name)
  await download(asset.url, file, { fetchImpl, onProgress })
  log?.(`downloaded ${asset.name} to ${dir}`)
  return file
}

/** One JSON GET, bounded in time and checked for type. */
async function getJson(url, fetchImpl) {
  const response = await withTimeout(signal => fetchImpl(url, {
    headers: { accept: 'application/json' }, signal,
  }))
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json()
}

/**
 * Streams a download to disk, reporting progress, and returns the bytes.
 *
 * Kept in memory as well as on disk because the only two things downloaded
 * here are a small archive that must be hashed and an installer whose size
 * is checked; the cap keeps the first honest.
 */
async function download(url, file, { fetchImpl, onProgress, maxBytes }) {
  const response = await withTimeout(signal => fetchImpl(url, { redirect: 'follow', signal }))
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || 0
  if (maxBytes && total > maxBytes) throw new Error(t('error.updateTooLarge'))

  const chunks = []
  let received = 0
  for await (const chunk of response.body) {
    received += chunk.length
    if (maxBytes && received > maxBytes) throw new Error(t('error.updateTooLarge'))
    chunks.push(chunk)
    onProgress?.(received, total)
  }
  const bytes = Buffer.concat(chunks)
  await writeFile(file, bytes)
  return bytes
}

/** The request timeout applies to reaching the server, not to the transfer. */
async function withTimeout(request) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    return await request(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
