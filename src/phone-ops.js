/**
 * The phone's command surface: one table, three consumers.
 *
 * The arrangement {@link ./browser-ops.js} and {@link ./miniapp-ops.js} use,
 * for the third screen this app can put in front of an agent.
 *
 * What is worth saying to a model here, and is said in the descriptions
 * rather than left to be found out:
 *
 *   - A ref is a coordinate with a name. Android has no stable handle on a
 *     view between one dump and the next, so a ref is where something was
 *     when the screen was last read — and a screen that has scrolled or
 *     animated has moved it. That is why every snapshot renumbers, and why
 *     tapping by coordinate is offered beside tapping by ref.
 *   - iOS devices can be looked at and not driven. Apple ships no supported
 *     way to inject a touch into the Simulator, so the verbs that act say
 *     which devices they work on.
 *   - Not every phone adb can reach is a simulator. A Google virtual device
 *     is one this app may start and tap on freely; a third-party emulator is
 *     one the user attached; a phone on a USB cable is somebody's actual
 *     telephone. `open` picks only the first kind on its own, and the others
 *     have to be named — which is a rule the descriptions state, because a
 *     model that does not know it will assume the list is a menu.
 *
 * Electron-free, and free of adb too: this file knows the vocabulary.
 */
import { parseArgs, toolSchemas } from './ops.js'

export { parseArgs }

/** How many log lines `logcat` returns by default. */
export const DEFAULT_LOG_LINES = 200
/** How long `open` waits for a cold emulator to finish booting. */
export const BOOT_TIMEOUT_MS = 180_000

/**
 * The keys worth naming, and what Android calls them.
 *
 * A table rather than passing keycodes through, because `KEYCODE_APP_SWITCH`
 * is not something to remember and `back` is.
 */
export const KEYS = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  recents: 'KEYCODE_APP_SWITCH',
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  delete: 'KEYCODE_DEL',
  escape: 'KEYCODE_ESCAPE',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  power: 'KEYCODE_POWER',
  volumeUp: 'KEYCODE_VOLUME_UP',
  volumeDown: 'KEYCODE_VOLUME_DOWN',
}

const ref = {
  type: 'string',
  description: 'A ref from the last `snapshot`, e.g. ref_3. Every snapshot renumbers them.',
}

