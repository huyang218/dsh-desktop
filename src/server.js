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
 * @param {number} [options.timeoutMs] overall deadline (default 60s)
 * @param {() => boolean} [options.aborted] returns true when waiting should stop
 * @returns {Promise<boolean>} true when healthy, false on timeout/abort
 */
export async function waitHealthy(port, { timeoutMs = 60_000, aborted } = {}) {
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
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch { /* group already gone: fall through to the wait below */ }
  const result = await Promise.race([exited, sleep(graceMs, 'timeout')])
  if (result === 'timeout') {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch { /* group exited between the check and the kill */ }
    await exited
  }
}
