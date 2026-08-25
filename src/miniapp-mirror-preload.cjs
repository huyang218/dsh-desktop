/**
 * The mirror window's side of the wire.
 *
 * It receives frames and sends taps — nothing else. The frames are pushed by
 * the main process on its own clock; the taps are the one thing this window
 * originates, a point in the phone's own coordinates that the page has
 * already mapped out of its scaled image.
 */
const { contextBridge, ipcRenderer } = require('electron')

const { locale, messages } = ipcRenderer.sendSync('i18n:strings') ?? { locale: 'en', messages: {} }

contextBridge.exposeInMainWorld('__dshMirror', {
  strings: { lang: locale, hint: messages['mirror.hint'] ?? '' },
  onFrame: handler => {
    ipcRenderer.on('miniapp-mirror:frame', (_event, frame) => {
      try {
        handler(frame)
      } catch { /* a dropped frame is not worth a crash */ }
    })
  },
  tap: (x, y) => ipcRenderer.send('miniapp-mirror:tap', { x, y }),
})