/** @type {Record<string, import('./ops.js').Op>} */
export const OPS = {
  status: {
    summary: 'Whether a phone is running and what this machine could run. '
      + 'Says which of the missing pieces is missing, so the answer names one thing to do next.',
    params: {},
  },
  devices: {
    summary: 'What is here: Android virtual devices that could be started, anything adb is already talking to '
      + '(with what kind of thing it is), and iOS simulators when Xcode is installed.',
    params: {},
  },
  open: {
    summary: 'Start a phone and wait until it has finished booting, or attach to one already running. '
      + 'With nothing named, it uses a Google virtual device and never anything else — a third-party emulator '
      + 'or a real phone has to be named with serial, because neither is this app\'s to pick up uninvited.',
    params: {
      avd: { type: 'string', description: 'Android virtual device name from `devices`. Defaults to the only one, when there is one.' },
      serial: { type: 'string', description: 'Attach to something already in `devices` by its serial, e.g. 127.0.0.1:7555 or a phone\'s serial number.' },
      ios: { type: 'string', description: 'An iOS simulator name or udid instead. iOS can be looked at but not driven.' },
    },
    positional: ['avd'],
  },
  connect: {
    summary: 'Attach adb to an emulator listening on a port, e.g. 127.0.0.1:7555. '
      + 'Third-party emulators do not announce themselves the way Google\'s does; they wait to be connected to.',
    params: { address: { type: 'string', description: 'host:port, e.g. 127.0.0.1:16384.' } },
    required: ['address'],
    positional: ['address'],
  },
  scan: {
    summary: 'Knock on the ports the common third-party emulators use — MuMu, LDPlayer, Nox, BlueStacks, MEmu — '
      + 'and report what answered. Use when `devices` shows nothing but an emulator is plainly running.',
    params: {},
  },
  close: {
    summary: 'Shut down the phone. Only shuts down one this app started; one that was already running is left alone.',
    params: {},
  },

  snapshot: {
    summary: 'List what is on screen and can be acted on, each with a ref and the point it sits at. '
      + 'This is the way to see a screen before touching it. Read from the live accessibility tree, so it '
      + 'describes what is actually displayed, including text drawn by the app itself.',
    params: {},
  },
  tap: {
    summary: 'Tap the screen — either something the last snapshot named, or a point.',
    params: {
      ref,
      x: { type: 'integer', description: 'Instead of a ref: the point to tap.' },
      y: { type: 'integer', description: 'Instead of a ref: the point to tap.' },
    },
    positional: ['ref'],
  },
  input: {
    summary: 'Type text, into a field the last snapshot named or into whatever has focus. '
      + 'ASCII only — Android\'s input command cannot carry anything else, and this says so rather than typing nonsense.',
    params: { ref, text: { type: 'string', description: 'The text to type.' } },
    required: ['text'],
    positional: ['ref', 'text'],
  },
  key: {
    summary: `Press a hardware or navigation key: ${Object.keys(KEYS).join(', ')}.`,
    params: { name: { type: 'string', enum: Object.keys(KEYS), description: 'Which key.' } },
    required: ['name'],
    positional: ['name'],
  },
  swipe: {
    summary: 'Swipe between two points — how to scroll, and how to dismiss.',
    params: {
      from: { type: 'string', description: 'Start point as "x,y".' },
      to: { type: 'string', description: 'End point as "x,y".' },
      ms: { type: 'integer', description: 'How long the gesture takes (default 300). Longer is a drag, shorter is a fling.' },
    },
    required: ['from', 'to'],
    positional: ['from', 'to'],
  },
  screenshot: {
    summary: 'A picture of the phone screen.',
    params: { path: { type: 'string', description: 'Write a PNG here instead of returning it inline.' } },
    positional: ['path'],
  },

  install: {
    summary: 'Install an APK onto the running phone, replacing any earlier copy of it.',
    params: { apk: { type: 'string', description: 'Path to the .apk file.' } },
    required: ['apk'],
    positional: ['apk'],
  },
  launch: {
    summary: 'Start an installed app by its package name, e.g. com.example.app.',
    params: { package: { type: 'string', description: 'The package to launch.' } },
    required: ['package'],
    positional: ['package'],
  },
  logcat: {
    summary: 'Recent lines from the system log. Read this when a tap did nothing: an Android app '
      + 'reports its crashes and its own logging here and nowhere else.',
    params: {
      lines: { type: 'integer', description: `How many recent lines (default ${DEFAULT_LOG_LINES}).` },
      filter: { type: 'string', description: 'Keep only lines containing this, e.g. a package name.' },
    },
    positional: ['filter'],
  },
  shell: {
    summary: 'Run a command on the phone through adb. The escape hatch for anything the verbs above '
      + 'do not cover; prefer them when they do, because their answers are shaped for reading.',
    params: { command: { type: 'string', description: 'The command, e.g. "pm list packages -3".' } },
    required: ['command'],
    positional: ['command'],
  },
}

/** The tool list an MCP client receives. @returns {Array<object>} */
export function mcpTools() {
  return toolSchemas(OPS)
}

/**
 * One log line, trimmed to what a reader is looking for.
 *
 * logcat's own format leads with a date and a pair of process ids, which are
 * the same on every line of one session and push the message off the side of
 * anything narrow. The level and the tag are what distinguish one line from
 * another, so those are kept.
 *
 * @param {string} line @returns {string}
 */
export function logLine(line) {
  const found = /^\d[\d-]*\s+[\d:.]+\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]*):\s?(.*)$/.exec(line)
  return found ? `${found[1]} ${found[2].trim()}: ${found[3]}` : line
}

/** What an empty log says, so silence is never mistaken for a missing feature. */
export function emptyLog(kind) {
  return `(no ${kind})`
}
