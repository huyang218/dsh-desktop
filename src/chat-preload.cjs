/**
 * Preload for the window that hosts the dsh web UI.
 *
 * It exists for one thing: files dropped on the window. Without it a drop
 * the page does not handle makes Chromium navigate the window to the file —
 * the UI disappears and there is no back button, which is a poor answer to
 * a mis-aimed drag.
 *
 * The page gets first refusal. If the UI handled the drop (an image pasted
 * into a vision plugin, say) it will have called preventDefault, and this
 * does nothing at all; only an unclaimed drop becomes "send these paths to
 * the chat". Listening in the bubble phase is what makes that possible —
 * capture would take the drop before the page could ask for it.
 *
 * CommonJS because Electron sandboxed preloads do not load ESM.
 */
const { ipcRenderer, webUtils } = require('electron')

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
