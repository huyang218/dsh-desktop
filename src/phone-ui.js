/**
 * Reading what is on a phone's screen.
 *
 * `uiautomator dump` hands back the accessibility tree as XML: every view,
 * with its class, its text, its resource id, whether it can be clicked, and
 * the rectangle it occupies. Which makes this the easy half of the job, and
 * worth saying out loud next to {@link ./miniapp-wxml.js}, where the same
 * question had to be answered by reading source off disk and joining it to a
 * selector query. Here the running system already knows, and says so.
 *
 * So the work is not discovery, it is selection: a screen has hundreds of
 * views and perhaps a dozen an agent could act on, and a snapshot that lists
 * every `FrameLayout` is a snapshot nobody can find the button in.
 *
 * Electron-free and dependency-free; exercised on strings.
 */

/** Classes whose whole purpose is to be typed into. */
const EDITABLE = /EditText|AutoCompleteTextView|SearchView/

/** Classes that are layout and never worth a line for their own sake. */
const STRUCTURAL = /Layout$|ViewGroup$|RecyclerView$|ScrollView$|ViewPager/

/**
 * @typedef {object} Node
 * @property {Record<string, string>} attrs as the dump wrote them
 * @property {number} depth
 * @property {string} label the text, or the description when there is no text
 * @property {string} kind the class's last segment, e.g. `Button`
 * @property {string} [id] the resource id without its package prefix
 * @property {{left: number, top: number, right: number, bottom: number}} [rect]
 * @property {boolean} clickable
 * @property {boolean} editable
 * @property {boolean} scrollable
 */

/**
 * Parses a `uiautomator dump`.
 *
 * Depth comes from a running count rather than a stack of names: every
 * element in this document is a `node`, so there is no mismatched tag to
 * recover from — an unbalanced dump is a broken dump, not a style of writing.
 *
 * @param {string} xml
 * @returns {Node[]} in document order
 */
export function parseDump(xml) {
  const text = String(xml ?? '')
  const nodes = []
  let depth = 0
  const TAG = /<(\/?)node\b((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g
  let match
  while ((match = TAG.exec(text)) !== null) {
    const [, closing, rawAttrs, selfClose] = match
    if (closing) { depth = Math.max(0, depth - 1); continue }
    const attrs = attributes(rawAttrs)
    nodes.push(describe(attrs, depth))
    if (!selfClose) depth += 1
  }
  return nodes
}

/** @param {string} raw @returns {Record<string, string>} */
function attributes(raw) {
  const attrs = {}
  const ATTR = /([\w:.-]+)\s*=\s*"([^"]*)"/g
  let match
  while ((match = ATTR.exec(raw ?? '')) !== null) attrs[match[1]] = decode(match[2])
  return attrs
}

/** The four entities `uiautomator` escapes, and no others. */
function decode(value) {
  return value
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** @param {Record<string, string>} attrs @param {number} depth @returns {Node} */
function describe(attrs, depth) {
  const className = attrs.class ?? ''
  return {
    attrs,
    depth,
    // Trimmed, so that a view whose entire text is a space counts as saying
    // nothing. Layouts are full of them as spacers, and each one listed is a
    // line an agent has to read and rule out.
    label: (attrs.text || attrs['content-desc'] || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    kind: className.split('.').pop() || 'View',
    id: shortId(attrs['resource-id']),
    rect: bounds(attrs.bounds),
    clickable: attrs.clickable === 'true' || attrs['long-clickable'] === 'true',
    editable: EDITABLE.test(className),
    scrollable: attrs.scrollable === 'true',
  }
}

/** `com.example.app:id/send_button` is `send_button` to everyone who reads it. */
function shortId(value) {
  if (!value) return undefined
  const slash = value.lastIndexOf('/')
  return slash === -1 ? value : value.slice(slash + 1)
}

/** `[0,128][1080,2337]` @returns {{left: number, top: number, right: number, bottom: number} | undefined} */
function bounds(value) {
  const found = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(value ?? '')
  if (!found) return undefined
  const [, left, top, right, bottom] = found.map(Number)
  return { left, top, right, bottom }
}

/**
 * Picks the views worth naming, and where to tap each one.
 *
 * A view earns a line by being actionable — clickable, typeable, scrollable —
 * or by carrying words somebody might be looking for. Structural containers
 * are dropped even when the toolkit marked them clickable, unless they say
 * something themselves: a `LinearLayout` with a click handler is usually a
 * row whose label lives in a child, and both being listed is one thing
 * described twice.
 *
 * A view with no rectangle is dropped whatever else it is. The only thing an
 * agent can do with a view here is tap where it is, and a view that is
 * nowhere cannot be tapped.
 *
 * @param {Node[]} nodes
 * @returns {Array<Node & {point: {x: number, y: number}}>}
 */
export function actionable(nodes) {
  const kept = []
  for (const [index, node] of nodes.entries()) {
    if (!node.rect || node.rect.right <= node.rect.left || node.rect.bottom <= node.rect.top) continue
    const acts = node.clickable || node.editable || node.scrollable
    const says = node.label !== ''
    if (!acts && !says) continue
    // A container that only acts, whose words are in a child that is also
    // listed, is the duplicate. Keep the container when the child is not
    // worth listing on its own — that is the tappable row with a plain label.
    if (acts && !says && STRUCTURAL.test(node.attrs.class ?? '') && speaksBelow(nodes, index)) continue
    kept.push({
      ...node,
      point: {
        x: Math.round((node.rect.left + node.rect.right) / 2),
        y: Math.round((node.rect.top + node.rect.bottom) / 2),
      },
    })
  }
  return kept
}

/** Whether something inside this node carries the words it does not. */
function speaksBelow(nodes, start) {
  for (let i = start + 1; i < nodes.length && nodes[i].depth > nodes[start].depth; i += 1) {
    if (nodes[i].label !== '') return true
  }
  return false
}

/**
 * One line per view, in the form the agent reads and answers with.
 *
 * The coordinate is in the line because it is the fallback: refs go stale the
 * moment the screen changes, and an agent that has just been told a button is
 * at 540,1200 can tap there without another round trip when it knows the
 * screen has not moved.
 *
 * @param {Array<Node & {point: {x: number, y: number}}>} views
 * @returns {{lines: string[], table: Map<string, object>}}
 */
export function describeScreen(views) {
  const lines = []
  const table = new Map()
  views.forEach((view, index) => {
    const name = `ref_${index + 1}`
    table.set(name, view)
    const marks = [
      view.editable ? 'input' : undefined,
      view.clickable ? 'tap' : undefined,
      view.scrollable ? 'scroll' : undefined,
      view.attrs.checked === 'true' ? 'checked' : undefined,
      view.attrs.enabled === 'false' ? 'disabled' : undefined,
      view.attrs.focused === 'true' ? 'focused' : undefined,
    ].filter(Boolean)
    lines.push([
      name,
      '  '.repeat(Math.min(view.depth, 8)) + view.kind,
      view.label ? JSON.stringify(view.label) : '""',
      view.id ? `#${view.id}` : '',
      `@${view.point.x},${view.point.y}`,
      marks.length ? marks.join(' ') : '',
    ].filter(Boolean).join(' '))
  })
  return { lines, table }
}
