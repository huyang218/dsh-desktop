/**
 * Settings-window preload. CommonJS because Electron sandboxed preloads do
 * not load ESM; the plugin window's preload has the same shape.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshSettings', {
  /** The stored proxy setting, plus what the environment already carries. */
  getProxy: () => ipcRenderer.invoke('settings:get-proxy'),
  /** Saves and applies a proxy setting: { mode, url, bypass }. */
  setProxy: proxy => ipcRenderer.invoke('settings:set-proxy', proxy),
  /**
   * Tries the two networks the app actually uses with the settings as they
   * are on screen, without saving them.
   * @returns {Promise<Array<{name: string, ok: boolean, detail: string}>>}
   */
  testProxy: proxy => ipcRenderer.invoke('settings:test-proxy', proxy),
  /** Strings, fetched synchronously so the first frame is already translated. */
  i18n: ipcRenderer.sendSync('i18n:strings'),
})
