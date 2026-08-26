/**
 * Reading a page's WXML well enough to describe and drive it.
 *
 * The automation protocol offers no way to enumerate what is on a page. Its
 * `Page.*` family would have been the way and does not answer, and the
 * runtime's own selector engine cannot help either: it matches `#id`,
 * `.class` and unions of those, so there is no query that means "everything".
 *
 * But the page is written down. The project is on disk, the route names the
 * file, and the WXML says what the page contains and which handler each
 * interactive thing is bound to. So the structure is read from source and the
 * live values are asked of the running app — which is not a compromise: the
 * source is where the handler names are, and the handler names are what makes
 * this page driveable at all.
 *
 * A scanner, not a parser, and the distinction is load-bearing. It does not
 * evaluate `{{ }}`, does not expand `wx:for`, does not resolve imports or
 * templates, and does not build a tree it would then have to keep correct.
 * It finds tags, reads their attributes, and reports what it saw — including,
 * explicitly, where an attribute it needed turned out to be an expression it
 * cannot evaluate. A scanner that admits what it could not read is more
 * useful than a parser that guesses.
 *
 * Electron-free and dependency-free; exercised on strings.
 */

/** Tags whose presence alone makes a node worth naming. */
const INTERACTIVE = new Set([
  'button', 'input', 'textarea', 'switch', 'slider', 'picker', 'picker-view',
  'checkbox', 'radio', 'checkbox-group', 'radio-group', 'form', 'label',
  'navigator', 'swiper', 'scroll-view', 'movable-view', 'video', 'audio',
  'camera', 'map', 'canvas', 'editor', 'slot',
])

/** Tags that hold text rather than layout. */
const TEXTUAL = new Set(['text', 'rich-text'])

/** Tags that are structure only and never worth a line of their own. */
const INVISIBLE = new Set(['block', 'template', 'import', 'include', 'wxs', 'slot'])

/**
 * How an event binding is written, in every spelling the runtime accepts.
 *
 * `bindtap`, `bind:tap`, `catchtap`, `catch:tap`, and the capture forms —
 * they differ in whether the event keeps travelling, which matters to the app
 * and not at all to the question being asked here, which is only "what does
 * this run".
 */
const BINDING = /^(?:bind|catch|capture-bind|capture-catch)[:-]?([a-z]+)$/i

/** `{{ … }}` anywhere in a value makes it something only the app can resolve. */
const INTERPOLATED = /\{\{[\s\S]*?\}\}/

/**
 * @typedef {object} Node
 * @property {string} tag
 * @property {Record<string, string>} attrs as written, `{{ }}` and all
 * @property {number} depth nesting level, for indenting a description
 * @property {string} text immediate text content, as written
 * @property {Record<string, string>} handlers event name to method name
 * @property {Record<string, string>} dataset `data-*` attributes, keys camelCased
 * @property {Loop} [loop] the repeat this node is inside, when it is inside one
 */

/**
 * @typedef {object} Loop
 * @property {string} list the expression `wx:for` was given, e.g. `items`
 * @property {string} item what the loop calls each element, `item` unless said
 * @property {string} index what the loop calls the position, `index` unless said
 */

/**
 * Finds the nodes of a WXML document.
 *
 * @param {string} source
 * @returns {Node[]} in document order
 */
