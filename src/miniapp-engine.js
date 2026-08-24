/**
 * Executing the simulator's verbs.
 *
 * One session at a time, owned here. The panel, the agent's command line and
 * the model's tools are three ways of reaching the same running simulator,
 * for the same reason the browser has one browser: a session is a thing with
 * a lifetime and a page stack, and three of them would be three different
 * answers to "what is on screen".
 *
 * Two constraints from the DevTools shape everything below, and both were
 * found by trying:
 *
 * The `Page.*` and `Element.*` families do not answer — a call with a valid
 * page id hangs until it times out. So there is no `Element.tap` to call, and
 * interaction happens another way: the WXML names the handler each tap is
 * bound to, and {@link ./miniapp-connection.js} can run anything in the logic
 * layer. Tapping is therefore invoking the handler with a synthesised event.
 * That is not a real tap and this file says so where it matters — no
 * bubbling, no gesture, and a handler that reads anything but its event will
 * not notice the difference.
 *
 * The runtime's selectors match `#id`, `.class` and unions of those. Nothing
 * matches "everything", so nothing can enumerate a page. The structure comes
 * from source and the live values come from the app, and the join between
 * them is a single selector query that also carries back each rendered
 * element's own dataset — which is what makes a `wx:for` list addressable at
 * all, since its `data-id="{{item.id}}"` is an expression on disk and a value
 * on screen.
 *
 * Electron-free.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launch, ready } from './miniapp-connection.js'
import { readProject } from './miniapp-project.js'
import { DEFAULT_TEXT_MAX, DEFAULT_WAIT_MS, logLine } from './miniapp-ops.js'
import { findDevTools, quitDevTools } from './miniapp-tool.js'
import { addressable, scan } from './miniapp-wxml.js'

/** How many log entries are kept for `console` to return. */
const LOG_LIMIT = 500
/** How close together two identical lines have to be to be one line twice. */
const DEDUPE_MS = 1_000

/**
 * Creates the engine.
 *
 * @param {{log?: (line: string) => void}} [options]
 */
