/**
 * The in-app browser: what it will open, and how the dsh UI's own "open this
 * file" gesture is talked out of the system browser.
 *
 * dsh already knows how to open a produced file — `host.openPath` hands it to
 * the OS, and for `.html` it goes out of its way to name the default browser.
 * That is the right answer for a terminal install and the wrong one here: the
 * page the agent just wrote is part of the conversation, and throwing it into
 * Safari puts it in a different application from the session that produced it.
 *
 * The gateway cannot be told to open it differently — `ApiProxyService`'s
 * `nativeOpen` config is a boolean that only changes the answer to "can this
 * host open paths at all", and the opener itself is a code-level seam this
 * shell has no way to reach without patching dsh, which it does not do. So
 * the interception happens on this side of the wire, in the page: one named
 * RPC, recognised by its own URL, answered locally when the shell took it and
 * forwarded untouched every other time.
 *
 * Electron-free, so the vetting and the injected source can be exercised
 * under plain Node.
 */
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The RPC the dsh web UI posts to open a path. */
export const OPEN_PATH_ROUTE = '/api/host.openPath'

/**
 * Documents this window will render.
 *
 * The first four are dsh's own list — the extensions for which it prefers a
 * browser over the file-type association — so intercepting exactly those
 * keeps the rule predictable: what would have opened in a browser opens
 * here, and what would have opened in Numbers or Word still does. The rest
 * are what a browser also renders rather than downloads, and they are here
 * for the agent-driven opener, which is not choosing against a system
 * application but against showing the user nothing at all.
 */
export const BROWSER_DOCUMENTS = new Set(['.html', '.htm', '.xhtml', '.svg'])
const ALSO_RENDERABLE = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.txt'])

/** @param {string} target @returns {boolean} */
export function isBrowserDocument(target) {
  return BROWSER_DOCUMENTS.has(path.extname(target).toLowerCase())
}

/**
 * Resolves what the window should load, or nothing when it should not.
 *
 * Two shapes arrive here: a filesystem path, from the UI's file chips and
 * from the agent's own opener, and an http(s) URL, from an agent that started
 * a dev server and wants it looked at. Everything else — `javascript:`,
 * `data:`, a custom scheme some other application registered — is refused
 * rather than handed to a window, because the whole point of routing this
 * through the shell is that the shell decides what a page may be.
 *
 * @param {string} target a filesystem path or an http(s) URL
 * @param {object} [options]
 * @param {boolean} [options.wide] accept the renderable-but-not-a-document
 *   extensions too; the agent's opener sets this, the UI interception does not
 * @param {(target: string) => boolean} [options.exists] file check seam
 * @returns {{ url: string, label: string } | undefined}
 */
export function previewTarget(target, { wide = false, exists } = {}) {
  const text = typeof target === 'string' ? target.trim() : ''
  if (text === '') return undefined

  const remote = asHttpUrl(text)
  if (remote) return { url: remote.toString(), label: remote.host + remote.pathname }

  // Anything that parsed as a URL but is not http(s) — including the file:
  // URLs a caller may pass instead of a path — is handled here rather than
  // falling through to the path branch, where `file:///x` would become a
  // relative filename.
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(text)?.[1]?.toLowerCase()
  if (scheme && scheme !== 'file' && !isWindowsDrive(text)) return undefined

  const filePath = scheme === 'file' ? fileUrlPath(text) : text
  if (filePath === undefined || !path.isAbsolute(filePath)) return undefined
  const extension = path.extname(filePath).toLowerCase()
  if (!BROWSER_DOCUMENTS.has(extension) && !(wide && ALSO_RENDERABLE.has(extension))) return undefined
  if (exists && !exists(filePath)) return undefined
  return { url: pathToFileURL(filePath).toString(), label: filePath }
}

/** @param {string} text @returns {URL | undefined} an http(s) URL, or nothing */
function asHttpUrl(text) {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** `C:\path` parses as the scheme `c`; it is a path, not a URL. */
function isWindowsDrive(text) {
  return /^[a-z]:[\\/]/i.test(text)
}

/** @param {string} text @returns {string | undefined} a `file:` URL's path, if it names one */
function fileUrlPath(text) {
  try {
    return fileURLToPath(text)
  } catch {
    // A `file:` URL with a host, or one that is simply malformed. Neither
    // names a local file, and neither is worth a window.
    return undefined
  }
}

/**
 * The script that teaches the page to route `host.openPath` through the shell.
 *
 * Runs in the page's own world — the UI's API client calls the global
 * `fetch`, and a wrapper installed in the preload's isolated world would
 * never be the one it reaches. Written as a string for the same reason
 * {@link ../send-to-chat.js insertionScript} is: it is code for somebody
 * else's world, not this one's.
 *
 * Every uncertainty falls through to the original request. A body that is not
 * the envelope this expects, a bridge the preload did not install, a path the
 * shell declined, a throw anywhere in the middle: all of them end in the
 * fetch that would have happened anyway, which is the behaviour this replaces
 * and therefore a safe place to land.
 *
 * @returns {string} source to evaluate in the page
 */
export function interceptScript() {
  return `(() => {
    const bridge = window.__dshDesktop;
    if (!bridge || window.__dshDesktopFetchWrapped) return false;
    window.__dshDesktopFetchWrapped = true;
    const original = window.fetch;
    window.fetch = async function (input, init) {
      try {
        const raw = typeof input === 'string' ? input
          : input instanceof URL ? input.href
          : input && typeof input.url === 'string' ? input.url : undefined;
        // Only the one route, and only the form the client actually posts: a
        // string body it just serialised. A Request object or a stream is
        // some other caller and is none of this wrapper's business.
        if (raw !== undefined && new URL(raw, location.href).pathname === ${JSON.stringify(OPEN_PATH_ROUTE)}
            && typeof init?.body === 'string') {
          const message = JSON.parse(init.body);
          const target = message?.payload?.path;
          if (typeof target === 'string' && await bridge.openPreview(target)) {
            return new Response(JSON.stringify({
              type: 'server-response',
              rpcId: message.rpcId,
              result: { ok: true, value: { opened: true } },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
        }
      } catch { /* fall through: the request the page meant to make */ }
      return original.apply(this, arguments);
    };
    return true;
  })()`
}
