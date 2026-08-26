/**
 * The channel the agent opens a page through.
 *
 * A produced file the user clicks is one thing; the interesting case is the
 * agent that wants the page looked at now — it wrote a form, a diff, a
 * chart, something the next turn depends on the user having seen. dsh runs
 * as a child process here, and a child process has exactly one way to reach
 * the desktop by itself: hand a path to the OS, which is the system browser
 * again, in another application, with the session left behind.
 *
 * So the shell puts commands on the child's PATH. `dsh-open <file|url>` shows
 * a page; `dsh-browser <verb> …` drives it; and the MCP server the model gets
 * its browser tools from speaks to the same socket. All three are two-line
 * stubs around the bundled Node, and all three send one line of JSON here.
 * Nothing about it is dsh-specific: any tool the agent can run — bash, a
 * script, a plugin — reaches the same browser through the same socket.
 *
 * A socket rather than a port: there is no listening TCP service to find, and
 * the token in every message means a second local user who guessed the socket
 * path still cannot make windows appear on this desktop.
 *
 * Electron-free; the caller supplies what to do with an accepted target.
 */
import { createHash, randomBytes } from 'node:crypto'
import net from 'node:net'
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'

const isWindows = process.platform === 'win32'
/** Longest sun_path on macOS; Linux allows 108. Neither reports a useful error. */
const MAX_SOCKET_PATH = 100
/**
 * One line of JSON is the whole protocol.
 *
 * Generous because a request can carry a page's worth of JavaScript for
 * `eval`, and bounded because this socket is reachable by anything running as
 * this user and an unbounded line is an unbounded allocation.
 */
const MAX_MESSAGE_BYTES = 256 * 1024

/** @returns {string} a fresh token for one run of the app */
export function mintToken() {
  return randomBytes(24).toString('base64url')
}

/**
 * Where the socket lives.
 *
 * Under the data directory by preference, because that is the directory this
 * app owns and its permissions are the user's own. The fallback exists for a
 * relocated data directory nested deep enough to exceed the address limit —
 * a limit that is not a byte count anyone thinks about until a socket in a
 * long path silently fails to bind.
 *
 * @param {string} dataDir @returns {string}
 */
export function bridgeAddress(dataDir) {
  const digest = createHash('sha256').update(dataDir).digest('hex').slice(0, 12)
  if (isWindows) return `\\\\.\\pipe\\dsh-desktop-open-${digest}`
  const preferred = path.join(dataDir, 'open.sock')
  return preferred.length <= MAX_SOCKET_PATH ? preferred : path.join(tmpdir(), `dsh-desktop-open-${digest}.sock`)
}

/**
 * Starts listening for open requests.
 *
 * @param {object} options
 * @param {string} options.address from {@link bridgeAddress}
 * @param {string} options.token the secret every message must carry
 * @param {(op: string, params: object, cwd: string) => Promise<object>} options.run
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<import('node:net').Server>}
 */
export function startBridge({ address, token, run, log }) {
  // A socket file left by a crash keeps the next launch from binding. Removing
  // it is safe in a way it would not be for a service: this address is derived
  // from this app's own data directory, and the app is single-instance.
  if (!isWindows && existsSync(address)) rmSync(address, { force: true })

  const server = net.createServer(socket => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > MAX_MESSAGE_BYTES) { socket.destroy(); return }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      const line = buffer.slice(0, newline)
      buffer = ''
      handle(line).then(reply => socket.end(`${JSON.stringify(reply)}\n`), () => socket.destroy())
    })
    socket.on('error', () => { /* a client that went away mid-request */ })
  })

  async function handle(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return { ok: false, why: 'malformed request' }
    }
    // Compared before anything else is read: a caller without the token gets
    // the same answer whatever it asked for.
    if (message?.token !== token) return { ok: false, why: 'not authorised' }
    const op = typeof message.op === 'string' ? message.op : ''
    const cwd = typeof message.cwd === 'string' ? message.cwd : ''
    if (op === '') return { ok: false, why: 'no command' }
    try {
      return await run(op, message.params ?? {}, cwd)
    } catch (error) {
      return { ok: false, why: error?.message ?? String(error) }
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(address, () => {
      server.removeListener('error', reject)
      server.on('error', error => log?.(`open bridge: ${error?.message ?? error}`))
      // Owner-only. The default is 0755 on macOS, which on a shared machine
      // would let another account connect and be told "not authorised" —
      // correct, but there is no reason to let it get that far.
      if (!isWindows) { try { chmodSync(address, 0o600) } catch { /* best effort */ } }
      log?.(`open bridge listening on ${address}`)
      resolve(server)
    })
  })
}

