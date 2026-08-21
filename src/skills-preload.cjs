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
  /**
   * Installs every skill a GitHub repository holds, or the one a /tree/ link
   * points into: { installed: [{name, dir}], skipped: [{where, code}] }.
   */
  installGitHub: input => ipcRenderer.invoke('skills:install-github', input),
  /** Which installed skills have moved on at their source: { [entry]: sha }. */
  checkUpdates: () => ipcRenderer.invoke('skills:check-updates'),
  /** Re-fetches one skill from the source it was installed from. */
  update: entry => ipcRenderer.invoke('skills:update', entry),
  /** The market catalog, filtered to skills; `force` skips the disk cache. */
  catalog: force => ipcRenderer.invoke('skills:catalog', force),
  /** The repositories this shell suggests: [{ repo, label }]. */
  recommended: () => ipcRenderer.invoke('skills:recommended'),
  /** What one repository holds, without downloading it: [{ subpath, files }]. */
  listRepo: repo => ipcRenderer.invoke('skills:list-repo', repo),
  /** Opens a catalog link in the user's browser. */
  openLink: url => ipcRenderer.invoke('skills:open-link', url),
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
