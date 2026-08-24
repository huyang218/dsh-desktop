/**
 * `dsh-open` — the short way to put a page in front of the user.
 *
 * One verb, no flags: the agent that has just written a report and wants it
 * seen should not have to read a manual first. Everything past "show me this"
 * is `dsh-browser`.
 *
 * Not imported by the app. Run as a program, by the stub {@link ./open-bridge.js}
 * writes.
 */
import { call, resolveLocal } from './bridge-client.mjs'

const USAGE = 'usage: dsh-open <file-or-url>\n\n'
  + 'Opens an HTML page, SVG, PDF or image in the browser panel, beside the\n'
  + 'conversation. Also takes an http(s) URL. Relative paths resolve against\n'
  + 'the shell. To click, type or read the page afterwards, use dsh-browser.\n'

const target = process.argv[2]
if (target === undefined || target === '-h' || target === '--help') {
  process.stdout.write(USAGE)
  process.exit(target === undefined ? 2 : 0)
}

const result = await call('navigate', { url: resolveLocal(target) })
if (result.ok) {
  process.stdout.write(`opened ${result.url ?? target}${result.title ? ` — ${result.title}` : ''}\n`)
  process.exit(0)
}
process.stderr.write(`dsh-open: ${result.why ?? 'refused'}\n`)
process.exit(1)
