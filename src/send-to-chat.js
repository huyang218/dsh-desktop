/**
 * Sending files from the desktop into the chat.
 *
 * The web UI is not ours: it is served by the dsh runtime and rendered by
 * client plugins, and its markup is free to change under us — the composer's
 * class name is a build hash. So this does the least that can work and
 * checks that it worked: find the composer by shape rather than by name, put
 * the paths in through the setter React actually listens to, then read the
 * value back. When the read-back disagrees — the composer was read-only
 * because no workspace is open, the page changed, a future UI has no
 * textarea at all — the paths go to the clipboard instead and the user is
 * told to paste. The feature degrades to "one keystroke away" rather than to
 * silence.
 *
 * What gets sent is the path, not the bytes. dsh is an agent with filesystem
 * tools: a path is the thing it can act on, and the thing that stays true for
 * a file too large to paste.
 *
 * Deliberately free of Electron imports; the caller supplies the page.
 */

/** Quoting rule: a path with spaces is one argument, not several words. */
export function formatPaths(paths) {
  return paths
    // Mapped to a string only after the empties are gone: String(null) is
    // "null", which is very much not an empty string.
    .map(entry => (entry === null || entry === undefined ? '' : String(entry).trim()))
    .filter(Boolean)
    .map(entry => (/\s/.test(entry) ? `"${entry.replace(/"/g, '\\"')}"` : entry))
    .join('\n')
}

/**
 * The script that puts text into the composer, evaluated in the page.
 *
 * Written as a string because it runs in the UI's world, not ours. It
 * returns what it did, so the caller can tell insertion from failure rather
 * than assuming.
 *
 * @param {string} text already formatted paths
 * @returns {string} an expression evaluating to {ok, why?}
 */
export function insertionScript(text) {
  return `(() => {
    const payload = ${JSON.stringify(text)};
    // The composer by shape: the widest visible textarea on the page. Class
    // names here are build hashes and change with every UI release.
    const box = [...document.querySelectorAll('textarea')]
      .filter(el => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !el.disabled && !el.readOnly;
      })
      .sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
    if (!box) return { ok: false, why: 'no-composer' };

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    const before = box.value;
    const separator = before === '' || before.endsWith('\\n') ? '' : '\\n';
    setter.call(box, before + separator + payload + ' ');
    // The event a controlled React input listens for; without it the value is
    // reverted on the next render.
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    // Read back rather than trust: a controlled component that ignored the
    // event has already put the old value back by now.
    return box.value.includes(payload) ? { ok: true } : { ok: false, why: 'reverted' };
  })()`
}

/**
 * Collects file paths out of a command line.
 *
 * This is how Windows delivers a "Send to" selection: the shortcut starts
 * the app again with the files as arguments, and the running instance is
 * handed that argv. Switches and the executable itself are not files.
 *
 * @param {string[]} argv @param {(path: string) => boolean} exists
 */
export function pathsFromArgv(argv, exists) {
  return argv
    .slice(1)
    .filter(argument => typeof argument === 'string' && !argument.startsWith('-'))
    .filter(argument => exists(argument))
}
