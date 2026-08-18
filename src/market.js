/**
 * The plugin market: a curated catalog of dsh plugins, read by the shell.
 *
 * The market this follows (springbrand-lab/dsh-plugin-market) is itself a dsh
 * plugin that serves a browser UI from inside the running server. The shell
 * has no use for that half: it already owns the plugin operations, the
 * profile and the window, so all it needs from the market is the catalog —
 * one JSON document listing what exists. Browsing and installing then happen
 * in the plugin manager window, next to the plugins already installed,
 * through the same `dsh plugin` command as every other install route.
 *
 * Two properties of the catalog drive everything here. It is large (several
 * megabytes, thousands of crawled repositories) and it is remote, i.e.
 * untrusted: entries are normalized and filtered down to the few hundred that
 * are really dsh plugins, the result is cached on disk so the window opens
 * instantly and works offline, and only a validated npm package name is ever
 * handed to the installer. The catalog's own `install` string — a ready-made
 * shell command — is deliberately ignored.
 *
 * Deliberately free of Electron imports.
 */
import { readFile, writeFile } from 'node:fs/promises'

/** Catalog served by the market this implementation follows. */
export const DEFAULT_CATALOG_URL = 'https://dshplugin.market/plugins.json'

/**
 * How long a cached catalog is used without going back to the network. The
 * catalog is a curated list that moves a few times a day at most, and the
 * document is megabytes; the manual refresh covers the impatient case.
 */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** The download is big and served from a CDN; be generous but not infinite. */
const FETCH_TIMEOUT_MS = 90_000

/**
 * Entity types that describe something installable into a profile. The
 * catalog crawls repositories and marks everything it could not classify as
 * `unknown` — thousands of entries that are not plugins at all. Filtering by
 * this list is what turns a crawl into a market.
 */
const REAL_ENTITY_TYPES = new Set(['bundle', 'skill', 'agent-preset', 'mcp-server', 'cordis-plugin'])

/** npm registry names only: never a path, a URL, an alias, or shell text. */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/**
 * @typedef {object} MarketEntry
 * @property {string} id stable within a catalog; the list is deduplicated by it
 * @property {string} name
 * @property {string} owner
 * @property {string} url repository, always https
 * @property {string} [page] the catalog's own page for the entry
 * @property {{en?: string, zh?: string}} description by language, may be empty
 * @property {string} kind entity type, or the catalog's category
 * @property {number} stars
 * @property {string} [license]
 * @property {string} [language]
 * @property {string} [npm] package name, present only when it validates
 * @property {boolean} installable whether one-click install is offered
 * @property {boolean} runsInstallScripts install executes package scripts
 */

/**
 * Normalizes a catalog document into market entries.
 *
 * Written against two real catalog shapes, because the field a document uses
 * to say "this is a plugin" is the one thing they disagree on: the dsh market
 * classifies every crawled repository with `entity_type`/`installability`,
 * while the curated awesome-dsh-plugin list has no such field and is a list
 * of plugins by construction. A document without any `entity_type` is
 * therefore taken at its word instead of being filtered down to nothing.
 *
 * @param {unknown} value the parsed catalog document
 * @returns {{ entries: MarketEntry[], source: { name?: string, url?: string } }}
 */
export function parseCatalog(value) {
  const rows = record(value)?.plugins
  if (!Array.isArray(rows)) throw new Error('the catalog has no plugins array')
  const classified = rows.some(row => text(record(row)?.entity_type) ?? text(record(row)?.entityType))
  const entries = new Map()
  for (const row of rows) {
    const entry = normalize(row, classified)
    if (entry && !entries.has(entry.id)) entries.set(entry.id, entry)
  }
  return {
    entries: [...entries.values()].sort((a, b) => b.stars - a.stars || a.name.localeCompare(b.name)),
    source: { name: text(record(value)?.name), url: httpUrl(record(value)?.url) },
  }
}

