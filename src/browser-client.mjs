/**
 * The client half of the browser socket, shared by everything the agent runs.
 *
 * `dsh-open`, `dsh-browser` and the MCP server are three faces of one call:
 * send a line of JSON, read a line of JSON. Keeping that in one module is
 * what keeps the three from disagreeing about the protocol — and the three
 * are copied into the same directory precisely so this import resolves.
 *
 * Dependency-free and started fresh per call, because these are programs the
 * agent launches, not a service.
 */
import net from 'node:net'
import path from 'node:path'

/** What the desktop app put in the environment when it spawned the harness. */
export function bridge() {
  return {
    address: process.env.DSH_DESKTOP_OPEN_SOCKET,
    token: process.env.DSH_DESKTOP_OPEN_TOKEN,
  }
}

/** The message every entry point prints when it is running outside the app. */
export const NO_BRIDGE = 'no browser available (not running under the desktop app)'

/**
 * Runs one verb.
 *
 * @param {string} op @param {object} params
 * @returns {Promise<object>} the app's answer, or `{ok: false, why}`
 */
export function call(op, params = {}) {
  const { address, token } = bridge()
  if (!address || !token) return Promise.resolve({ ok: false, why: NO_BRIDGE })
  return new Promise(resolve => {
    const socket = net.createConnection(address)
    socket.setEncoding('utf8')
    let reply = ''
    let settled = false
    const done = value => { if (!settled) { settled = true; resolve(value) } }
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, op, params, cwd: process.cwd() })}\n`))
    socket.on('data', chunk => { reply += chunk })
    socket.on('error', error => done({ ok: false, why: String(error?.message ?? error) }))
    socket.on('close', () => {
      try {
        done(JSON.parse(reply.trim() || '{}'))
      } catch {
        done({ ok: false, why: 'the desktop app sent an unreadable answer' })
      }
    })
  })
}

/**
 * Makes a local path absolute, and leaves a URL alone.
 *
 * The agent's working directory is not the app's, and `out/report.html` is
 * how an agent refers to a file it just wrote. A Windows drive letter parses
 * as a URL scheme, which is the one case the scheme test has to exclude.
 *
 * @param {string} value @returns {string}
 */
export function resolveLocal(value) {
  const text = String(value ?? '')
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[a-z]:[\\/]/i.test(text)) return text
  return path.resolve(process.cwd(), text)
}