export function createEngine({ log } = {}) {
  /** @type {import('./miniapp-connection.js').Session | undefined} */
  let session
  /** @type {import('./miniapp-project.js').Project | undefined} */
  let project
  /** @type {object[]} */
  let logs = []
  /** @type {Map<string, object>} */
  let refs = new Map()

  const need = () => {
    if (!session || session.closed()) throw new Error('no simulator is open — run `open <project>` first')
    return session
  }

  /** Everything the app can run in the logic layer goes through here. */
  const evaluate = (source, args = []) =>
    need().send('App.callFunction', { functionDeclaration: source, args })
      .then(answer => answer?.result)

  const verbs = {
    async open({ project: dir, pure = true }, cwd) {
      const target = path.resolve(cwd || process.cwd(), String(dir ?? ''))
      const found = readProject(target)
      if (!found) {
        return fail(`${target} is not a mini program project`
          + ' — a project directory holds project.config.json beside the app entry it names')
      }
      const tool = findDevTools()
      if (!tool) return fail('the WeChat DevTools is not installed, or is somewhere this app does not look')

      if (session && !session.closed()) await session.close()
      logs = []
      refs = new Map()
      session = await launch({ tool, projectPath: found.dir, trust: true, pure, log })
      project = found
      await watchLogs(session)
      await ready(session)
      return { ok: true, project: found.name, appid: found.appid, ...await where() }
    },

    async status() {
      const tool = findDevTools()
      if (!tool) return { ok: true, state: 'missing', why: 'the WeChat DevTools is not installed' }
      if (!session || session.closed()) {
        return { ok: true, state: 'closed', version: tool.version, why: 'no simulator is open' }
      }
      return { ok: true, state: 'open', version: tool.version, project: project?.name, ...await where() }
    },

    async close() {
      if (!session || session.closed()) return { ok: true, closed: 'nothing was open' }
      // Only a DevTools this app started is quit. One the user already had
      // open holds their work, and we were borrowing it.
      const ours = session.ours
      await session.close()
      session = undefined
      project = undefined
      if (!ours) return { ok: true, closed: 'the session; the DevTools was already running and is left alone' }
      const gone = await quitDevTools(findDevTools())
      return { ok: true, closed: gone ? 'the simulator, and the DevTools with it' : 'the session; the DevTools would not quit' }
    },

    async pages() {
      const { pageStack } = await need().send('App.getPageStack')
      return { ok: true, pages: (pageStack ?? []).map(entry => ({ route: entry.route, query: entry.query })) }
    },

    async navigate({ url, mode = 'navigateTo' }) {
      if (mode !== 'back' && !url) return fail('navigate needs a url, unless mode is back')
      const method = mode === 'back' ? 'navigateBack' : mode
      const args = mode === 'back' ? [{}] : [{ url }]
      await need().send('App.callWxMethod', { method, args })
      await settle()
      return { ok: true, ...await where() }
    },

    async wait({ route, timeout = DEFAULT_WAIT_MS }) {
      const wanted = String(route).replace(/^\//, '')
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        const current = await need().send('App.getCurrentPage')
        if ((current?.route ?? '').replace(/^\//, '') === wanted) return { ok: true, ...await where() }
        await pause(200)
      }
      return fail(`${route} did not come to the top of the page stack within ${timeout}ms`, await where())
    },

    async snapshot({ max = DEFAULT_TEXT_MAX }) {
      const here = await where()
      const source = readWxml(project, here.route)
      if (source === undefined) {
        return fail(`no WXML on disk for ${here.route}`
          + ' — the route may come from a package this project does not contain', here)
      }
      const found = addressable(scan(source))
      const { live, data } = await queryLive(found)
      const { lines, table } = describe(found, live, data)
      refs = table
      const text = lines.join('\n')
      return {
        ok: true,
        ...here,
        elements: text.length > max ? `${text.slice(0, max)}\n… truncated` : text,
        count: table.size,
      }
    },

    async tap({ ref }) {
      const entry = refs.get(ref)
      if (!entry) return fail(`no such ref ${ref} — take a snapshot first; every snapshot renumbers them`)
      const handler = entry.handlers.tap
      if (!handler) return fail(`${ref} is a ${entry.tag} with nothing bound to tap`)
      await callHandler(handler, entry, { type: 'tap', detail: {} })
      await settle()
      return { ok: true, ran: handler, ...await where() }
    },

    async input({ ref, text }) {
      const entry = refs.get(ref)
      if (!entry) return fail(`no such ref ${ref} — take a snapshot first`)
      const handler = entry.handlers.input ?? entry.handlers.change
      if (!handler) {
        return fail(`${ref} is a ${entry.tag} with nothing bound to input`
          + ' — an input the app never reads cannot be filled in from here')
      }
      await callHandler(handler, entry, { type: 'input', detail: { value: String(text) } })
      await settle()
      return { ok: true, ran: handler, ...await where() }
    },

    async data({ path: key, value }) {
      if (value === undefined) {
        const result = await evaluate(READ_DATA, [key ?? null])
        return { ok: true, result: JSON.stringify(result, null, 2) }
      }
      let parsed
      try {
        parsed = JSON.parse(value)
      } catch {
        return fail(`value must be JSON; ${JSON.stringify(value)} is not`)
      }
      if (!key) return fail('writing needs a path, e.g. `data count 3`')
      await evaluate(WRITE_DATA, [key, parsed])
      await settle()
      return { ok: true, result: `set ${key}` }
    },

    async call({ method, args = '[]' }) {
      const parsed = parseJsonArray(args)
      if (parsed.error) return fail(parsed.error)
      const answer = await need().send('App.callWxMethod', { method, args: parsed.value })
      return { ok: true, result: JSON.stringify(answer?.result ?? answer, null, 2) }
    },

    async mock({ method, result }) {
      if (result === undefined) {
        await need().send('App.mockWxMethod', { method, functionDeclaration: '' })
        return { ok: true, result: `${method} restored` }
      }
      let parsed
      try {
        parsed = JSON.parse(result)
      } catch {
        return fail(`result must be JSON; ${JSON.stringify(result)} is not`)
      }
      await need().send('App.mockWxMethod', { method, result: parsed })
      return { ok: true, result: `${method} now returns ${result}` }
    },

    async eval({ source, args = '[]' }) {
      const parsed = parseJsonArray(args)
      if (parsed.error) return fail(parsed.error)
      const result = await evaluate(source, parsed.value)
      return { ok: true, result: JSON.stringify(result, null, 2) }
    },

    async screenshot({ path: file }, cwd) {
      const { data } = await need().send('App.captureScreenshot')
      if (!data) return fail('the simulator returned no image')
      if (!file) return { ok: true, png: data }
      const target = path.resolve(cwd || process.cwd(), file)
      writeFileSync(target, Buffer.from(data, 'base64'))
      return { ok: true, path: target }
    },

    async console({ max = 100 }) {
      need()
      return { ok: true, messages: logs.slice(-max) }
    },
  }

  /**
   * Starts collecting what the app says about itself.
   *
   * The log has to be switched on. A simulator reports thrown exceptions to
   * anyone listening but stays quiet about `console.log` until asked, so a
   * session that never asks sees an app that never logs — and `console` is
   * the verb an agent reaches for precisely when something did nothing, which
   * is the worst moment to hand back an empty list.
   *
   * @param {import('./miniapp-connection.js').Session} open
   */
  async function watchLogs(open) {
    // The simulator delivers every line twice — measured on the wire, both
    // copies identical, with nothing in either to say which channel it came
    // from. So the duplicate is dropped here, on the only evidence available:
    // the same level and the same text, arriving within a moment of each
    // other.
    //
    // The trade is stated rather than hidden. An app that really does log one
    // line twice inside {@link DEDUPE_MS} loses the second, and an agent
    // reading a doubled log is worse off than one missing a repeat: the
    // doubling is in every line and makes the whole log untrustworthy, while
    // the loss is rare and costs one line.
    /** @type {Map<string, number>} */
    const lately = new Map()
    const keep = entry => {
      const now = Date.now()
      const fingerprint = `${entry.level}\u0000${logLine(entry)}`
      const before = lately.get(fingerprint)
      if (before !== undefined && now - before < DEDUPE_MS) return
      lately.set(fingerprint, now)
      if (lately.size > LOG_LIMIT) {
        for (const [key, at] of lately) {
          if (now - at >= DEDUPE_MS) lately.delete(key)
        }
      }
      logs.push(entry)
      if (logs.length > LOG_LIMIT) logs = logs.slice(-LOG_LIMIT)
    }
    open.on('App.logAdded', params => keep({ level: params?.type ?? 'log', args: params?.args ?? [] }))
    open.on('App.exceptionThrown', params => keep({
      level: 'error',
      message: params?.message ?? params?.stack ?? JSON.stringify(params),
    }))
    // Subscribed first, switched on second, and that order is load-bearing:
    // reversed, every line arrives twice. Why is not known — the obvious
    // explanation, that switching it on replays a buffer into a listener
    // already in place, predicts the duplicates on this order rather than the
    // other one, so it is wrong. What is known is which order was measured
    // quiet, and this is it.
    //
    // Best effort otherwise: an older DevTools without the call is a session
    // with fewer logs, not a session that failed to open.
    await open.send('App.enableLog').catch(() => {})
  }

  /** Where the simulator is, in the two words every answer repeats. */
  async function where() {
    const current = await need().send('App.getCurrentPage')
    return { route: current?.route ?? '', query: current?.query ?? {} }
  }

  /**
   * Runs a page handler with an event built to look like the real one.
   *
   * The dataset is the live one when the snapshot could read it off the
   * rendered element, and the one written in the WXML otherwise. That
   * distinction is the whole reason a list is drivable: on disk every row
   * carries the same `{{item.id}}`, and on screen each row carries its own.
   */
  async function callHandler(handler, entry, event) {
    const target = { id: entry.id ?? '', dataset: entry.dataset ?? {}, offsetLeft: 0, offsetTop: 0 }
    await evaluate(CALL_HANDLER, [handler, { ...event, target, currentTarget: target, timeStamp: 0 }])
  }

  /** One selector query for the whole page, carrying geometry, datasets and data. */
  async function queryLive(found) {
    const selectors = [...new Set(found.map(item => item.selector).filter(Boolean))]
    const answer = await evaluate(QUERY, [selectors])
    const live = new Map()
    selectors.forEach((selector, index) => live.set(selector, answer?.rects?.[index] ?? []))
    return { live, data: answer?.data ?? {} }
  }

  return {
    /** @param {string} op @param {object} params @param {string} cwd */
    async run(op, params, cwd) {
      const verb = verbs[op]
      if (!verb) return fail(`no such command "${op}"`)
      try {
        return await verb(params ?? {}, cwd)
      } catch (error) {
        return fail(error?.message ?? String(error))
      }
    },
    /** For the app's own shutdown: let go without asking the user anything. */
    async dispose() {
      if (session && !session.closed()) await session.close({ shutTool: false })
      session = undefined
    },
  }
}

/**
 * Turns the scanned nodes and the live query into refs and lines.
 *
 * A ref names a rendered element wherever one could be matched, not a line of
 * source. A `wx:for` that produced six rows is six refs with six datasets;
 * the same six rows are one node on disk, and an agent told about one of them
 * could only ever tap the first.
 */
function describe(found, live, data) {
  const lines = []
  const table = new Map()
  let counter = 0
  const add = entry => {
    const name = `ref_${counter += 1}`
    table.set(name, entry)
    return name
  }

  for (const item of found) {
    const { node, selector, label, unmatchable } = item
    const matches = selector ? live.get(selector) ?? [] : []
    const bindings = Object.entries(node.handlers).map(([event, method]) => `${event}=${method}`).join(' ')

    if (selector && matches.length > 0) {
      matches.forEach((match, index) => {
        const shown = interpolate(label, data, node.loop, index)
        const name = add({
          tag: node.tag,
          handlers: node.handlers,
          dataset: { ...node.dataset, ...(match?.dataset ?? {}) },
          id: match?.id ?? node.attrs.id,
        })
        const nth = matches.length > 1 ? `[${index}]` : ''
        const size = match?.width !== undefined
          ? ` ${Math.round(match.width)}x${Math.round(match.height)}@${Math.round(match.left)},${Math.round(match.top)}`
          : ''
        lines.push(`${name} ${indent(node.depth)}${node.tag}${nth} ${quote(shown)} ${selector}${size}${bindings ? ` ${bindings}` : ''}`)
      })
      continue
    }

    // No selector, or a selector that matched nothing on screen. Still worth
    // a line when something is bound to it — the handler is callable even
    // though the element is not addressable — and worth saying why, because
    // "not in the list" and "in the list and unmatchable" are different
    // problems with different fixes.
    if (Object.keys(node.handlers).length === 0 && !selector) continue
    const name = add({ tag: node.tag, handlers: node.handlers, dataset: node.dataset, id: node.attrs.id })
    const why = selector ? `${selector} matched nothing on screen` : unmatchable
    lines.push(`${name} ${indent(node.depth)}${node.tag} ${quote(interpolate(label, data, node.loop, 0))} (${why})${bindings ? ` ${bindings}` : ''}`)
  }
  return { lines, table }
}

/**
 * Puts the app's own values into the text the source only described.
 *
 * A snapshot that reads `{{item.name}}` three times tells an agent that three
 * rows exist and nothing about which is which — the words are in the data,
 * and the data is right here. Only plain paths are resolved: an expression
 * with a ternary or a function call in it is left exactly as written, which
 * says truthfully that something goes here and this cannot say what.
 *
 * The loop's own names are in scope, resolved against the rendered position,
 * because that is the entire difference between three identical rows and
 * Alpha, Bravo and Charlie.
 */
function interpolate(text, data, loop, position) {
  return String(text ?? '').replace(/\{\{([\s\S]*?)\}\}/g, (whole, expression) => {
    const value = lookup(expression.trim(), data, loop, position)
    if (value === undefined) return whole
    return typeof value === 'string' ? value : JSON.stringify(value)
  })
}

function lookup(expression, data, loop, position) {
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(expression)) return undefined
  const parts = expression.split('.')
  let root = data
  if (loop && parts[0] === loop.index) return position
  if (loop && parts[0] === loop.item) {
    const list = lookup(loop.list, data, undefined, position)
    if (!Array.isArray(list)) return undefined
    root = list[position]
    parts.shift()
  }
  return parts.reduce((value, part) => (value == null ? undefined : value[part]), root)
}

const indent = depth => '  '.repeat(Math.min(depth, 8))
const quote = text => (text ? JSON.stringify(text) : '""')
const pause = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * A moment for the app to react before the answer is read.
 *
 * `setData` returns before the render layer has drawn, and every verb here
 * that changes something answers with where the app now is. Without this the
 * answer describes the app as it was, which is worse than slow.
 */
const settle = () => pause(150)

function fail(why, extra = {}) {
  return { ok: false, why, ...extra }
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text)
    if (!Array.isArray(value)) return { error: 'args must be a JSON array' }
    return { value }
  } catch {
    return { error: `args must be a JSON array; ${JSON.stringify(text)} is not` }
  }
}

