/**
 * The install window's side of the wire.
 *
 * It receives; it does not ask. The install runs in the main process and
 * pushes what it knows — a step, a byte count, a line of output — so there is
 * nothing here for the page to poll and no state for it to own beyond what it
 * is drawing.
 *
 * The strings come synchronously, the way this app's other windows get
 * theirs: the page paints before any progress event has been sent, and a
 * window that says nothing until the first one is a window that looks broken.
 */
const { contextBridge, ipcRenderer } = require('electron')

const { locale, messages } = ipcRenderer.sendSync('i18n:strings') ?? { locale: 'en', messages: {} }

contextBridge.exposeInMainWorld('__dshPhoneInstall', {
  strings: {
    lang: locale ?? 'en',
    title: messages['dialog.phoneLicenceTitle'] ?? '',
    cancel: messages['button.cancel'] ?? '',
    close: messages['button.ok'] ?? '',
    cancelling: messages['phoneInstall.cancelling'] ?? '',
    remaining: messages['phoneInstall.remaining'] ?? '',
    stalled: messages['phoneInstall.stalled'] ?? '',
  },
  onState: handler => {
    ipcRenderer.on('phone-install:state', (_event, state) => {
      try {
        handler(state)
      } catch { /* a broken frame is not the installer's problem */ }
    })
  },
  cancel: () => ipcRenderer.send('phone-install:cancel'),
  close: () => ipcRenderer.send('phone-install:close'),
})
