/**
 * The simulator's command surface: one table, three consumers.
 *
 * The same arrangement {@link ./browser-ops.js} uses, for the same reason —
 * the shell's engine executes these verbs, the MCP server advertises them to
 * the model, and `dsh-miniapp` parses them off a command line, and one table
 * is what stops those three from drifting.
 *
 * The descriptions are not decoration. They are what the model reads before
 * it chooses, so they carry the two things that are genuinely surprising
 * about driving a mini program rather than a web page:
 *
 *   - `data` and `call` reach further than tapping ever will. A mini program
 *     keeps its state somewhere addressable and its APIs somewhere callable,
 *     so an agent can put the app into the state it wants to look at instead
 *     of clicking its way there. There is no equivalent in a browser, and a
 *     model that has only driven browsers will not think to look for it.
 *   - selectors are not CSS. The mini program runtime matches `#id`, `.class`
 *     and unions of those, and nothing else — `view`, `button` and every
 *     other tag name match nothing at all. This is the runtime's rule, not
 *     ours, and a model that assumes otherwise gets an empty list rather than
 *     an error.
 *
 * Electron-free, and free of the socket too: this file knows the vocabulary,
 * not how it travels.
 */
import { parseArgs, toolSchemas } from './ops.js'

export { parseArgs }

/** How much page text or WXML one call returns by default. */
export const DEFAULT_TEXT_MAX = 20_000
/** How long `wait` polls before giving up. */
export const DEFAULT_WAIT_MS = 10_000

/**
 * Why almost everything here runs through the logic layer.
 *
 * The automation protocol has a `Page.*` family that looks like the obvious
 * way to read a page, and on the DevTools this was built against it does not
 * answer: a call with a valid page id hangs until it times out, while a call
 * with an invalid one refuses in eleven milliseconds — so the handler is
 * reachable and something behind it is not. `App.callFunction` runs arbitrary
 * code in the logic layer, awaits promises, and answers in single-digit
 * milliseconds, which makes it both the workaround and the better primitive:
 * one round trip for a question that `Page.*` would need several for.
 *
 * Recorded here rather than in a commit message because the next person to
 * read the protocol reference will have the same obvious idea.
 */
export const LOGIC_LAYER_NOTE = 'Page.* hangs on this DevTools; App.callFunction does not'

const ref = {
  type: 'string',
  description: 'A ref from the last `snapshot`, e.g. ref_3. Refs are renumbered by every snapshot.',
}

