/**
 * Performance badge preload: one way in, one way out.
 *
 * The badge reads and does not act, so it is handed a subscription and a
 * close, and nothing else. CommonJS because Electron sandboxed preloads do
 * not load ESM.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshHud', {
  /** Receives each reading: { cpu, rssBytes, threads, processes, running }. */
  onSample: callback => ipcRenderer.on('hud:sample', (_event, reading) => callback(reading)),
  /** Closes the badge, which also stops the sampling behind it. */
  close: () => ipcRenderer.send('hud:close'),
  /** The active language and its messages, in time for the first frame. */
  i18n: ipcRenderer.sendSync('i18n:strings'),
})