/** @param {object} project @param {string} route @returns {string | undefined} */
function readWxml(project, route) {
  if (!project) return undefined
  const relative = String(route ?? '').replace(/^\//, '').replace(/\?.*$/, '')
  try {
    return readFileSync(path.join(project.dir, project.root, `${relative}.wxml`), 'utf8')
  } catch {
    return undefined
  }
}

// Source for the app's own world. Strings, like every other script this
// repository sends somewhere else, and written against nothing but the
// runtime globals every mini program has.

const CURRENT_PAGE = 'const stack = getCurrentPages(); const page = stack[stack.length - 1];'

const READ_DATA = `function(key){
  ${CURRENT_PAGE}
  if (!page) return null;
  if (!key) return page.data;
  return key.split('.').reduce((value, part) => (value == null ? value : value[part]), page.data);
}`

const WRITE_DATA = `function(key, value){
  ${CURRENT_PAGE}
  if (!page) return null;
  page.setData({ [key]: value });
  return true;
}`

const CALL_HANDLER = `function(name, event){
  ${CURRENT_PAGE}
  if (!page) throw new Error('no page is on screen');
  const handler = page[name];
  if (typeof handler !== 'function') throw new Error('the page has no method ' + name);
  return handler.call(page, event);
}`

/**
 * The page's data and every selector's matches, in one round trip.
 *
 * Two questions rather than one because they are asked together every time
 * and answered from the same instant. Fetched separately they can disagree —
 * a list that grew between the two calls leaves labels that name rows the
 * geometry does not have.
 */
const QUERY = `function(selectors){
  ${CURRENT_PAGE}
  const data = page ? page.data : {};
  return new Promise(function(resolve){
    if (selectors.length === 0) return resolve({ data: data, rects: [] });
    const query = wx.createSelectorQuery();
    selectors.forEach(function(selector){
      query.selectAll(selector).fields({ id: true, dataset: true, rect: true, size: true });
    });
    query.exec(function(result){ resolve({ data: data, rects: result }); });
  });
}`
