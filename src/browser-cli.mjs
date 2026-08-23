/**
 * `dsh-browser` — the whole browser on a command line.
 *
 * The same verbs the model gets as MCP tools, for an agent working through
 * bash, for a script, and for anyone debugging what the tools are actually
 * doing. Output is written for a reader that is probably a model: short
 * lines, the page's addressable elements one per line, no decoration.
 *
 * Not imported by the app. Run as a program, by the stub {@link ./open-bridge.js}
 * writes.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { call, resolveLocal } from './browser-client.mjs'
import { consoleLine, emptyLog, networkLine, OPS, parseArgs } from './browser-ops.js'

const [verb, ...argv] = process.argv.slice(2)

if (verb === undefined || verb === '-h' || verb === '--help' || verb === 'help') {
  process.stdout.write(usage())
  process.exit(verb === undefined ? 2 : 0)
}
const op = OPS[verb]
if (!op) {
  process.stderr.write(`dsh-browser: no such command "${verb}"\n\n${usage()}`)
  process.exit(2)
}

// Taken out before the verb's own options are parsed: it belongs to the
// command line, not to the browser, and the table would reject it.
const json = argv.includes('--json')
const parsed = parseArgs(argv.filter(argument => argument !== '--json'), op)
if (parsed.error) {
  process.stderr.write(`dsh-browser ${verb}: ${parsed.error}\n`)
  process.exit(2)
}
const params = parsed.params
// The two parameters that name something on this side of the socket: the app
// resolves nothing on the agent's behalf, and its working directory is not
// the session's.
if (typeof params.url === 'string') params.url = resolveLocal(params.url)
if (typeof params.path === 'string') params.path = path.resolve(process.cwd(), params.path)

const result = await call(verb, params)

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.ok ? 0 : 1)
}
process.stdout.write(render(verb, result))
process.exit(result.ok ? 0 : 1)

/** One screen of help, generated from the table so it cannot fall behind it. */
function usage() {
  const lines = ['usage: dsh-browser <command> [arguments] [--options]', '']
  for (const [name, entry] of Object.entries(OPS)) {
    const args = (entry.positional ?? []).map(slot => `<${slot}>`).join(' ')
    const first = entry.summary.split('. ')[0].replace(/\.$/, '')
    lines.push(`  ${`${name} ${args}`.trim().padEnd(22)} ${first}.`)
  }
  lines.push('', 'Options are --name value or --name=value; flags take no value.',
    'Add --json for the raw result.', '')
  return lines.join('\n')
}

/** The result as text. A failure is one line; a page is its element list. */
function render(verb, result) {
  if (!result.ok && !result.elements) {
    const detail = result.options ? ` (available: ${result.options.join(', ')})` : ''
    return `dsh-browser ${verb}: ${result.why ?? 'failed'}${detail}\n`
  }
  const lines = []
  if (result.page && result.url !== undefined) {
    lines.push(`${result.page} ${result.url}${result.title ? ` — ${result.title}` : ''}${result.loading ? ' (still loading)' : ''}`)
  }
  if (result.coveredBy) lines.push(`note: the click landed on ${result.coveredBy}, which covers the target`)
  if (result.scrolled !== undefined) {
    lines.push(result.scrolled ? `scrolled ${result.scrolled}px${result.atEnd ? ' (at the end)' : ''}` : 'nothing scrolled; already at the end')
  }
  if (result.why) lines.push(`note: ${result.why}`)
  if (result.options) lines.push(`available: ${result.options.join(', ')}`)

  if (result.elements) {
    lines.push(...result.elements)
    if (result.truncated) lines.push(`… truncated at ${result.elements.length} elements`)
  }
  if (result.text !== undefined) lines.push(result.text, ...(result.truncated ? ['… truncated'] : []))
  if (result.result !== undefined) lines.push(result.result)
  if (result.messages) lines.push(...(result.messages.length ? result.messages.map(consoleLine) : [emptyLog('console output')]))
  if (result.requests) lines.push(...(result.requests.length ? result.requests.map(networkLine) : [emptyLog('requests')]))
  if (result.pages) {
    lines.push(...result.pages.map(entry => `${entry.front ? '*' : ' '} ${entry.page} ${entry.url} — ${entry.title}`))
  }
  if (result.png) {
    // Base64 down a pipe helps nobody; the command line's answer to a
    // screenshot is a file, so one gets written even when none was asked for.
    const file = path.resolve(process.cwd(), `${result.page}.png`)
    writeFileSync(file, Buffer.from(result.png, 'base64'))
    lines.push(`wrote ${file}`)
  }
  if (result.path) lines.push(`wrote ${result.path}`)
  if (result.closed) lines.push(`closed ${result.closed === true ? 'the browser panel' : result.closed}`)
  return `${lines.join('\n')}\n`
}
