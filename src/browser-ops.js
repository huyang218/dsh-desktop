/**
 * The browser's command surface: one table, three consumers.
 *
 * The shell's own engine executes these verbs, the MCP server advertises them
 * to the model as tools, and `dsh-browser` parses them off a command line.
 * Keeping the table in one place is what stops those three from drifting —
 * a verb added here appears in all of them, spelled the same way, with the
 * same defaults.
 *
 * The descriptions are not decoration. They are what the model reads before
 * it chooses, so they say when to use a verb and not only what it does; the
 * difference between `snapshot` and `text` is the entire difference between
 * an agent that can click and one that can only read.
 *
 * Electron-free, and free of the socket too: this file knows the vocabulary,
 * not how it travels.
 */

import { parseArgs, toolSchemas } from './ops.js'

export { parseArgs }

/**
 * How many elements one snapshot may name.
 *
 * Here rather than beside the page script because the table quotes it in the
 * text the model reads before choosing `max`, and a bound documented as one
 * number and enforced as another is worse than no documentation.
 */
export const DEFAULT_MAX_NODES = 400
/** How much page text one `text` call returns by default. */
export const DEFAULT_TEXT_MAX = 20_000
/** How long `wait` polls before giving up. */
export const DEFAULT_WAIT_MS = 10_000

const page = { type: 'string', description: 'Page id from `pages`. Defaults to the one on screen.' }

/** @typedef {import('./ops.js').Op} Op */