/** @returns {MarketEntry | undefined} */
function normalize(value, classified) {
  const row = record(value)
  if (!row) return undefined
  const name = text(row.name)
  const owner = text(row.owner)
  const url = httpUrl(row.url)
  if (!name || !owner || !url) return undefined

  const entityType = text(row.entity_type) ?? text(row.entityType)
  if (classified && !REAL_ENTITY_TYPES.has(entityType ?? '')) return undefined

  const npm = text(row.npm) ?? text(row.packageName)
  const usable = npm !== undefined && npm.length <= 214 && npm === npm.toLowerCase() && NPM_NAME.test(npm)
  const installability = text(row.installability)
  const installMethod = text(row.install_method) ?? text(row.installMethod)

  return {
    id: entryId(row, owner, name),
    name,
    owner,
    url,
    ...(httpUrl(row.page) ? { page: httpUrl(row.page) } : {}),
    description: descriptions(row.description),
    kind: entityType ?? text(row.category) ?? 'plugin',
    stars: count(row.stars),
    ...(text(row.license) ? { license: text(row.license) } : {}),
    ...(text(row.language) ? { language: text(row.language) } : {}),
    ...(usable ? { npm } : {}),
    // One-click install is offered only for a plugin the catalog has actually
    // checked and that installs from the npm registry. A git install builds
    // from source on the user's machine — the catalog's own `broken-build`
    // and `needs-allowlist` verdicts exist because that frequently fails —
    // and is left to the spec field, where the user types it deliberately.
    installable: usable && (!classified || (
      entityType === 'bundle' && installability === 'installable' && installMethod === 'npm'
    )),
    runsInstallScripts: row.runs_install_scripts === true || row.runsInstallScripts === true,
  }
}

/** Descriptions are a plain string in one catalog and a language map in the other. */
function descriptions(value) {
  const direct = text(value)
  if (direct) return { en: direct }
  const map = record(value)
  return {
    ...(text(map?.en) ? { en: text(map.en) } : {}),
    ...(text(map?.zh) ? { zh: text(map.zh) } : {}),
  }
}

/** A stable id, preferring the catalog's own page slug. */
function entryId(row, owner, name) {
  const explicit = text(row.id)
  if (explicit) return explicit
  const page = httpUrl(row.page)
  if (page) {
    const slug = new URL(page).pathname.split('/').filter(Boolean).at(-1)
    if (slug) return slug
  }
  return `${owner}/${name}`.toLowerCase()
}

function record(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0
}

/** https/http only: the URL is rendered as a link and opened in a browser. */
function httpUrl(value) {
  const raw = text(value)
  if (!raw) return undefined
  try {
    const parsed = new URL(raw)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.toString() : undefined
  } catch {
    return undefined
  }
}

/**
 * Loads the catalog, preferring the disk cache.
 *
 * The network is never on the critical path of opening the window: a cached
 * catalog is returned as it is, and a fetch is made only when the cache is
 * missing, stale, from a different source, or explicitly refused by the
 * caller. A failed fetch with a cache in hand is reported alongside the
 * cached entries rather than replacing them with an error — a market that
 * still lists what it listed yesterday is more useful offline than one that
 * shows nothing.
 *
 * @param {object} options
 * @param {string} options.url catalog URL
 * @param {string} options.cacheFile where the normalized catalog is kept
 * @param {boolean} [options.force] fetch even when the cache is fresh
 * @param {(line: string) => void} [options.log]
 * @param {typeof fetch} [options.fetchImpl] injected so the shell can hand in
 *   Electron's `net.fetch`, which goes through the system's proxy and PAC
 *   configuration — a desktop app is often behind one, and Node's own fetch
 *   ignores all of it.
 * @returns {Promise<{ entries: MarketEntry[], source: object, fetchedAt: string,
 *   url: string, cached: boolean, error?: string }>}
 */
export async function loadCatalog({ url, cacheFile, force = false, log, fetchImpl = fetch }) {
  const cache = await readCache(cacheFile)
  const usable = cache && cache.url === url ? cache : undefined
  const fresh = usable && Date.now() - Date.parse(usable.fetchedAt) < CACHE_TTL_MS
  if (usable && fresh && !force) return { ...usable, cached: true }

  try {
    log?.(`market: fetching ${url}`)
    const document = await fetchJson(url, fetchImpl)
    const { entries, source } = parseCatalog(document)
    const loaded = { url, source, entries, fetchedAt: new Date().toISOString() }
    await writeFile(cacheFile, JSON.stringify(loaded)).catch(error => {
      // A catalog that cannot be cached is still a catalog; only the next
      // window open pays for it again.
      log?.(`market: could not write the catalog cache: ${error?.message ?? error}`)
    })
    log?.(`market: ${entries.length} entries from ${source.name ?? url}`)
    return { ...loaded, cached: false }
  } catch (error) {
    const message = String(error?.message ?? error)
    log?.(`market: fetch failed: ${message}`)
    if (usable) return { ...usable, cached: true, error: message }
    throw new Error(message)
  }
}

/** One JSON GET, bounded in time, with the response type checked. */
async function fetchJson(url, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, FETCH_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (!(response.headers.get('content-type') ?? '').includes('json')) {
      throw new Error('the catalog did not return JSON')
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

async function readCache(cacheFile) {
  try {
    const cache = JSON.parse(await readFile(cacheFile, 'utf8'))
    return Array.isArray(cache?.entries) && typeof cache.fetchedAt === 'string' ? cache : undefined
  } catch {
    return undefined
  }
}