/**
 * Writes the shell's commands into a directory meant for the child's PATH.
 *
 * A stub around the bundled Node rather than a program of its own: the stub
 * bakes in absolute paths, so the command works from a shell that has no
 * `node` at all — the ordinary case for someone who installed this app and
 * never installed a toolchain.
 *
 * The shim is copied out beside the stub instead of being referenced where it
 * ships. In a packaged build `src/` lives inside `app.asar`, which Electron's
 * own fs can read and a plain Node cannot; the stub runs plain Node, so a
 * path into the archive would be a command that fails only in the packaged
 * app. Copying costs two kilobytes and removes the difference.
 *
 * @param {object} options
 * @param {string} options.binDir directory to create and write into
 * @param {string} options.nodeBin the bundled Node
 * @param {string} options.srcDir where the .mjs files ship
 * @returns {Record<string, string>} command name to its absolute stub path
 */
export function writeOpenCommand({ binDir, nodeBin, srcDir }) {
  mkdirSync(binDir, { recursive: true })
  // Every module the entry points import, copied together: they import each
  // other by relative path, so the whole set has to land in one directory.
  for (const file of COPIED) {
    copyFileSync(path.join(srcDir, file), path.join(binDir, file))
  }
  // Without this, Node reads the copied `.js` as CommonJS and its `import`
  // statements are a syntax error. The repository's own package.json says the
  // same thing; this directory is outside it.
  writeFileSync(path.join(binDir, 'package.json'), '{ "type": "module" }\n')
  return {
    'dsh-open': stub(binDir, nodeBin, 'dsh-open', 'open-shim.mjs'),
    'dsh-browser': stub(binDir, nodeBin, 'dsh-browser', 'browser-cli.mjs'),
    'dsh-browser-mcp': stub(binDir, nodeBin, 'dsh-browser-mcp', 'browser-mcp.mjs'),
    'dsh-miniapp': stub(binDir, nodeBin, 'dsh-miniapp', 'miniapp-cli.mjs'),
    'dsh-miniapp-mcp': stub(binDir, nodeBin, 'dsh-miniapp-mcp', 'miniapp-mcp.mjs'),
    'dsh-phone': stub(binDir, nodeBin, 'dsh-phone', 'phone-cli.mjs'),
    'dsh-phone-mcp': stub(binDir, nodeBin, 'dsh-phone-mcp', 'phone-mcp.mjs'),
  }
}

/**
 * Every module the entry points reach, directly or through each other.
 *
 * A list rather than a walk of the import graph, because it is short and a
 * walk would need a parser. It does have to be kept closed, though: a file
 * that imports a sibling this list forgets is a command that works from the
 * repository and fails from the copies, which is the packaged app and nowhere
 * a test would look.
 */
const COPIED = [
  'ops.js',
  'bridge-client.mjs',
  'browser-ops.js',
  'open-shim.mjs',
  'browser-cli.mjs',
  'browser-mcp.mjs',
  'miniapp-ops.js',
  'miniapp-cli.mjs',
  'miniapp-mcp.mjs',
  'phone-ops.js',
  'phone-cli.mjs',
  'phone-mcp.mjs',
]

/** One command: a stub that runs the bundled Node against one of the copies. */
function stub(binDir, nodeBin, name, entry) {
  const target = path.join(binDir, entry)
  if (isWindows) {
    const file = path.join(binDir, `${name}.cmd`)
    writeFileSync(file, `@echo off\r\n"${nodeBin}" "${target}" %*\r\n`)
    return file
  }
  const file = path.join(binDir, name)
  writeFileSync(file, `#!/bin/sh\nexec ${shellQuote(nodeBin)} ${shellQuote(target)} "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

/** Single-quoted for /bin/sh; the data directory has a space in it on macOS. */
function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}
