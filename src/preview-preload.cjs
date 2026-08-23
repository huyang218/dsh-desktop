/**
 * Preload for the two pieces of shell furniture around a previewed page: the
 * strip above it, and the seam beside it. Not for the page — that one is
 * loaded into a view with no preload at all, which is the point: it is
 * somebody else's HTML, and it gets a browser, not an API.
 *
 * CommonJS because Electron sandboxed preloads do not load ESM.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshPreview', {
  back: () => ipcRenderer.send('preview:back'),
  forward: () => ipcRenderer.send('preview:forward'),
  reload: () => ipcRenderer.send('preview:reload'),
  /** Hands the current page to the real browser, for anyone who wants it there. */
  external: () => ipcRenderer.send('preview:external'),
  /** Closes the panel; the conversation gets the width back. */
  close: () => ipcRenderer.send('preview:close'),
  /** Goes where the address field says. */
  navigate: url => ipcRenderer.send('preview:navigate', url),
  /** Tabs: pick one, close one, open a blank one. */
  selectTab: page => ipcRenderer.send('preview:select-tab', page),
  closeTab: page => ipcRenderer.send('preview:close-tab', page),
  newTab: () => ipcRenderer.send('preview:new-tab'),
  /** Where the pointer is now, in screen coordinates, during a seam drag. */
  seam: screenX => ipcRenderer.send('preview:seam', screenX),
  /** The drag ended: this is the width worth remembering. */
  seamDone: () => ipcRenderer.send('preview:seam-done'),
  /** Navigation state, pushed on every change rather than polled. */
  onState: handler => ipcRenderer.on('preview:state', (_event, state) => handler(state)),
  i18n: ipcRenderer.sendSync('i18n:strings'),
})
