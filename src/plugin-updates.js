/**
 * Which installed plugins have a newer version published.
 *
 * Asked of the registry the machine actually uses, not of registry.npmjs.org:
 * a mirror is the normal configuration wherever the default one is slow or
 * unreachable, and a check that ignores it reports "no updates" for the one
 * reason that has nothing to do with updates. npm itself is the authority on
 * which registry that is, so it is asked once and the answer reused.
 *
 * Only registry dependencies are checked. A `link:`, `file:` or git spec
 * resolves to something whose version is not npm's to state — for those the
 * question has no answer here, and inventing one would put an update badge
 * on a plugin nobody can update that way.
 *
 * Deliberately free of Electron imports; the caller injects fetch and the
 * command runner.
 */
import { compareVersions } from './app-update.js'

/** Specs whose version does not come from a registry. */
const NON_REGISTRY = /^(?:link:|file:|github:|git\+|https?:|npm:.*@(?:link|file):|\.{0,2}\/)/

/** Registry lookups run at once; enough to be quick, few enough to be polite. */
const CONCURRENCY = 6

const REQUEST_TIMEOUT_MS = 10_000

/** @param {string} spec @returns {boolean} whether npm can answer for it */
export function isRegistrySpec(spec) {
  return typeof spec === 'string' && spec !== '' && !NON_REGISTRY.test(spec)
}

/**
 * The newest published version of each installed registry plugin.
 *
 * Failure is per-plugin and silent: a package pulled from the registry, a
 * private name the mirror does not carry, or a request that times out simply
 * has no answer, and the row goes on showing what is installed.
 *
 * @param {object} options
 * @param {Array<{name: string, version?: string, spec: string}>} options.plugins
 * @param {string} options.registry base URL, trailing slash optional
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<Record<string, string>>} package name → newer version
 */
export async function findPluginUpdates({ plugins, registry, fetchImpl = fetch, log }) {
  const base = String(registry ?? '').replace(/\/+$/, '')
  if (!base) return {}
  const candidates = plugins.filter(plugin => plugin.version && isRegistrySpec(plugin.spec))
  const updates = {}

  const queue = [...candidates]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let plugin = queue.shift(); plugin; plugin = queue.shift()) {
      const latest = await latestVersionOf(base, plugin.name, fetchImpl).catch(() => undefined)
      if (latest && compareVersions(latest, plugin.version) > 0) updates[plugin.name] = latest
    }
  })
  await Promise.all(workers)
  const count = Object.keys(updates).length
  log?.(`plugin updates: ${count} of ${candidates.length} checked package${candidates.length === 1 ? '' : 's'} have a newer version`)
  return updates
}

/**
 * One package's newest version.
 *
 * `/<name>/latest` rather than the full packument: the document for a busy
 * package is megabytes of every version ever published, and all of it would
 * be thrown away.
 */
async function latestVersionOf(base, name, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    // A scoped name's slash is part of the name, not a path separator.
    const response = await fetchImpl(`${base}/${name.replace('/', '%2F')}/latest`, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) return undefined
    const version = (await response.json())?.version
    return typeof version === 'string' ? version : undefined
  } finally {
    clearTimeout(timer)
  }
}
