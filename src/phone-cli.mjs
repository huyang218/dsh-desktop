/**
 * `dsh-phone` — the phone on a command line.
 *
 * The same verbs the model gets as MCP tools, for an agent working through
 * bash, for a plugin, and for anyone debugging what the tools are actually
 * doing. Output is written for a reader that is probably a model: short
 * lines, the screen's views one per line, no decoration.
 *
 * Not imported by the app. Run as a program, by the stub {@link ./open-bridge.js}
 * writes.
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { call } from './bridge-client.mjs'
import { emptyLog, logLine, OPS, parseArgs } from './phone-ops.js'

/** Every verb travels under this name; the app routes on it. */
const PREFIX = 'phone.'

const [verb, ...argv] = process.argv.slice(2)

if (verb === undefined || verb === '-h' || verb === '--help' || verb === 'help') {
  process.stdout.write(usage())
  process.exit(verb === undefined ? 2 : 0)
}
const op = OPS[verb]
if (!op) {
  process.stderr.write(`dsh-phone: no such command "${verb}"\n\n${usage()}`)
  process.exit(2)
}

// Taken out before the verb's own options are parsed: it belongs to the
// command line, not to the simulator, and the table would reject it.
const json = argv.includes('--json')
const parsed = parseArgs(argv.filter(argument => argument !== '--json'), op)
if (parsed.error) {
  process.stderr.write(`dsh-phone ${verb}: ${parsed.error}\n`)
  process.exit(2)
}
const params = parsed.params
// The app resolves nothing on the agent's behalf: its working directory is
// not the session's, and `./my-app` is how an agent names what it just wrote.
for (const name of ['apk', 'path']) {
  if (typeof params[name] === 'string') params[name] = path.resolve(process.cwd(), params[name])
}

const result = await call(PREFIX + verb, params)

if (json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.ok ? 0 : 1)
}
process.stdout.write(render(verb, result))
process.exit(result.ok ? 0 : 1)

/** One screen of help, generated from the table so it cannot fall behind it. */
function usage() {
  const lines = ['usage: dsh-phone <command> [arguments] [--options]', '']
  for (const [name, entry] of Object.entries(OPS)) {
    const args = (entry.positional ?? []).map(slot => `<${slot}>`).join(' ')
    const first = entry.summary.split('. ')[0].replace(/\.$/, '')
    lines.push(`  ${`${name} ${args}`.trim().padEnd(26)} ${first}.`)
  }
  lines.push('', 'Options are --name value or --name=value; flags take no value.',
    'Add --json for the raw result.', '')
  return lines.join('\n')
}

/** The result as text. A failure is one line; a page is its element list. */
function render(verb, result) {
  if (!result.ok) return `dsh-phone ${verb}: ${result.why ?? 'failed'}${place(result)}\n`
  const lines = []
  if (result.state) lines.push(`${result.state}${result.serial ? ` (${result.serial})` : ''}`)
  if (result.why) lines.push(result.state ? `note: ${result.why}` : result.why)
  if (result.tapped) lines.push(`tapped ${result.tapped}`)
  if (result.typed !== undefined) lines.push(`typed ${JSON.stringify(result.typed)}`)
  if (result.pressed) lines.push(`pressed ${result.pressed}`)
  if (result.swiped) lines.push(`swiped ${result.swiped}`)
  if (result.elements) lines.push(result.elements)
  if (result.result !== undefined) lines.push(result.result)
  if (result.messages) {
    lines.push(...(result.messages.length ? result.messages.map(logLine) : [emptyLog('log output')]))
  }
  if (result.png) {
    // Base64 down a pipe helps nobody; the command line's answer to a
    // screenshot is a file, so one gets written even when none was asked for.
    const file = path.resolve(process.cwd(), 'phone.png')
    writeFileSync(file, Buffer.from(result.png, 'base64'))
    lines.push(`wrote ${file}`)
  }
  if (result.path) lines.push(`wrote ${result.path}`)
  if (result.closed) lines.push(`closed ${result.closed}`)
  return `${lines.join('\n')}\n`
}

/** A failure that knows which device it happened on says so; most do not. */
function place(result) {
  return result.serial ? ` (on ${result.serial})` : ''
}
