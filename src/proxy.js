/**
 * One proxy setting, applied to the two networks this app actually has.
 *
 * The shell fetches over Chromium's stack (the market catalog, its own
 * update check) and spawns processes that fetch over their own (npm
 * installing the runtime, pnpm installing plugins, and the dsh server
 * calling the model API). Those two obey completely different
 * configuration: Chromium reads the system's proxy settings, while the child
 * processes read HTTP_PROXY and friends from their environment.
 *
 * A GUI app inherits neither reliably. Launched from Finder or the Start
 * menu it gets no shell environment at all, so a proxy exported in a shell
 * profile is invisible to it; and a machine can perfectly well have a proxy
 * running with the system-wide setting switched off, which is the common
 * setup wherever a local proxy client is used. The result is an app that
 * cannot reach the network while every terminal on the same machine can.
 *
 * So the setting is the app's own, and it is applied to both stacks from one
 * place. Chromium is configured through the session; the child processes are
 * covered by setting the variables on this process's environment, which
 * childEnv() passes down to every one of them.
 *
 * Deliberately free of Electron imports; the caller applies the session part.
 */

/** Never proxied: the app's own server, and anything else on this machine. */
export const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1']

/** Proxy environment variables, in both spellings tools look for. */
const ENV_KEYS = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy']

/**
 * @typedef {object} ProxySetting
 * @property {'system'|'direct'|'manual'} mode
 * @property {string} url  proxy URL, for `manual`
 * @property {string} bypass  comma-separated hosts, for `manual`
 */

/** @param {unknown} raw the `proxy` value out of settings.json @returns {ProxySetting} */
export function normalize(raw) {
  const mode = ['system', 'direct', 'manual'].includes(raw?.mode) ? raw.mode : 'system'
  return {
    mode,
    url: typeof raw?.url === 'string' ? raw.url.trim() : '',
    bypass: typeof raw?.bypass === 'string' ? raw.bypass.trim() : '',
  }
}

/**
 * Checks a proxy URL and returns it in the form both stacks understand.
 *
 * A bare `host:port` is accepted and read as http, because that is how every
 * proxy client in the world displays its own address.
 *
 * @returns {string} the normalized URL
 * @throws {Error} with an untranslated reason key when it is not usable
 */
export function normalizeUrl(url) {
  const raw = String(url ?? '').trim()
  if (!raw) throw new Error('empty')
  const withScheme = /^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `http://${raw}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    throw new Error('malformed')
  }
  if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks:'].includes(parsed.protocol)) throw new Error('scheme')
  if (!parsed.hostname) throw new Error('malformed')
  // A path, query or fragment is never part of a proxy address; silently
  // dropping them would hide a typo that makes the whole thing not work.
  if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) throw new Error('malformed')
  const port = parsed.port ? `:${parsed.port}` : ''
  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : ''
  return `${parsed.protocol}//${auth}${parsed.hostname}${port}`
}

/** The hosts that skip the proxy: the user's list plus this machine. */
export function bypassList(proxy) {
  const configured = proxy.bypass.split(',').map(entry => entry.trim()).filter(Boolean)
  return [...new Set([...ALWAYS_DIRECT, ...configured])]
}

/**
 * Chromium's session configuration.
 *
 * @param {ProxySetting} proxy
 * @returns {{mode: string, proxyRules?: string, proxyBypassRules?: string}}
 */
export function sessionConfig(proxy) {
  if (proxy.mode === 'direct') return { mode: 'direct' }
  if (proxy.mode !== 'manual') return { mode: 'system' }
  return {
    mode: 'fixed_servers',
    proxyRules: normalizeUrl(proxy.url),
    proxyBypassRules: bypassList(proxy).join(','),
  }
}

/**
 * Applies the setting to an environment object, in place.
 *
 * `system` leaves the environment exactly as it was found: an app started
 * from a shell that exports a proxy keeps using it, which is the behaviour
 * anyone running from source already relies on.
 *
 * @param {ProxySetting} proxy
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv} the same object
 */
export function applyToEnv(proxy, env = process.env) {
  if (proxy.mode === 'system') return env
  for (const key of [...ENV_KEYS, ...NO_PROXY_KEYS]) delete env[key]
  if (proxy.mode === 'direct') return env
  const url = normalizeUrl(proxy.url)
  for (const key of ENV_KEYS) env[key] = url
  for (const key of NO_PROXY_KEYS) env[key] = bypassList(proxy).join(',')
  return env
}

/**
 * A proxy the environment already carries, if any.
 *
 * Offered as a starting value in the settings window: someone who exported
 * one in a shell profile should not have to look it up to tell the app about
 * it — and when the app was launched from Finder there is nothing here,
 * which is itself the explanation for why the setting exists.
 */
export function proxyFromEnv(env = process.env) {
  for (const key of ENV_KEYS) {
    const value = env[key]
    if (typeof value === 'string' && value.trim()) {
      try {
        return normalizeUrl(value)
      } catch { /* an unusable value is not worth offering */ }
    }
  }
  return ''
}

/** A short, human description of the active setting, for logs. */
export function describe(proxy) {
  if (proxy.mode === 'manual') {
    // Credentials belong in the settings file, not in the log.
    return `manual ${normalizeUrl(proxy.url).replace(/\/\/[^@]*@/, '//')}`
  }
  return proxy.mode
}
