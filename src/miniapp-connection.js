/**
 * Speaking to the simulator.
 *
 * The DevTools puts its running simulator on a WebSocket and answers a very
 * small protocol on it: a message out carrying an id and a method name, a
 * message back carrying that id and a result. Messages that arrive without an
 * id are events — a console line, a thrown exception — pushed rather than
 * asked for.
 *
 * That protocol is why this file exists instead of a dependency on the SDK
 * that speaks it. The SDK would be the obvious choice and is the wrong one
 * twice over: everything the agent runs executes from a directory of copied
 * files with no node_modules — the same constraint that had
 * {@link ./browser-mcp.mjs} write MCP by hand rather than import it — and the
 * packaged `files` list carries `src/` and nothing else. A dependency would
 * have to be paid for in packaging and in deployment to buy a WebSocket that
 * Node has had built in since 22 and a request table that fits on a screen.
 *
 * This half is the app's alone. The agent's programs never open this socket:
 * they reach the app over its own bridge, and the app holds the one
 * connection — because a connection is a thing with a lifetime, and the
 * simulator panel, the agent and the user are all looking at the same one.
 *
 * Electron-free.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { running } from './miniapp-tool.js'
import { getFreePort } from './server.js'

/** How long to keep trying to reach a simulator we just asked to start. */
export const LAUNCH_TIMEOUT_MS = 60_000
/** How long one request may go unanswered before the caller is told. */
export const REQUEST_TIMEOUT_MS = 30_000
/** Between connection attempts while the DevTools is still starting. */
const RETRY_MS = 1_000

/**
 * What a closed connection tells everyone still waiting on it.
 *
 * Named after the cause rather than the symptom: by the time a caller sees
 * this, the DevTools window has usually been closed by hand, and "socket
 * closed" would send them looking at our code for somebody else's decision.
 */
const CLOSED = 'the simulator connection closed — the DevTools window may have been closed'

/**
 * @typedef {object} Session
 * @property {number} port the automation port this connection is on
 * @property {boolean} ours whether we started the DevTools, and may close it
 * @property {(method: string, params?: object) => Promise<any>} send
 * @property {(event: string, handler: (params: any) => void) => () => void} on
 *   subscribe to a pushed event; the return value unsubscribes
 * @property {(options?: {shutTool?: boolean}) => Promise<void>} close
 * @property {() => boolean} closed
 */

/**
 * Opens a connection to a simulator already listening on a port.
 *
 * @param {number} port
 * @param {{ours?: boolean}} [options]
 * @returns {Promise<Session>}
 */
export function connect(port, { ours = false, onClose } = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    // A `WebSocket` error handler is handed an Event, not an Error, and an
    // Event rejected as-is arrives at the caller with an empty `message` —
    // which is exactly the sort of failure that gets reported as "it just
    // didn't work". Nothing on the socket says why, so the only honest
    // message is the one fact we have.
    const failed = () => reject(new Error(`nothing is listening on automation port ${port}`))
    socket.addEventListener('error', failed, { once: true })
    socket.addEventListener('open', () => {
      socket.removeEventListener('error', failed)
      resolve(session(socket, port, ours, onClose))
    }, { once: true })
  })
}

/**
 * Wraps an open socket in the request table that makes it a session.
 *
 * @param {WebSocket} socket @param {number} port @param {boolean} ours
 * @param {() => void} [onClose] run once the session is over, whoever ended it
 * @returns {Session}
 */
