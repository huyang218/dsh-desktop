/**
 * The browser as MCP tools.
 *
 * dsh's MCP client spawns this over stdio and registers what it advertises as
 * `mcp__browser__navigate`, `mcp__browser__click`, and so on — native tools
 * the model chooses between, rather than a command line it has to remember
 * the flags for. The tools are the table in browser-ops.js; this file is only
 * the wire.
 *
 * Written against the protocol directly rather than against the MCP SDK: this
 * runs from a directory of copied files with no node_modules, and stdio MCP is
 * newline-delimited JSON-RPC — a hundred lines against a dependency the
 * deployment would have to grow a package manager to acquire.
 *
 * Not imported by the app. Run as a program, by the stub {@link ./open-bridge.js}
 * writes.
 */
import { createInterface } from 'node:readline'
import { call } from './browser-client.mjs'
import { consoleLine, emptyLog, mcpTools, networkLine, OPS } from './browser-ops.js'

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
      serverInfo: { name: 'dsh-desktop-browser', version: '1' },
    })
  }
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: mcpTools() })
  if (method === 'tools/call') {
    const name = params?.name
    if (!Object.hasOwn(OPS, name)) return fail(id, -32602, `no such tool "${name}"`)
    const result = await call(name, params?.arguments ?? {})
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
 * A refusal comes back as `isError` with the reason as its text — the model
 * is meant to read it and choose differently, which is why the reasons in the
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
  if (result.page && result.url !== undefined) {
    lines.push(`${result.page} ${result.url}${result.title ? ` — ${result.title}` : ''}${result.loading ? ' (still loading)' : ''}`)
  }
  if (result.coveredBy) lines.push(`note: the click landed on ${result.coveredBy}, which covers the target`)
  if (result.scrolled !== undefined) {
    lines.push(result.scrolled ? `scrolled ${result.scrolled}px${result.atEnd ? ' (at the end)' : ''}` : 'nothing scrolled; already at the end')
  }
  if (result.options) lines.push(`available: ${result.options.join(', ')}`)
  if (result.elements) {
    lines.push(...result.elements)
    if (result.truncated) lines.push(`… truncated at ${result.elements.length} elements`)
  }
  if (result.text !== undefined) lines.push(result.text, ...(result.truncated ? ['… truncated'] : []))
  if (result.result !== undefined) lines.push(result.result)
  if (result.messages) lines.push(...(result.messages.length ? result.messages.map(consoleLine) : [emptyLog('console output')]))
  if (result.requests) lines.push(...(result.requests.length ? result.requests.map(networkLine) : [emptyLog('requests')]))
  if (result.pages) lines.push(...result.pages.map(entry => `${entry.front ? '*' : ' '} ${entry.page} ${entry.url} — ${entry.title}`))
  if (result.path) lines.push(`wrote ${result.path}`)
  if (result.closed) lines.push(`closed ${result.closed === true ? 'the browser panel' : result.closed}`)
  return lines.join('\n')
}
