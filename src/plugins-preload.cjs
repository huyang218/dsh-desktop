/**
 * Plugin-manager window preload: exposes the shell's plugin operations.
 * CommonJS because Electron sandboxed preloads do not load ESM.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshPlugins', {
  /** Lists installed plugins: [{ name, version, spec, active }]. */
  list: () => ipcRenderer.invoke('plugins:list'),
  /** Installs a plugin (npm name / github:spec / absolute local path). */
  install: spec => ipcRenderer.invoke('plugins:install', spec),
  /** Removes an installed plugin by package name. */
  remove: name => ipcRenderer.invoke('plugins:remove', name),
  /** Restarts the dsh server so config changes take effect. */
  restart: () => ipcRenderer.invoke('plugins:restart'),
  /** Reads a plugin's config form description: { rowId, fields, error? }. */
  configSchema: name => ipcRenderer.invoke('plugins:config-schema', name),
  /** Reads the values previously saved for a plugin: { [key]: value }. */
  configGet: name => ipcRenderer.invoke('plugins:config-get', name),
  /** Saves a plugin's config values into the profile patch layer. */
  configSet: (name, rowId, values) => ipcRenderer.invoke('plugins:config-set', name, rowId, values),
  /** Subscribes to streamed command output lines. */
  onLog: callback => ipcRenderer.on('plugins:log', (_event, line) => callback(line)),
  /**
   * The active language and its full message table.
   *
   * Fetched synchronously at preload time so the page can render its first
   * frame already translated: an async handshake would paint the markup's
   * placeholder text first and visibly swap it a moment later.
   */
  i18n: ipcRenderer.sendSync('i18n:strings'),
})
