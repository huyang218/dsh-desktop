/**
 * The scripts the agent's browser runs inside a page.
 *
 * Everything here is source for somebody else's world, written as strings for
 * the same reason {@link ./send-to-chat.js insertionScript} is. The page is
 * whatever the agent navigated to — a local report, a dev server, a real
 * site — so none of it may assume a framework, a library, or that the DOM it
 * walked a moment ago is still there.
 *
 * The shape of the answer matters as much as the answer. A model driving a
 * browser needs a page it can address: not pixels, and not the whole DOM, but
 * a short list of the things a person could act on, each with a handle it can
 * pass back. That is what {@link snapshotScript} produces and what every
 * `ref_N` in this file refers to.
 *
 * Electron-free: these are strings, and the tests for them run in a page.
 */

import { DEFAULT_MAX_NODES } from './browser-ops.js'

/**
 * How much of a page one snapshot may describe.
 *
 * A bound, not a target. A search-results page has a few hundred addressable
 * things and a dashboard can have thousands; past some point the snapshot
 * stops being something a model can read and starts being something that
 * fills its context. Truncation is reported in the result, so the agent knows
 * it is looking at a prefix and can scroll or narrow instead of assuming it
 * has seen everything.
 */
const MAX_NODES = DEFAULT_MAX_NODES
/** Longest accessible name kept per node. */
const MAX_NAME = 160

/**
 * Collects the addressable elements of the page and names them.
 *
 * Refs live on the page as `window.__dshRefs`, an array whose index is the
 * ref number, and they are rebuilt by every snapshot. That is deliberate:
 * a ref is a handle on what the agent just looked at, and a page that has
 * navigated or re-rendered underneath it should invalidate its handles rather
 * than quietly resolve them to whatever now sits at the same index.
 *
 * Four options narrow it, for the pages where the whole list is not the
 * question. `ref` roots the walk at something the last snapshot named, so a
 * dialog can be read without the page behind it, and `within` does the same
 * from a CSS selector, for the containers a snapshot never names because they
 * cannot be clicked; `filter: 'interactive'`
 * drops the prose and keeps what can be acted on; `depth` stops the walk
 * going further down than asked; `max` raises or lowers the node bound. They
 * compose, and none of them changes what a node looks like once kept — a
 * narrowed snapshot is a subset of the wide one, not a different dialect.
 *
 * @param {{ref?: number, within?: string, filter?: string, depth?: number, max?: number}} [options]
 * @returns {string} source evaluating to
 *   `{url, title, truncated, nodes: string[]}`
 */
