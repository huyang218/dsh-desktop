/**
 * dsh web server process control: free-port pick, spawn as its own process
 * group, HTTP health wait, and group kill on shutdown.
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { childEnv } from './toolchain.js'
import { dshBinPath } from './runtime.js'

/** How long to wait for a port we are about to reuse, and how often. */
const PORT_ATTEMPTS = 6
const PORT_RETRY_MS = 250

/**
 * A port for the server, preferring the one it had last time.
 *
 * The port is part of the page's origin, and the browser storage the dsh web
 * UI keeps — which workspace is open, which session is current, how the
 * sidebar is arranged — is partitioned by origin. A fresh port every launch
 * is a fresh origin every launch, so all of it is orphaned and the UI opens
 * as if it had never been used. Measured on one install: forty-one abandoned
 * origins, each holding a `workspace.view.v5` and a `dsh.sessions.current`
 * nobody would ever read again.
 *
 * So the last port is offered back, and taken only if it is genuinely free —
 * the check is the same bind that would otherwise pick a random one, so a
 * port something else has claimed since costs one failed bind and falls
 * through. Nothing is pinned: this is a preference, not a reservation, and
 * the app still starts on a machine where that port is now a database.
 *
 * @param {number} [preferred] the port from last time, if there was one
 * @returns {Promise<number>}
 */
export async function getFreePort(preferred) {
  if (Number.isInteger(preferred) && preferred > 1024 && preferred < 65536) {
    // Retried briefly rather than tried once. The launch that most needs the
    // old port is the one after an update, and that is a relaunch: the new
    // process can reach here while the server the old one was told to stop is
    // still letting go. Waiting a moment for a port we ourselves just released
    // is the difference between the update keeping the user's open workspace
    // and quietly dropping it.
    for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
      const held = await bind(preferred).catch(() => undefined)
      if (held !== undefined) return held
      await sleep(PORT_RETRY_MS)
    }
  }
  return bind(0)
}

/**
 * Binds a port to prove it is free, then lets it go.
 *
 * There is a race here by construction — something else can take the port
 * between the close and the server's own bind — and it is the same race the
 * random-port version has always had. dsh failing to bind is a start failure
 * the shell already handles by offering a retry.
 *
 * @param {number} port 0 for any
 * @returns {Promise<number>}
 */
async function bind(port) {
  const srv = net.createServer()
  srv.listen(port, '127.0.0.1')
  try {
    await once(srv, 'listening')
  } catch (error) {
    srv.close()
    throw error
  }
  const { port: bound } = srv.address()
  await new Promise(resolve => srv.close(resolve))
  return bound
}

/**
 * Starts `dsh web --port <port>` from a runtime slot.
 *
 * The child is spawned `detached` so it leads its own process group: dsh
 * spawns further children (shells, PTYs, language servers), and killing the
 * group is the only way to take the whole tree down with it.
 *
 * @param {object} options
 * @param {string} options.slotDir runtime slot holding the dsh install
 * @param {number} options.port port for the web server
 * @param {string} options.dshHome DSH_HOME directory (profiles, sessions, settings)
 * @param {string} options.cwd default workspace root handed to dsh
 * @param {{ nodeBin: string, nodeDir: string, npmCli: string }} options.toolchain
 * @param {string} [options.binDir] a directory to put first on the child's PATH;
 *   this is how the shell's own `dsh-open` command reaches the agent
 * @param {Record<string, string>} [options.env] extra environment for the child
 * @param {(line: string) => void} [options.log] receives server output lines
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function startServer({ slotDir, port, dshHome, cwd, toolchain, binDir, env, log }) {
  const bin = await dshBinPath(slotDir)
  const child = spawn(toolchain.nodeBin, [bin, 'web', '--port', String(port)], {
    cwd,
    env: childEnv(toolchain, { DSH_HOME: dshHome, ...env }, { prepend: binDir ? [binDir] : [] }),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Without this the detached child owns a console window on Windows, which
    // flashes up on every start and on every automatic restart.
    windowsHide: true,
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', chunk => log?.(chunk.trimEnd()))
  }
  return child
}

/**
 * Polls the server root until it answers 200.
 *
 * @param {number} port server port
 * @param {object} [options]
 * @param {number} [options.timeoutMs] overall deadline (default 120s — a first
 *   launch competing with a seed deploy, or any busy disk, has been seen to
 *   need well past a minute, and a premature verdict looks like a crash)
 * @param {() => boolean} [options.aborted] returns true when waiting should stop
 * @returns {Promise<boolean>} true when healthy, false on timeout/abort
 */
export async function waitHealthy(port, { timeoutMs = 120_000, aborted } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (aborted?.()) return false
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
      if (res.ok) return true
    } catch { /* not up yet: poll again below */ }
    await sleep(500)
  }
  return false
}

/**
 * Stops a server started by {@link startServer}: SIGTERM to the process
 * group, escalating to SIGKILL if it has not exited within `graceMs`.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {number} [graceMs] how long to wait before SIGKILL (default 5s)
 * @returns {Promise<void>} resolves once the child has exited
 */
export async function stopServer(child, graceMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  killTree(child.pid, { force: false })
  const result = await Promise.race([exited, sleep(graceMs, 'timeout')])
  if (result === 'timeout') {
    killTree(child.pid, { force: true })
    await exited
  }
}

/**
 * Ends the server and everything it spawned.
 *
 * A negative pid means "the process group" only on POSIX; Windows has no such
 * concept, and signalling the child alone there leaves dsh's own children —
 * shells, PTYs, language servers — running after the app exits. `taskkill /T`
 * is the equivalent that walks the tree.
 *
 * @param {number} pid the server process id
 * @param {{ force: boolean }} options escalate past a graceful request
 */
function killTree(pid, { force }) {
  try {
    if (process.platform === 'win32') {
      const args = ['/PID', String(pid), '/T']
      if (force) args.push('/F')
      // Synchronous and fire-and-forget: a tree that is already gone exits
      // non-zero, which is the normal case on the escalation path.
      spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
      return
    }
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch { /* already gone: the caller is waiting on 'exit' either way */ }
}
