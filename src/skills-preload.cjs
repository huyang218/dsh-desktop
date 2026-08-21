/**
 * Skills-manager window preload: exposes the shell's skill operations.
 * CommonJS because Electron sandboxed preloads do not load ESM.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('dshSkills', {
  /**
   * Every skill the shell can see, across the roots it knows about:
   * [{ entry, source, writable, enabled, name, description, problems }].
   * A non-empty `problems` with a fatal entry is a skill dsh is ignoring.
   */
  list: () => ipcRenderer.invoke('skills:list'),
  /** Opens a folder picker for a skill; resolves to a path or null. */
  pickDirectory: () => ipcRenderer.invoke('skills:pick-directory'),
  /** Opens a file picker for a skill zip; resolves to a path or null. */
  pickZip: () => ipcRenderer.invoke('skills:pick-zip'),
  /** Copies a skill folder — or a lone .md — into the user's skill root. */
  installDirectory: source => ipcRenderer.invoke('skills:install-directory', source),
  /** Unpacks a skill zip into the user's skill root. */
  installZip: zipPath => ipcRenderer.invoke('skills:install-zip', zipPath),
  /** Switches an installed skill off or back on, without removing it. */
  setEnabled: (entry, enabled) => ipcRenderer.invoke('skills:set-enabled', entry, enabled),
  /** Deletes an installed skill and everything in its directory. */
  remove: entry => ipcRenderer.invoke('skills:remove', entry),
  /** Reveals a skill's directory — or the root itself — in the file manager. */
  reveal: entry => ipcRenderer.invoke('skills:reveal', entry),
  /** Subscribes to streamed operation output lines. */
  onLog: callback => ipcRenderer.on('skills:log', (_event, line) => callback(line)),
  /**
   * The active language and its full message table.
   *
   * Fetched synchronously at preload time so the page can render its first
   * frame already translated, the same as the plugin window: an async
   * handshake would paint the markup's placeholder text and swap it.
   */
  i18n: ipcRenderer.sendSync('i18n:strings'),
})
