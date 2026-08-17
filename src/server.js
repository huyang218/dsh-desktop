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

/** Asks the OS for a free TCP port. @returns {Promise<number>} */
export async function getFreePort() {
  const srv = net.createServer()
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  const { port } = srv.address()
  await new Promise(resolve => srv.close(resolve))
  return port
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
 * @param {(line: string) => void} [options.log] receives server output lines
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function startServer({ slotDir, port, dshHome, cwd, toolchain, log }) {
  const bin = await dshBinPath(slotDir)
  const child = spawn(toolchain.nodeBin, [bin, 'web', '--port', String(port)], {
    cwd,
    env: childEnv(toolchain, { DSH_HOME: dshHome }),
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