export function snapshotScript({ ref, within, filter, depth, max } = {}) {
  const rooted = Number.isInteger(ref)
  return `(() => {
    const MAX_NODES = ${Number.isInteger(max) && max > 0 ? max : MAX_NODES}, MAX_NAME = ${MAX_NAME};
    const ONLY_ACTIONABLE = ${filter === 'interactive'};
    const MAX_DEPTH = ${Number.isInteger(depth) && depth > 0 ? depth : 0};
    ${within ? `const root = document.querySelector(${JSON.stringify(String(within))});
    if (!root) return { url: location.href, title: document.title, truncated: false, nodes: [], error: 'no-match' };`
    : rooted ? `const previous = window.__dshRefs;
    if (!Array.isArray(previous)) return { url: location.href, title: document.title, truncated: false, nodes: [], error: 'no-snapshot' };
    const root = previous[${Number(ref)}];
    if (!root) return { url: location.href, title: document.title, truncated: false, nodes: [], error: 'unknown-ref' };
    if (!root.isConnected) return { url: location.href, title: document.title, truncated: false, nodes: [], error: 'stale-ref' };`
    : 'const root = document;'}
    // Depth is counted from the body rather than from the document, so that
    // "depth 1" means the top level of the page a person would point at, not
    // the two wrapper elements every document has.
    const depthRoot = root === document ? (document.body ?? document.documentElement) : root;
    const refs = [];
    window.__dshRefs = refs;

    const clip = text => {
      const flat = String(text ?? '').replace(/\\s+/g, ' ').trim();
      return flat.length > MAX_NAME ? flat.slice(0, MAX_NAME - 1) + '…' : flat;
    };

    // Visible in the sense that matters for driving: it occupies space and is
    // not hidden. Off-screen is still visible — a model may want to scroll to
    // it, and refusing to name it would make the page look shorter than it is.
    const shown = el => {
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    };

    /** The name a person would call this thing, in the order a screen reader would find it. */
    const nameOf = el => {
      const label = el.getAttribute?.('aria-label');
      if (label) return clip(label);
      const by = el.getAttribute?.('aria-labelledby');
      if (by) {
        const text = by.split(/\\s+/).map(id => document.getElementById(id)?.innerText ?? '').join(' ');
        if (text.trim()) return clip(text);
      }
      if (el.labels?.length) return clip([...el.labels].map(node => node.innerText).join(' '));
      for (const attribute of ['placeholder', 'alt', 'title', 'value', 'name']) {
        const value = el.getAttribute?.(attribute);
        if (value) return clip(value);
      }
      return clip(el.innerText ?? el.textContent ?? '');
    };

    /** What kind of thing this is, in the words the model already knows. */
    const roleOf = el => {
      const explicit = el.getAttribute?.('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return el.href ? 'link' : 'generic';
      if (tag === 'button') return 'button';
      if (tag === 'select') return 'combobox';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'summary') return 'disclosure';
      if (tag === 'img') return 'image';
      if (/^h[1-6]$/.test(tag)) return 'heading';
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') return type;
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
        if (type === 'hidden') return 'hidden';
        return 'textbox';
      }
      return 'text';
    };

    const INTERACTIVE = 'a,button,input,select,textarea,summary,[role],[onclick],[contenteditable],[tabindex]';
    const STRUCTURE = 'h1,h2,h3,h4,h5,h6,label,legend,caption,th,li,p,td,figcaption,img[alt]';
    // Elements that are only a container in general, and a value in
    // particular: <div id="count">3</div> is the thing a developer is
    // checking after a click, and a snapshot that omits it cannot answer
    // "did it work". Taken only when they hold text and nothing else, so a
    // wrapper div never joins the list.
    const LEAF = 'div,span,output,code,pre,strong,em,b,i,small,time,dd,dt';

    // Document order, so the list reads down the page the way the page reads.
    const candidates = [...root.querySelectorAll(INTERACTIVE + ',' + STRUCTURE + ',' + LEAF)];
    /** Steps from the root, for the depth bound. */
    const below = el => {
      let steps = 0;
      for (let node = el.parentElement; node && node !== depthRoot; node = node.parentElement) steps += 1;
      return steps + 1;
    };
    const nodes = [];
    // Text already reported, so that a <span> inside a described <p> is not
    // read out a second time.
    const spoken = new Set();
    let truncated = false;
    for (const el of candidates) {
      if (nodes.length >= MAX_NODES) { truncated = true; break; }
      const role = roleOf(el);
      if (role === 'hidden' || !shown(el)) continue;
      if (MAX_DEPTH && below(el) > MAX_DEPTH) continue;
      const actionable = el.matches(INTERACTIVE) && role !== 'text' && !el.disabled;
      if (ONLY_ACTIONABLE && !actionable) continue;
      if (!actionable) {
        if (el.matches(LEAF) && !el.matches(STRUCTURE) && el.children.length > 0) continue;
        let ancestor = el.parentElement;
        while (ancestor) {
          if (spoken.has(ancestor)) break;
          ancestor = ancestor.parentElement;
        }
        if (ancestor) continue;
      }
      const name = nameOf(el);
      // A paragraph with no words is furniture; a button with no name is
      // still a button, and hiding it would hide the way forward.
      if (!actionable && !name) continue;
      if (!actionable) spoken.add(el);

      let line = role;
      // The id of a value the page updates is how a developer asks about it
      // again, and how they recognise it here.
      if (!actionable && el.id) line += ' #' + el.id;
      if (name) line += ' "' + name.replace(/"/g, "'") + '"';
      if (actionable) {
        refs.push(el);
        line += ' [ref_' + (refs.length - 1) + ']';
      }
      // The three states a model has to be able to read before it acts.
      if (el.disabled) line += ' disabled';
      if (el.checked) line += ' checked';
      if (el.tagName === 'A' && el.href) line += ' -> ' + clip(el.getAttribute('href'));
      if ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.value) line += ' = "' + clip(el.value) + '"';
      nodes.push(line);
    }
    // Kept beside the refs, and rebuilt with them, so a later search runs
    // over the list the agent was actually shown rather than a fresh walk
    // that may have renumbered everything underneath it.
    window.__dshLines = nodes;
    return { url: location.href, title: document.title, truncated, nodes };
  })()`
}