/** @type {Record<string, import('./ops.js').Op>} */
export const OPS = {
  open: {
    summary: 'Open a mini program project in the simulator and wait until it is running. '
      + 'Starts the WeChat DevTools if it is not already up. Answer with the page that appeared.',
    params: {
      project: { type: 'string', description: 'Project directory — the one holding project.config.json.' },
      pure: { type: 'boolean', description: 'Open the simulator only, without the editor around it. Default true.' },
    },
    required: ['project'],
    positional: ['project'],
  },
  status: {
    summary: 'Whether a simulator is running, which project it has open, and if it is not running, why not. '
      + 'Cheap; use it before assuming a failure means something is broken.',
    params: {},
  },
  close: {
    summary: 'Let go of the simulator. Quits the DevTools only if this app was the one that started it.',
    params: {},
  },

  pages: {
    summary: 'The page stack, innermost last, each with its route and query.',
    params: {},
  },
  navigate: {
    summary: 'Move between pages the way the app itself would.',
    params: {
      url: { type: 'string', description: 'Route to open, e.g. /pages/detail/detail?id=1. Omit for back.' },
      mode: {
        type: 'string',
        enum: ['navigateTo', 'redirectTo', 'reLaunch', 'switchTab', 'back'],
        description: 'Default navigateTo. switchTab for a tab bar page; reLaunch to clear the stack.',
      },
    },
    positional: ['url'],
  },

  snapshot: {
    summary: 'List what is on the page and can be acted on, each with a ref to pass to tap/input. '
      + 'Built from the page\'s WXML together with live geometry, so it describes the page as written '
      + 'and as currently laid out. This is the way to see a page before interacting with it.',
    params: {
      max: { type: 'integer', description: `Character bound on the answer (default ${DEFAULT_TEXT_MAX}).` },
    },
  },
  tap: {
    summary: 'Tap something the last snapshot named.',
    params: { ref },
    required: ['ref'],
    positional: ['ref'],
  },
  input: {
    summary: 'Put text into an input or textarea the last snapshot named.',
    params: { ref, text: { type: 'string', description: 'The text to enter.' } },
    required: ['ref', 'text'],
    positional: ['ref', 'text'],
  },

  data: {
    summary: 'Read or write the current page\'s data. Writing re-renders the page, so this is the '
      + 'direct way to put the app into a state worth looking at — far cheaper than tapping towards it, '
      + 'and it reaches states that tapping cannot produce at all.',
    params: {
      path: { type: 'string', description: 'Read one key instead of all of it, e.g. "list" or "user.name".' },
      value: { type: 'string', description: 'JSON to write at `path`. Omit to read.' },
    },
    positional: ['path', 'value'],
  },
  call: {
    summary: 'Call a wx.* API in the running app, e.g. wx.getStorage or wx.showToast. '
      + 'Use for anything the UI would reach through an API rather than a tap.',
    params: {
      method: { type: 'string', description: 'API name without the wx. prefix, e.g. getSystemInfoSync.' },
      args: { type: 'string', description: 'JSON array of arguments. Default [].' },
    },
    required: ['method'],
    positional: ['method', 'args'],
  },
  mock: {
    summary: 'Make a wx.* API return a fixed result, so a flow that needs login, payment or a network '
      + 'call can be exercised without one. Pass no result to put the real API back.',
    params: {
      method: { type: 'string', description: 'API name without the wx. prefix, e.g. login.' },
      result: { type: 'string', description: 'JSON the API should return. Omit to restore the real one.' },
    },
    required: ['method'],
    positional: ['method', 'result'],
  },
  eval: {
    summary: 'Run a function in the app\'s logic layer and return what it returns; promises are awaited. '
      + 'The escape hatch for anything the verbs above do not cover — getCurrentPages(), wx.*, and the '
      + 'app\'s own modules are all in scope.',
    params: {
      source: { type: 'string', description: 'A function expression, e.g. "function(){ return getCurrentPages().length }".' },
      args: { type: 'string', description: 'JSON array passed to the function. Default [].' },
    },
    required: ['source'],
    positional: ['source'],
  },

  screenshot: {
    summary: 'A picture of the simulator screen — the phone screen alone, without the DevTools around it.',
    params: { path: { type: 'string', description: 'Write a PNG here instead of returning it inline.' } },
    positional: ['path'],
  },
  console: {
    summary: 'What the app has logged, and anything it has thrown. Read this when a tap did nothing: '
      + 'a mini program reports most of its own failures here rather than by refusing a call.',
    params: { max: { type: 'integer', description: 'Most recent entries to return (default 100).' } },
  },
  wait: {
    summary: 'Wait until a route is on top of the page stack, for a navigation the app performs itself.',
    params: {
      route: { type: 'string', description: 'The route to wait for, e.g. /pages/detail/detail.' },
      timeout: { type: 'integer', description: `Milliseconds (default ${DEFAULT_WAIT_MS}).` },
    },
    required: ['route'],
    positional: ['route'],
  },
}

/**
 * The tool list an MCP client receives.
 *
 * @returns {Array<object>}
 */
export function mcpTools() {
  return toolSchemas(OPS)
}

/**
 * One log entry as a line.
 *
 * The mini program's own console, flattened the way the browser's is: level,
 * where it came from, then the message. A model reading this is looking for
 * the line that explains why nothing happened, so the level goes first.
 *
 * An argument that arrives as an empty object usually was not one. The
 * DevTools serialises what was logged before sending it, and an Error becomes
 * `{}` on the way — `console.error(new Error('...'))`, the most common way an
 * app reports a failure, arrives carrying nothing. That is a loss on their
 * side and cannot be recovered here, so it is named rather than printed: a
 * bare `{}` in a log reads as a bug in whoever printed it.
 *
 * @param {{level?: string, args?: any[], message?: string, route?: string}} entry
 * @returns {string}
 */
export function logLine(entry) {
  const level = (entry.level ?? 'log').padEnd(5)
  const where = entry.route ? ` ${entry.route}` : ''
  const text = entry.message ?? (entry.args ?? []).map(argument).join(' ')
  return `${level}${where} ${text}`.trimEnd()
}

/** @param {unknown} value @returns {string} */
function argument(value) {
  if (typeof value === 'string') return value
  const json = JSON.stringify(value)
  if (json === undefined) return String(value)
  return json === '{}' ? '[object — the DevTools sent no detail, an Error logged this way arrives empty]' : json
}

/** What an empty log says, so silence is never mistaken for a missing feature. */
export function emptyLog(kind) {
  return `(no ${kind}; the simulator has been running and has reported nothing)`
}
