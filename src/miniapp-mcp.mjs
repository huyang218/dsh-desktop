/**
 * The simulator as MCP tools.
 *
 * dsh's MCP client spawns this over stdio and registers what it advertises as
 * `mcp__miniapp__open`, `mcp__miniapp__tap`, and so on. The tools are the
 * table in miniapp-ops.js; this file is only the wire, and it is the wire
 * twice over — the model's call comes in as JSON-RPC on stdin and goes out to
 * the app on its socket.
 *
 * Written against the protocol directly rather than against the MCP SDK, for
 * the reason {@link ./browser-mcp.mjs} gives: this runs from a directory of
 * copied files with no node_modules.
 *
 * Not imported by the app. Run as a program, by the stub {@link ./open-bridge.js}
 * writes.
 */
import { createInterface } from 'node:readline'
import { call } from './bridge-client.mjs'
import { emptyLog, logLine, mcpTools, OPS } from './miniapp-ops.js'

/** Every verb travels under this name; the app routes on it. */
const PREFIX = 'miniapp.'
/** What we answer with when the client names no version of its own. */
const FALLBACK_PROTOCOL = '2024-11-05'

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const reply = (id, result) => send({ jsonrpc: '2.0', id, result })
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } })

createInterface({ input: process.stdin }).on('line', line => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  handle(message).catch(error => {
    // A throw here would take the server down mid-session and the model would
    // see its tools vanish; one failed call is the smaller failure.
    if (message?.id !== undefined) fail(message.id, -32603, String(error?.message ?? error))
  })
})

async function handle(message) {
  const { id, method, params } = message ?? {}
  // A notification (no id) is told nothing back, by the protocol.
  if (id === undefined) return

  if (method === 'initialize') {
    const asked = typeof params?.protocolVersion === 'string' ? params.protocolVersion : FALLBACK_PROTOCOL
    return reply(id, {
      protocolVersion: asked,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'dsh-desktop-miniapp', version: '1' },
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: mcpTools() })
  if (method === 'tools/call') {
    const name = params?.name
    if (!Object.hasOwn(OPS, name)) return fail(id, -32602, `no such tool "${name}"`)
    const result = await call(PREFIX + name, params?.arguments ?? {})
    return reply(id, toolResult(result))
  }
  return fail(id, -32601, `unsupported method "${method}"`)
}

/**
 * One verb's answer, as MCP content.
 *
 * Text first and always, even beside an image: whether a screenshot survives
 * into the model's context depends on the route it is calling on, and a tool
 * that says nothing to a text-only model is a tool that model cannot use.
 *
 * A refusal comes back as `isError` with the reason as its text — the model is
 * meant to read it and choose differently, which is why the reasons in the
 * engine are sentences rather than codes.
 */
function toolResult(result) {
  const content = []
  const text = render(result)
  if (text) content.push({ type: 'text', text })
  if (result.png) content.push({ type: 'image', data: result.png, mimeType: 'image/png' })
  if (content.length === 0) content.push({ type: 'text', text: result.ok ? 'done' : 'failed' })
  return { content, ...(result.ok === false ? { isError: true } : {}) }
}

/** The same shape the command line prints, without its file-writing habits. */
function render(result) {
  const lines = []
  if (result.ok === false) lines.push(result.why ?? 'failed')
  else if (result.why) lines.push(`note: ${result.why}`)
  if (result.state) lines.push(`${result.state}${result.version ? ` (DevTools ${result.version})` : ''}`)
  if (result.project) lines.push(`project ${result.project}${result.appid ? ` (${result.appid})` : ''}`)
  if (result.route) lines.push(`page ${result.route}`)
  if (result.ran) lines.push(`ran ${result.ran}`)
  if (result.elements) lines.push(result.elements)
  if (result.result !== undefined) lines.push(result.result)
  if (result.pages) lines.push(...result.pages.map(entry => `  ${entry.route}`))
  if (result.messages) {
    lines.push(...(result.messages.length ? result.messages.map(logLine) : [emptyLog('log output')]))
  }
  if (result.path) lines.push(`wrote ${result.path}`)
  if (result.closed) lines.push(`closed ${result.closed}`)
  return lines.join('\n')
}