/**
 * Searches the last snapshot for the thing the agent is looking for.
 *
 * Against the stored lines rather than the live DOM, because the answer has
 * to be a ref the agent can immediately use, and a ref only means anything
 * next to the snapshot that issued it. Every word has to appear somewhere in
 * the line — a weak rule, but the one a model's phrasing ("the blue submit
 * button") survives, where a substring match on the whole phrase would not.
 *
 * @param {string} query @returns {string}
 */
export function findScript(query) {
  return `(() => {
    const lines = window.__dshLines;
    if (!Array.isArray(lines)) return { ok: false, why: 'no-snapshot' };
    const words = ${JSON.stringify(String(query ?? ''))}.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { ok: false, why: 'no-query' };
    const hits = lines.filter(line => {
      const text = line.toLowerCase();
      return words.every(word => text.includes(word));
    });
    return { ok: true, hits };
  })()`
}

/**
 * Brings a ref into view without clicking it.
 *
 * `locate` already scrolls, but only as a side effect of aiming at something;
 * an agent that wants to see a section before deciding needs to ask for the
 * scroll on its own.
 *
 * @param {number} ref @returns {string}
 */
export function scrollToScript(ref) {
  return `(() => {
    const refs = window.__dshRefs;
    if (!Array.isArray(refs)) return { ok: false, why: 'no-snapshot' };
    const el = refs[${Number(ref)}];
    if (!el) return { ok: false, why: 'unknown-ref' };
    if (!el.isConnected) return { ok: false, why: 'stale-ref' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    return { ok: true };
  })()`
}

/**
 * Locates a ref for a click or a hover.
 *
 * Returns the point to aim at, in CSS pixels from the top left of the
 * viewport — which is also the coordinate space the window's input events
 * use, so the caller can hand it straight to the compositor rather than
 * dispatching a DOM event the page can tell apart from a person.
 *
 * It also reports what is actually at that point. An element covered by a
 * modal, a cookie banner, or its own tooltip is the single most common reason
 * an automated click does nothing, and "it did nothing" is the least useful
 * thing to tell an agent. Naming the thing on top lets it deal with the
 * banner instead of clicking harder.
 *
 * @param {number} ref @returns {string}
 */
export function locateScript(ref) {
  return `(() => {
    const refs = window.__dshRefs;
    if (!Array.isArray(refs)) return { ok: false, why: 'no-snapshot' };
    const el = refs[${Number(ref)}];
    if (!el) return { ok: false, why: 'unknown-ref' };
    if (!el.isConnected) return { ok: false, why: 'stale-ref' };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return { ok: false, why: 'not-visible' };
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    /** Enough of a selector for a person to find the thing in the page. */
    const describeNode = node => {
      let text = node.tagName.toLowerCase();
      if (node.id) text += '#' + node.id;
      else if (typeof node.className === 'string' && node.className.trim()) {
        text += '.' + node.className.trim().split(/\\s+/).slice(0, 2).join('.');
      }
      const label = (node.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 40);
      return label ? text + ' "' + label + '"' : text;
    };
    const top = document.elementFromPoint(x, y);
    const covered = top && top !== el && !el.contains(top) && !top.contains(el);
    return {
      ok: true, x, y,
      tag: el.tagName.toLowerCase(),
      focusable: typeof el.focus === 'function',
      ...(covered ? { coveredBy: describeNode(top) } : {}),
    };
  })()`
}