export function scan(source) {
  const text = String(source ?? '').replace(/<!--[\s\S]*?-->/g, '')
  /** @type {Node[]} */
  const nodes = []
  // A stack of what is open, rather than a depth counter and a repeat
  // counter. WXML tolerates an unclosed tag and authors write them, and a
  // counter that never comes back down leaves every later node indented under
  // something that ended long ago — while the stack simply unwinds to the tag
  // that did close. It carries the `wx:for` flag for the same reason: whether
  // a node repeats is a property of what encloses it.
  /** @type {{tag: string, loop: Loop | undefined}[]} */
  const open = []

  const TAG = /<(\/?)([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g
  let match
  while ((match = TAG.exec(text)) !== null) {
    const [whole, closing, tag, rawAttrs, selfClose] = match
    if (closing) {
      for (let i = open.length - 1; i >= 0; i -= 1) {
        if (open[i].tag === tag) { open.length = i; break }
      }
      continue
    }

    const attrs = attributes(rawAttrs)
    // A node inherits the innermost repeat it sits inside, and a node that
    // carries `wx:for` is inside its own.
    const own = loopOf(attrs)
    const loop = own ?? open.reduce((found, entry) => entry.loop ?? found, undefined)
    // Text is whatever sits between this tag and the next one. Enough for the
    // labels that make a snapshot readable, and deliberately not an attempt
    // to reconstruct the rendered string — the rendered string is in `data`,
    // which the engine reads from the running app.
    const after = match.index + whole.length
    const nextTag = text.indexOf('<', after)

    nodes.push({
      tag,
      attrs,
      depth: open.length,
      text: text.slice(after, nextTag === -1 ? undefined : nextTag).trim(),
      handlers: handlersOf(attrs),
      dataset: datasetOf(attrs),
      loop,
    })

    if (!selfClose && !VOID.has(tag)) open.push({ tag, loop: own })
  }
  return nodes
}

/**
 * The repeat a tag declares, if it declares one.
 *
 * `wx:for="{{items}}"` with an optional `wx:for-item` renaming the element.
 * The braces come off because what is wanted is the path into the page's
 * data, not the expression that reads it.
 *
 * @param {Record<string, string>} attrs @returns {Loop | undefined}
 */
function loopOf(attrs) {
  const raw = attrs['wx:for']
  if (raw === undefined) return undefined
  const list = raw.replace(/^\s*\{\{\s*/, '').replace(/\s*\}\}\s*$/, '').trim()
  return {
    list,
    item: attrs['wx:for-item']?.trim() || 'item',
    index: attrs['wx:for-index']?.trim() || 'index',
  }
}

/** Tags the runtime treats as empty even without a closing slash. */
const VOID = new Set(['input', 'image', 'import', 'include', 'wxs'])

/**
 * Splits a tag's attribute text.
 *
 * Values may be quoted either way and may be absent entirely — `disabled`
 * with no value is how the runtime is told `true`, so that is what it becomes
 * here rather than an empty string that later reads as false.
 *
 * @param {string} raw @returns {Record<string, string>}
 */
function attributes(raw) {
  /** @type {Record<string, string>} */
  const attrs = {}
  const ATTR = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let match
  while ((match = ATTR.exec(raw ?? '')) !== null) {
    const [, name, doubled, singled, bare] = match
    attrs[name] = doubled ?? singled ?? bare ?? 'true'
  }
  return attrs
}

/** @param {Record<string, string>} attrs @returns {Record<string, string>} */
function handlersOf(attrs) {
  /** @type {Record<string, string>} */
  const handlers = {}
  for (const [name, value] of Object.entries(attrs)) {
    const event = BINDING.exec(name)?.[1]
    if (event && value) handlers[event.toLowerCase()] = value
  }
  return handlers
}

/**
 * `data-item-id="3"` reaches a handler as `event.currentTarget.dataset.itemId`.
 *
 * The camel-casing is the runtime's, and reproducing it here is what lets a
 * synthesised event carry a dataset the handler will actually recognise.
 *
 * @param {Record<string, string>} attrs @returns {Record<string, string>}
 */
function datasetOf(attrs) {
  /** @type {Record<string, string>} */
  const dataset = {}
  for (const [name, value] of Object.entries(attrs)) {
    if (!name.startsWith('data-')) continue
    const key = name.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    dataset[key] = value
  }
  return dataset
}

/**
 * @typedef {object} Addressable
 * @property {Node} node
 * @property {string} label what to show for it
 * @property {string} [selector] a selector the runtime will actually match
 * @property {string} [unmatchable] why there is no selector, when there is none
 */

/**
 * Picks out the nodes worth putting in a snapshot, and works out how to
 * address each one.
 *
 * A node earns a line by being interactive, by carrying a handler, or by
 * being text somebody might want to read. Everything else is layout, and a
 * snapshot full of `view` is a snapshot nobody can find anything in.
 *
 * Addressing is where the runtime's selector rule bites. `#id` works, `.class`
 * works, tag names match nothing — so a node with neither an id nor a class
 * has no selector at all, and saying so is more useful than inventing one
 * that will silently match nothing. It can still be driven: its handler is
 * named in the source, and calling that is what {@link ./miniapp-engine.js}
 * does.
 *
 * @param {Node[]} nodes
 * @returns {Addressable[]}
 */
export function addressable(nodes) {
  const out = []
  for (const [index, node] of nodes.entries()) {
    if (INVISIBLE.has(node.tag)) continue
    const interesting = INTERACTIVE.has(node.tag)
      || Object.keys(node.handlers).length > 0
      || (TEXTUAL.has(node.tag) && node.text !== '')
    if (!interesting) continue
    out.push({ node, label: label(node) || inner(nodes, index), ...address(node) })
  }
  return out
}

/**
 * The text of everything inside a node.
 *
 * A tappable row usually says nothing itself — its words are in the `<text>`
 * it wraps. Without this, a list of six rows is six identical blank lines,
 * which tells an agent that six things exist and nothing about which is
 * which.
 *
 * @param {Node[]} nodes the whole document, in order
 * @param {number} start index of the node whose contents are wanted
 * @returns {string}
 */
function inner(nodes, start) {
  const parts = []
  for (let i = start + 1; i < nodes.length && nodes[i].depth > nodes[start].depth; i += 1) {
    if (nodes[i].text) parts.push(nodes[i].text)
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 80)
}

/** @param {Node} node @returns {{selector?: string, unmatchable?: string}} */
function address(node) {
  const id = node.attrs.id
  if (id && !INTERPOLATED.test(id)) return { selector: `#${id}` }
  const className = node.attrs.class
  if (className && !INTERPOLATED.test(className)) {
    const first = className.trim().split(/\s+/).filter(Boolean)[0]
    if (first) return { selector: `.${first}` }
  }
  if (id || className) return { unmatchable: 'its id and class are expressions this cannot evaluate' }
  return { unmatchable: 'it has no id or class, and the runtime matches nothing else' }
}

/** A short human-facing description: the text, else a telling attribute. */
function label(node) {
  const candidates = [node.text, node.attrs.placeholder, node.attrs.value, node.attrs.src]
  const found = candidates.find(value => value && value.trim() !== '')
  return (found ?? '').replace(/\s+/g, ' ').slice(0, 80)
}
