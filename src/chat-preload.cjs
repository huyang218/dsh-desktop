/**
 * Preload for the window that hosts the dsh web UI.
 *
 * Three things, all of them about the window rather than about dsh: files
 * dropped on it, the view state its origin would otherwise lose, and the one
 * channel the page has into the shell.
 *
 * Drops first. Without this a drop the page does not handle makes Chromium
 * navigate the window to the file — the UI disappears and there is no back
 * button, which is a poor answer to a mis-aimed drag.
 *
 * The page gets first refusal. If the UI handled the drop (an image pasted
 * into a vision plugin, say) it will have called preventDefault, and this
 * does nothing at all; only an unclaimed drop becomes "send these paths to
 * the chat". Listening in the bubble phase is what makes that possible —
 * capture would take the drop before the page could ask for it.
 *
 * CommonJS because Electron sandboxed preloads do not load ESM.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron')

window.addEventListener('dragover', event => {
  // Without this the drop event never fires and Chromium opens the file.
  event.preventDefault()
}, false)

window.addEventListener('drop', event => {
  if (event.defaultPrevented) return
  event.preventDefault()
  const files = [...(event.dataTransfer?.files ?? [])]
  if (files.length === 0) return
  // File.path was removed from the renderer; webUtils is the supported way
  // to learn where a dropped file actually is.
  const paths = files.map(file => webUtils.getPathForFile(file)).filter(Boolean)
  if (paths.length > 0) ipcRenderer.send('chat:files-dropped', paths)
}, false)

/**
 * Carrying the page's own storage across a change of port.
 *
 * The UI keeps its view state — how the session list is grouped, sorted and
 * expanded, which session was open, when each was last touched — in
 * localStorage, which the browser partitions by origin. The origin is
 * `http://127.0.0.1:<port>`, and the port is not guaranteed: it is reused when
 * free and replaced when something else has taken it. Every replacement was
 * therefore a fresh, empty origin, with the previous one left behind holding
 * state nobody would read again; one install had accumulated forty-one.
 *
 * So the shell keeps a copy and hands it back. It never interprets what it
 * carries — no key is named here, nothing is migrated or upgraded — which is
 * what keeps this working when the UI changes its own storage: a rename
 * upstream moves a string this file has no opinion about.
 *
 * Restoring only fills keys the page does not already have, so a live origin
 * is never overwritten by an older snapshot, and the page's own writes always
 * win.
 */
const SNAPSHOT_EVERY_MS = 20_000
/** Well past what view state needs; a page storing more than this is doing something else. */
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

function readLocalStorage() {
  const data = {}
  let bytes = 0
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    const value = localStorage.getItem(key)
    if (key === null || value === null) continue
    bytes += key.length + value.length
    if (bytes > MAX_SNAPSHOT_BYTES) return data
    data[key] = value
  }
  return data
}

// Before the page's own scripts run, so the UI boots with its state already
// in place rather than reading an empty store and writing its defaults over
// what was about to be restored.
try {
  const saved = ipcRenderer.sendSync('ui-state:load')
  if (saved && saved.origin !== location.origin && saved.data) {
    for (const [key, value] of Object.entries(saved.data)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value)
    }
  }
} catch { /* a shell without the channel is simply one that carries nothing */ }

let lastSaved = ''
function saveLocalStorage() {
  try {
    const data = readLocalStorage()
    const serialised = JSON.stringify(data)
    // Only when it changed: this runs on a timer for as long as the window is
    // open, and rewriting an identical file every twenty seconds is wear for
    // nothing.
    if (serialised === lastSaved) return
    lastSaved = serialised
    ipcRenderer.send('ui-state:save', { origin: location.origin, data })
  } catch { /* nothing to carry */ }
}

setInterval(saveLocalStorage, SNAPSHOT_EVERY_MS)
// pagehide rather than unload: it fires on the paths that actually happen
// here — the window closing, and the app quitting under it.
window.addEventListener('pagehide', saveLocalStorage)

/**
 * The one thing the page may ask the shell for: show this file in the preview
 * window.
 *
 * Narrow on purpose. It takes a path and returns whether the shell took it —
 * no listing, no reading, no arbitrary URLs beyond what the main process
 * itself vets, and nothing that answers a question the page could not already
 * answer by asking dsh. The wrapper in src/preview.js is the only caller;
 * see there for why the interception has to happen in the page's own world.
 */
contextBridge.exposeInMainWorld('__dshDesktop', {
  openPreview: target => ipcRenderer.invoke('preview:open', String(target)),
})