function session(socket, port, ours, onClose) {
  /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
  const pending = new Map()
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map()
  let nextId = 1
  let closed = false

  const settleAll = why => {
    const first = !closed
    closed = true
    if (first) {
      try {
        onClose?.()
      } catch { /* the owner's cleanup is not the session's problem */ }
    }
    for (const [, waiter] of pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(why))
    }
    pending.clear()
  }

  socket.addEventListener('close', () => settleAll(CLOSED))
  // An error that arrives after the socket opened is followed by a close, so
  // the waiters are woken there; this only stops it reaching the process as
  // an unhandled event.
  socket.addEventListener('error', () => { /* close follows */ })

  socket.addEventListener('message', event => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data))
    } catch {
      return
    }
    const { id, method, error, result, params } = message ?? {}
    if (id === undefined || id === null) {
      // No id: something the simulator is telling us, not something we asked.
      for (const handler of listeners.get(method) ?? []) {
        try {
          handler(params)
        } catch { /* one bad listener does not cost the others their event */ }
      }
      return
    }
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id)
    clearTimeout(waiter.timer)
    if (error) waiter.reject(new Error(error.message ?? 'the simulator refused the request'))
    else waiter.resolve(result)
  })

  return {
    port,
    ours,
    closed: () => closed,

    send(method, params = {}) {
      if (closed) return Promise.reject(new Error(CLOSED))
      const id = nextId++
      return new Promise((resolve, reject) => {
        // A timeout per request, because the simulator can be made to sit on
        // one indefinitely — `callWxMethod` on an API that shows a modal
        // answers when the modal is dismissed, and nobody is going to dismiss
        // it. Without this the agent's turn simply stops.
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`the simulator did not answer ${method} within ${REQUEST_TIMEOUT_MS}ms`))
        }, REQUEST_TIMEOUT_MS)
        pending.set(id, { resolve, reject, timer })
        try {
          socket.send(JSON.stringify({ id, method, params }))
        } catch (error) {
          pending.delete(id)
          clearTimeout(timer)
          reject(new Error(error?.message ?? CLOSED))
        }
      })
    },

    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return () => listeners.get(event)?.delete(handler)
    },

    /**
     * Ends the session, and optionally the DevTools with it.
     *
     * `shutTool` is the difference between letting go of a window the user
     * opened and closing one we opened behind their back. It is asked for
     * rather than decided here, because only the caller knows which of those
     * happened — and `Tool.close` is the DevTools' own way out, which is why
     * this does not go looking for a process to kill.
     */
    async close({ shutTool = false } = {}) {
      if (shutTool && !closed) {
        // Best effort by construction: the answer to `Tool.close` arrives, if
        // at all, from an application in the middle of quitting.
        await Promise.race([this.send('Tool.close').catch(() => {}), sleep(3_000)])
      }
      closed = true
      try {
        socket.close()
      } catch { /* already gone */ }
      settleAll(CLOSED)
    },
  }
}

/**
 * What the `cli` prints when the service port is switched off.
 *
 * It does not fail on that — it asks, on stdin, whether to switch the setting
 * on, and then waits for an answer that is never coming from a process we
 * spawned without a terminal. Recognising the question is what turns a
 * sixty-second silence into the one sentence that fixes it.
 *
 * Matched in either language the `cli` prints it in, because which one it
 * chooses depends on the machine's locale rather than on this app's.
 */
const SERVICE_PROMPT = /Enable IDE Service|服务端口已关闭|IDE service port disabled/i

/**
 * What that state means, in the terms the user can act on.
 *
 * Deliberately not offered as something this app will answer for them. The
 * switch opens a port that every process on the machine can reach, it lives
 * under a heading the DevTools itself calls 安全设置, and an application that
 * silently turns on another application's security settings is doing
 * something the user did not ask for even when the feature needs it.
 */
export const SERVICE_DISABLED = 'the DevTools service port is switched off'
  + ' — open it under 设置 → 安全设置 → 服务端口, then try again'

/**
 * Why opening a project is a decision and not a detail.
 *
 * The DevTools asks before opening a project it has not seen, because opening
 * one runs code from it. Left unanswered, that question is invisible from
 * here in the worst possible way: the automation port opens, `Tool.getInfo`
 * answers in milliseconds, and every `App.*` call hangs forever behind a
 * dialog nobody mentioned. It cost an afternoon to find, which is a good
 * reason to say so here.
 *
 * So `trust` answers it — and is a parameter rather than a constant, because
 * the answer is not ours to assume. It belongs to whoever can say the user
 * chose this project: a directory picked in our own window, or one the agent
 * wrote inside the session's workspace. A path that arrived some other way
 * should reach the user as the DevTools' own question, not as a decision this
 * file made quietly on their behalf.
 */
export const TRUST_NOTE = 'the DevTools asks before opening an unfamiliar project'