/**
 * Sets a select's value. The one control a click cannot drive: the popup a
 * native `<select>` opens belongs to the operating system, not to the page.
 *
 * @param {number} ref @param {string} value matched against value then label
 */
export function selectScript(ref, value) {
  return `(() => {
    const el = window.__dshRefs?.[${Number(ref)}];
    if (!el?.isConnected) return { ok: false, why: 'stale-ref' };
    if (el.tagName !== 'SELECT') return { ok: false, why: 'not-a-select' };
    const wanted = ${JSON.stringify(String(value))};
    const option = [...el.options].find(o => o.value === wanted)
      ?? [...el.options].find(o => o.text.trim() === wanted);
    if (!option) return { ok: false, why: 'no-such-option', options: [...el.options].map(o => o.value) };
    el.value = option.value;
    // Both events, in this order: a controlled component listens for one and
    // a form listens for the other, and a value set without them is a value
    // the page has not heard about.
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: option.value };
  })()`
}

/** Clears a text field before typing into it. @param {number} ref */
export function clearScript(ref) {
  return `(() => {
    const el = window.__dshRefs?.[${Number(ref)}];
    if (!el?.isConnected) return { ok: false, why: 'stale-ref' };
    const setter = Object.getOwnPropertyDescriptor(
      el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, ''); else el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { ok: true };
  })()`
}

/**
 * The page as text.
 *
 * `innerText` rather than a DOM walk: it is the browser's own answer to
 * "what does this page say", it respects display and visibility, and it is
 * the same text the user would select with the mouse.
 *
 * @param {number} max characters to keep
 */
export function textScript(max) {
  return `(() => {
    const source = document.querySelector('main, article') ?? document.body;
    const text = (source?.innerText ?? '').replace(/\\n{3,}/g, '\\n\\n').trim();
    const max = ${Number(max)};
    return { url: location.href, title: document.title,
      truncated: text.length > max, text: text.slice(0, max) };
  })()`
}

/**
 * Scrolls whatever is under the middle of the viewport.
 *
 * Not a wheel event: Electron's synthetic wheel reaches the compositor
 * inconsistently — often scrolling nothing at all — and a scroll that
 * silently does nothing is the worst possible answer to give an agent, which
 * will conclude the page has no more content. This finds the scroller a wheel
 * would have hit and moves it directly, then reports how far it actually
 * went, so "already at the bottom" and "did not work" stay distinguishable.
 *
 * @param {number} dx @param {number} dy
 */
export function scrollScript(dx, dy) {
  return `(() => {
    const scrollable = node => {
      if (!node || node.nodeType !== 1) return false;
      const style = getComputedStyle(node);
      const canY = /(auto|scroll|overlay)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 1;
      const canX = /(auto|scroll|overlay)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1;
      return canY || canX;
    };
    let node = document.elementFromPoint(Math.round(innerWidth / 2), Math.round(innerHeight / 2));
    while (node && node !== document.body && node !== document.documentElement && !scrollable(node)) {
      node = node.parentElement;
    }
    const target = scrollable(node) ? node : (document.scrollingElement ?? document.documentElement);
    const before = { x: target.scrollLeft, y: target.scrollTop };
    target.scrollBy(${Number(dx)}, ${Number(dy)});
    return {
      moved: (target.scrollTop - before.y) || (target.scrollLeft - before.x),
      y: target.scrollTop,
      atEnd: target.scrollTop + target.clientHeight >= target.scrollHeight - 1,
    };
  })()`
}

/**
 * Whether the page is showing something yet.
 *
 * Waiting is where browser automation is usually wrong: a fixed sleep is
 * either a stall or a race. The two conditions worth polling for are text
 * appearing and a selector matching, so those are the two this answers.
 *
 * @param {{text?: string, selector?: string}} condition
 */
export function waitScript({ text, selector }) {
  return `(() => {
    ${selector ? `if (document.querySelector(${JSON.stringify(selector)})) return true;` : ''}
    ${text ? `if ((document.body?.innerText ?? '').includes(${JSON.stringify(text)})) return true;` : ''}
    return false;
  })()`
}