/** @type {Record<string, Op>} */
export const OPS = {
  navigate: {
    summary: 'Open a URL or a local file path in the browser panel, and return a snapshot of what loaded.',
    params: { url: { type: 'string', description: 'An http(s) URL, or an absolute local file path.' }, page },
    required: ['url'],
    positional: ['url'],
  },
  back: { summary: 'Go back one entry in history.', params: { page } },
  forward: { summary: 'Go forward one entry in history.', params: { page } },
  reload: { summary: 'Reload the current page.', params: { page } },

  snapshot: {
    summary: 'List everything on the page that can be acted on, each with a ref to pass to click/type/select. '
      + 'This is the way to see a page before interacting with it. Every snapshot renumbers the refs, so use the '
      + 'ones it just returned and do not keep refs across another snapshot. '
      + 'Narrow a large page with within, ref, filter, depth or max rather than reading all of it.',
    params: {
      within: { type: 'string', description: 'CSS selector: describe only what is inside it, e.g. "#dialog".' },
      ref: { type: 'string', description: 'The same, rooted at something the last snapshot named.' },
      filter: { type: 'string', enum: ['all', 'interactive'], description: 'interactive drops the text and keeps what can be acted on.' },
      depth: { type: 'integer', description: 'Do not describe deeper than this many levels below the root.' },
      max: { type: 'integer', description: `Node bound for this call (default ${DEFAULT_MAX_NODES}).` },
      page,
    },
  },
  find: {
    summary: 'Search the last snapshot for elements matching words, and return the matching lines with their refs. '
      + 'Cheaper than re-reading a big page when you know what you are looking for.',
    params: { query: { type: 'string', description: 'Words that all appear in the line, e.g. "submit button".' }, page },
    required: ['query'],
    positional: ['query'],
  },
  text: {
    summary: 'Read the page as plain text. Use when the page is something to read rather than operate.',
    params: { max: { type: 'integer', description: `Characters to return (default ${DEFAULT_TEXT_MAX}).` }, page },
  },

  click: {
    summary: 'Click an element from the last snapshot, or a viewport coordinate. '
      + 'Reports what is on top when something covers the target.',
    params: {
      ref: { type: 'string', description: 'A ref from `snapshot`, e.g. "ref_12".' },
      x: { type: 'integer', description: 'Viewport x, when clicking without a ref.' },
      y: { type: 'integer', description: 'Viewport y, when clicking without a ref.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Default left.' },
      doubleClick: { type: 'boolean' },
      page,
    },
    positional: ['ref'],
  },
  hover: {
    summary: 'Move the pointer over an element, for menus and tooltips that open on hover.',
    params: { ref: { type: 'string' }, page },
    required: ['ref'],
    positional: ['ref'],
  },
  drag: {
    summary: 'Press at one place, move, and release at another — for sliders, reordering, and canvases. '
      + 'Drives pointer-based dragging; HTML5 native drag-and-drop belongs to the operating system and will not respond.',
    params: {
      ref: { type: 'string', description: 'Where the drag starts.' },
      toRef: { type: 'string', description: 'Where it ends.' },
      x: { type: 'integer' }, y: { type: 'integer' },
      toX: { type: 'integer' }, toY: { type: 'integer' },
      page,
    },
    positional: ['ref', 'toRef'],
  },
  type: {
    summary: 'Type text, into a ref when given and into whatever has focus otherwise.',
    params: {
      text: { type: 'string' },
      ref: { type: 'string', description: 'Field to focus first.' },
      clear: { type: 'boolean', description: 'Empty the field before typing.' },
      submit: { type: 'boolean', description: 'Press Enter afterwards.' },
      page,
    },
    required: ['text'],
    positional: ['ref', 'text'],
  },
  select: {
    summary: 'Choose an option in a <select>. A native select popup belongs to the OS, so clicking cannot drive it.',
    params: { ref: { type: 'string' }, value: { type: 'string', description: 'Option value, or its visible label.' }, page },
    required: ['ref', 'value'],
    positional: ['ref', 'value'],
  },
  key: {
    summary: 'Press a key: Enter, Tab, Escape, Backspace, ArrowDown, or a combination like "Control+a".',
    params: { name: { type: 'string' }, page },
    required: ['name'],
    positional: ['name'],
  },
  scroll: {
    summary: 'Scroll the page, by a direction, or to bring one element into view.',
    params: {
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      amount: { type: 'integer', description: 'Pixels; default one viewport.' },
      ref: { type: 'string', description: 'Scroll this element into view instead, without clicking it.' },
      page,
    },
    positional: ['direction'],
  },
  viewport: {
    summary: 'Resize the page, emulate a phone or tablet, or force a colour scheme. '
      + 'Use for layout that only breaks narrow, for hover menus that have no hover on touch, and for dark mode.',
    params: {
      preset: { type: 'string', enum: ['mobile', 'tablet', 'desktop'], description: 'Size, pixel ratio, touch and user agent together.' },
      width: { type: 'integer', description: 'A size of your own, instead of a preset.' },
      height: { type: 'integer' },
      mobile: { type: 'boolean', description: 'Touch input and a phone user agent, with a size of your own.' },
      colorScheme: { type: 'string', enum: ['dark', 'light', 'auto'], description: 'What prefers-color-scheme reports.' },
      reset: { type: 'boolean', description: 'Back to the panel size and the real user agent.' },
      page,
    },
    positional: ['preset'],
  },

  eval: {
    summary: 'Evaluate JavaScript in the page and return its result as JSON. '
      + 'For what the other verbs cannot express — not as a substitute for clicking, which real input does better.',
    params: { js: { type: 'string', description: 'An expression, or an async IIFE.' }, page },
    required: ['js'],
    positional: ['js'],
  },
  screenshot: {
    summary: 'Capture the page as a PNG. Use when the question is about layout or rendering; '
      + 'for reading or acting, `snapshot` says more in fewer tokens. '
      + 'Give x, y, width and height to capture one region closely instead of the whole page.',
    params: {
      path: { type: 'string', description: 'Write to this file instead of returning the image.' },
      x: { type: 'integer', description: 'Region left, in viewport pixels.' },
      y: { type: 'integer', description: 'Region top.' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      page,
    },
    positional: ['path'],
  },
  console: {
    summary: 'Recent console output from the page, newest last, with the file and line each came from.',
    params: {
      onlyErrors: { type: 'boolean', description: 'Errors alone, for when the page is noisy.' },
      pattern: { type: 'string', description: 'Keep messages matching this regular expression.' },
      limit: { type: 'integer', description: 'Keep only the last this many.' },
      page,
    },
  },
  network: {
    summary: 'Recent network requests from the page, with status codes and an id for each. '
      + 'JSON and failed responses come back with the start of what they returned, because a status code can say 200 '
      + 'over an error the page then chokes on. Use body with an id to read one in full.',
    params: {
      onlyErrors: { type: 'boolean', description: 'Only transport failures and status 400 and above.' },
      urlPattern: { type: 'string', description: 'Keep requests whose URL matches this regular expression.' },
      limit: { type: 'integer', description: 'Keep only the last this many.' },
      page,
    },
  },
  body: {
    summary: 'Read what one request returned, in full, as the page received it. '
      + 'Use this rather than fetching the URL again: a second request goes without the page\'s cookies, '
      + 'may not be idempotent, and is not the response that produced the behaviour you are looking at.',
    params: { requestId: { type: 'string', description: 'An id from `network`.' }, page },
    required: ['requestId'],
    positional: ['requestId'],
  },
  wait: {
    summary: 'Wait until text appears or a selector matches, then snapshot. Prefer this over sleeping.',
    params: {
      text: { type: 'string', description: 'Text to wait for anywhere on the page.' },
      selector: { type: 'string', description: 'CSS selector to wait for.' },
      ms: { type: 'integer', description: 'Wait this long instead, when there is nothing to poll for.' },
      timeoutMs: { type: 'integer', description: `Give up after this long (default ${DEFAULT_WAIT_MS}).` },
      page,
    },
  },

  pages: { summary: 'List open pages: id, title, url, and which one is on screen.', params: {} },
  newPage: {
    summary: 'Open another page. Background pages run without taking the panel, for work the user need not watch.',
    params: {
      url: { type: 'string' },
      background: { type: 'boolean', description: 'Do not bring it to the panel.' },
    },
    positional: ['url'],
  },
  show: {
    summary: 'Bring a page to the panel, where the user can see it.',
    params: { page: { type: 'string' } },
    required: ['page'],
    positional: ['page'],
  },
  closePage: {
    summary: 'Close one page.',
    params: { page: { type: 'string' } },
    required: ['page'],
    positional: ['page'],
  },
  close: { summary: 'Close the browser panel and every page in it.', params: {} },
}

/**
 * The tool list an MCP client receives.
 *
 * A wrapper rather than a re-export: everything here has exactly one
 * table to describe, and should not have to name it to say so.
 *
 * @returns {Array<object>}
 */
export function mcpTools() {
  return toolSchemas(OPS)
}

/**
 * One console entry as a line.
 *
 * Shared by the command line and the MCP server for the same reason the table
 * is: two places formatting one record are two places to fix when it grows a
 * field. The origin is dropped from the source — the host repeats on every
 * line and says nothing, while the path is what the agent has to go and edit.
 *
 * @param {{level: string, message: string, source?: string, line?: number}} entry
 * @returns {string}
 */
export function consoleLine(entry) {
  const where = shortSource(entry.source)
  const line = entry.line ? `:${entry.line}${entry.column ? `:${entry.column}` : ''}` : ''
  const at = where ? ` (${where}${line})` : ''
  // Indented under the message rather than joined onto it: a stack is read by
  // scanning the left edge for the first frame that belongs to the project,
  // and that only works if the frames line up.
  const stack = entry.stack?.length ? entry.stack.map(frame => `\n    at ${frame}`).join('') : ''
  return `[${entry.level}] ${entry.message}${at}${stack}`
}

/**
 * What an empty log looks like.
 *
 * A filter that matches nothing renders as no lines at all, and no lines is
 * how a tool reports "done" — so an agent asking whether anything failed
 * would read success as silence and silence as success. Named instead.
 */
export function emptyLog(kind) {
  return `no ${kind} matched`
}

/**
 * One request as a line, ending in the id that fetches its body.
 *
 * The id is last because it is the only part that is not read: it is copied
 * into the next call. A request still in flight has no status and says so
 * with a placeholder, which is often the answer on its own — the call that
 * never came back is the bug.
 */
export function networkLine(entry) {
  const outcome = entry.error ?? entry.status ?? 'pending'
  const size = Number.isFinite(entry.bytes) && entry.bytes > 0 ? ` ${bytes(entry.bytes)}` : ''
  const id = entry.id ? ` [${entry.id}]` : ''
  // Indented under the request, the way a stack sits under its error: the
  // list stays scannable, and the one line that answers the question is
  // already on screen instead of one call away.
  const preview = entry.preview ? `\n    ${entry.preview}` : ''
  return `${outcome} ${entry.method} ${entry.url}${size}${id}${preview}`
}

/** Bytes at the precision a reader wants, which is never all of the digits. */
function bytes(count) {
  if (count < 1024) return `${count}B`
  if (count < 1024 * 1024) return `${Math.round(count / 1024)}kB`
  return `${(count / (1024 * 1024)).toFixed(1)}MB`
}

/** A URL down to its path; anything that is not one, unchanged. */
export function shortSource(source) {
  if (!source) return ''
  const text = String(source)
  try {
    const url = new URL(text)
    return `${url.pathname}${url.search}` || text
  } catch {
    return text
  }
}