/**
 * Starts the DevTools against a project and connects to it.
 *
 * `cli auto` is the DevTools' own supported entry point: it opens the project
 * — in the running instance when there is one — and switches on the
 * automation port we name. So this spawns it and then knocks on that port
 * until somebody answers, which is the only reliable signal available. The
 * command exits long before the simulator is ready, and its exit status says
 * nothing about whether the IDE went on to open anything.
 *
 * Its output is read rather than discarded, for one reason found the hard
 * way: with the service port off the `cli` does not fail, it asks a question
 * and waits forever for an answer. A launcher that ignored its output would
 * wait out the whole timeout and then leave the process sitting there.
 *
 * Whether the DevTools was already running decides who owns it afterwards.
 * `cli auto` opens the project in the running instance when there is one, so
 * a launch against an IDE the user already had open is us borrowing their
 * application, not starting our own — and the session says which, because
 * closing it later depends entirely on the answer.
 *
 * @param {object} options
 * @param {import('./miniapp-tool.js').DevTools} options.tool from findDevTools
 * @param {string} options.projectPath directory holding project.config.json
 * @param {boolean} [options.trust] answer the DevTools' trust prompt for this
 *   project; see {@link TRUST_NOTE}
 * @param {number} [options.timeout]
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<Session>}
 */
export async function launch({ tool, projectPath, trust = false, pure = false, timeout = LAUNCH_TIMEOUT_MS, log }) {
  // Asked before the spawn, because afterwards the answer is always yes.
  const ours = !await running(tool)
  const port = await getFreePort()
  log?.(`starting the DevTools on automation port ${port}`)

  const args = ['auto', '--project', projectPath, '--auto-port', String(port)]
  if (trust) args.push('--trust-project')
  if (pure) args.push('--pure-simulator')

  const child = spawn(tool.cliPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so that ending the launcher is a decision about
    // the launcher. The `cli` is a shell script that starts a GUI application
    // with the user's unsaved work in it, and the process-tree kill that owns
    // the dsh server would be exactly the wrong thing to point at it.
    detached: true,
  })

  let output = ''
  let asking = false
  let spawnError
  const watch = chunk => {
    output += chunk
    if (SERVICE_PROMPT.test(output)) asking = true
  }
  for (const stream of [child.stdout, child.stderr]) {
    stream?.setEncoding('utf8')
    stream?.on('data', watch)
  }
  child.on('error', error => { spawnError = error })

  const deadline = Date.now() + timeout
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw new Error(`could not run the DevTools cli: ${spawnError.message}`)
      if (asking) throw new Error(SERVICE_DISABLED)
      try {
        // The launcher outlives the connection: `cli auto` holds the session
        // open, so ending it is part of ending the session rather than
        // something to do once this returns.
        return await connect(port, { ours, onClose: () => endLauncher(child) })
      } catch { /* not up yet */ }
      await sleep(RETRY_MS)
    }
    throw new Error(
      `the DevTools did not open an automation port within ${Math.round(timeout / 1000)}s`
      + (output.trim() ? `: ${lastLine(output)}` : ''),
    )
  } catch (error) {
    // Only when the question was the failure is the group killed. That is the
    // one case where we know nothing was opened — the `cli` asks it during
    // its own initialize step, before it starts anything — so there is no
    // window of the user's inside the group. Any other failure gets the
    // launcher alone, because we cannot tell what it may have started.
    endLauncher(child, { group: asking })
    throw error
  }
}

/**
 * Ends a launcher, and shrugs at every way that can fail.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {{group?: boolean}} [options]
 */
function endLauncher(child, { group = false } = {}) {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    if (group && child.pid) process.kill(-child.pid, 'SIGKILL')
    else child.kill('SIGKILL')
  } catch { /* already gone, or never ours to kill */ }
}

/** The last thing the launcher said, for an error that needs a reason. */
function lastLine(output) {
  const lines = output.split('\n').map(line => line.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}

/**
 * Waits until the simulator has a page on screen.
 *
 * The SDK sleeps five seconds here and hopes. That is a guess about a machine
 * — a cold project on a slow disk takes longer, a warm one is ready at once —
 * and it is a guess in both directions: it wastes five seconds when it is
 * wrong the cheap way and reports an empty page stack when it is wrong the
 * expensive way. Asking is neither slower nor less reliable.
 *
 * @param {Session} session
 * @param {{timeout?: number}} [options]
 * @returns {Promise<any[]>} the page stack, once there is one
 */
export async function ready(session, { timeout = LAUNCH_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const { pageStack } = await session.send('App.getPageStack')
      if (Array.isArray(pageStack) && pageStack.length > 0) return pageStack
    } catch (error) {
      // A compile still in progress refuses the call rather than answering
      // emptily, so a refusal here is not yet a failure.
      lastError = error
      if (session.closed()) break
    }
    await sleep(RETRY_MS)
  }
  throw new Error(
    'the simulator opened but never showed a page'
    + (lastError ? ` (${lastError.message})` : ' — the project may have failed to compile'),
  )
}
