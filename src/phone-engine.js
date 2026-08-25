/**
 * Executing the phone's verbs.
 *
 * One device at a time, owned here, the way the browser and the simulator
 * are. Everything reaches the phone through `adb`, which is the supported
 * channel and the only one that needs nothing installed on the device.
 *
 * The interesting decision in this file is how a tap finds its target.
 *
 * `adb shell input tap x y` takes a point, and a point is the thing that goes
 * wrong: between reading the screen and touching it, a list can scroll, an
 * animation can land, a dialog can appear, and the coordinate that named a
 * button now names whatever moved into its place. Tapping the wrong thing is
 * worse than failing to tap, because the agent is told it succeeded.
 *
 * There is a channel without that problem — UiAutomator2 or Appium, where an
 * element is found and clicked as an element — and it costs a server process
 * and an APK on the device, which is a dependency of exactly the kind this
 * app does not take.
 *
 * So the coordinate is kept and the staleness is removed: a ref remembers
 * what the view *was* — its resource id, its text, its class, its position
 * among identical siblings — and every action re-reads the screen and finds
 * that view again before touching it. The tap lands on where the view is now,
 * a few hundred milliseconds old instead of however long the agent spent
 * thinking. A view that is no longer there is reported as gone rather than
 * approximated, which is the whole point: the failure is visible.
 *
 * Electron-free.
 */
import { execFile } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { BOOT_TIMEOUT_MS, DEFAULT_LOG_LINES, KEYS } from './phone-ops.js'
import { connectTo, findAndroid, findIos, inspectPhones, scanEmulators } from './phone-tool.js'
import { actionable, describeScreen, parseDump } from './phone-ui.js'

const run = promisify(execFile)

/** Long enough for a slow dump on a cold device, short enough to not hang a turn. */
const ADB_TIMEOUT_MS = 60_000
/** Between checks while a device finishes booting. */
const POLL_MS = 2_000

/**
 * Creates the engine.
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.chosen] where the user said their SDK is
 * @param {string} [options.managed] an SDK this app installed for itself
 */
export function createEngine({ log, chosen, managed } = {}) {
  /** @type {{serial: string, ours: boolean, avd?: string} | undefined} */
  let device
  /** @type {{udid: string, name: string} | undefined} */
  let ios
  /** @type {Map<string, object>} */
  let refs = new Map()
  /** When a verb last ran — what "idle" is measured from. */
  let lastUsed = Date.now()

  const sdk = () => {
    const found = findAndroid({ chosen, managed })
    if (!found) throw new Error('no Android SDK on this machine — nothing to run a phone with')
    return found
  }

  /** Every adb call, with the device this engine is attached to. */
  async function adb(args, { binary = false, timeout = ADB_TIMEOUT_MS } = {}) {
    if (!device) throw new Error('no phone is open — run `open` first')
    const { stdout } = await run(sdk().bin.adb, ['-s', device.serial, ...args], {
      timeout,
      maxBuffer: 64 * 1024 * 1024,
      ...(binary ? { encoding: 'buffer' } : { encoding: 'utf8' }),
    })
    return stdout
  }

  const verbs = {
    async status() {
      const seen = inspectPhones({ chosen, managed })
      const answer = {
        ok: true,
        state: device ? 'open' : seen.android,
        avds: seen.sdk?.avds ?? [],
        images: seen.sdk?.images ?? [],
        ios: (seen.ios?.devices ?? []).length,
      }
      if (device) return { ...answer, serial: device.serial, why: `attached to ${device.avd ?? device.serial}` }
      return { ...answer, why: EXPLAIN[seen.android] }
    },

    async devices() {
      const seen = inspectPhones({ chosen, managed })
      const lines = []
      for (const target of seen.sdk?.targets ?? []) {
        lines.push(`attached  ${target.serial.padEnd(22)} ${KIND[target.kind]}`
          + `${target.model ? ` — ${target.model}` : ''}`)
      }
      for (const avd of seen.sdk?.avds ?? []) lines.push(`avd       ${avd.padEnd(22)} not started`)
      for (const entry of seen.ios?.devices ?? []) {
        lines.push(`ios       ${entry.name.padEnd(22)} ${entry.runtime}`
          + `${entry.booted ? ' (booted)' : ''} — look only, no input`)
      }
      if (lines.length === 0) return { ok: true, why: EXPLAIN[seen.android] }
      return { ok: true, elements: lines.join('\n') }
    },

    async connect({ address }) {
      const answer = connectTo(sdk().bin, String(address ?? ''))
      if (!answer.ok) return fail(answer.why || `nothing answered at ${address}`)
      device = { serial: String(address), ours: false }
      refs = new Map()
      return { ok: true, serial: device.serial, why: answer.why }
    },

    async scan() {
      const found = scanEmulators(sdk().bin)
      if (found.length === 0) {
        return {
          ok: true,
          why: 'nothing answered on the ports the common third-party emulators use'
            + ' — if one is running, `connect` takes the address it is actually on',
        }
      }
      return {
        ok: true,
        elements: found.map(entry =>
          `${entry.serial.padEnd(22)} ${entry.model ?? `probably ${entry.name}`}`).join('\n'),
      }
    },

    async open({ avd, serial, ios: wantedIos }) {
      if (wantedIos) return openIos(wantedIos)
      const found = sdk()

      if (serial) {
        // Named, so anything goes — including a real phone. The naming is the
        // consent: an agent that types a serial number has been told one.
        const target = found.targets.find(entry => entry.serial === serial)
        if (!target) {
          return fail(`adb is not talking to ${serial} — run \`devices\` for what it has,`
            + ' or `connect` for an emulator it has not been introduced to')
        }
        device = { serial, ours: false }
        refs = new Map()
        return { ok: true, serial, why: `attached to ${KIND[target.kind]}${target.model ? ` — ${target.model}` : ''}` }
      }

      // Something already answering is what we attach to. Starting a second
      // emulator because one was not asked for by name would leave the user
      // with two phones and this app driving the one they were not watching.
      //
      // Only a Google virtual device, though. `targets` may well hold a phone
      // on a USB cable, and picking that up because it was first in a list is
      // this app deciding to tap around on somebody's actual telephone.
      if (found.running.length > 0) {
        device = { serial: found.running[0], ours: false }
        refs = new Map()
        return { ok: true, serial: device.serial, why: 'attached to a virtual device that was already running' }
      }
      const attached = found.targets.filter(entry => entry.kind !== 'avd')
      if (attached.length > 0 && found.avds.length === 0) {
        return fail(`adb is talking to ${attached.map(entry => entry.serial).join(', ')},`
          + ' but none of them is a virtual device this app started.'
          + ' Name one with serial to use it — a third-party emulator or a real phone is not something'
          + ' this app attaches to on its own.')
      }
      const name = avd ?? (found.avds.length === 1 ? found.avds[0] : undefined)
      if (!name) {
        return fail(found.avds.length === 0
          ? EXPLAIN.noDevice
          : `name which one: ${found.avds.join(', ')}`)
      }
      if (!found.avds.includes(name)) return fail(`no virtual device called ${name} — there is ${found.avds.join(', ')}`)

      log?.(`starting the phone ${name}`)
      const child = execFile(found.bin.emulator, ['-avd', name], { detached: true })
      child.unref()
      const booted = await waitForBoot(found)
      device = { serial: booted, ours: true, avd: name }
      refs = new Map()
      return { ok: true, serial: booted, why: `${name} finished booting` }
    },

    async close() {
      if (ios) {
        const shut = ios
        ios = undefined
        await run('xcrun', ['simctl', 'shutdown', shut.udid], { timeout: 30_000 }).catch(() => {})
        return { ok: true, closed: `the iOS simulator ${shut.name}` }
      }
      if (!device) return { ok: true, closed: 'nothing was open' }
      const held = device
      device = undefined
      refs = new Map()
      if (!held.ours) return { ok: true, closed: 'the attachment; the phone was already running and is left alone' }
      await run(sdk().bin.adb, ['-s', held.serial, 'emu', 'kill'], { timeout: 30_000 }).catch(() => {})
      return { ok: true, closed: `the phone ${held.avd ?? held.serial}` }
    },

    async snapshot() {
      const views = await readScreen()
      const { lines, table } = describeScreen(views)
      refs = table
      return { ok: true, elements: lines.join('\n'), count: table.size }
    },

    async tap({ ref, x, y }) {
      if (x !== undefined && y !== undefined) {
        await adb(['shell', 'input', 'tap', String(x), String(y)])
        return { ok: true, tapped: `${x},${y}` }
      }
      const found = await locate(ref)
      if (found.error) return fail(found.error)
      await adb(['shell', 'input', 'tap', String(found.point.x), String(found.point.y)])
      return { ok: true, tapped: `${found.label} at ${found.point.x},${found.point.y}`, ...found.note }
    },

    async input({ ref, text }) {
      const value = String(text ?? '')
      // Android's own `input text` sends keystrokes through a US keyboard
      // layout and drops anything that is not on it. Typing the ASCII part of
      // a Chinese sentence would be worse than refusing: the field would end
      // up holding something the agent believes it did not write.
      if (/[^\x20-\x7E]/.test(value)) {
        return fail('adb can only type ASCII — Android\'s input command carries nothing else,'
          + ' and typing the part that fits would leave the field holding something you did not write')
      }
      if (ref) {
        const found = await locate(ref)
        if (found.error) return fail(found.error)
        await adb(['shell', 'input', 'tap', String(found.point.x), String(found.point.y)])
        await pause(300)
      }
      // Spaces are the shell's separator here, not the phone's; `input text`
      // reads %s as one.
      await adb(['shell', 'input', 'text', value.replace(/ /g, '%s')])
      return { ok: true, typed: value }
    },

    async key({ name }) {
      const code = KEYS[name]
      if (!code) return fail(`no key called ${name} — there is ${Object.keys(KEYS).join(', ')}`)
      await adb(['shell', 'input', 'keyevent', code])
      return { ok: true, pressed: name }
    },

    async swipe({ from, to, ms = 300 }) {
      const start = point(from)
      const end = point(to)
      if (!start || !end) return fail('from and to are points, written "x,y"')
      await adb(['shell', 'input', 'swipe', String(start.x), String(start.y), String(end.x), String(end.y), String(ms)])
      return { ok: true, swiped: `${from} → ${to}` }
    },

    async screenshot({ path: file }, cwd) {
      const png = await adb(['exec-out', 'screencap', '-p'], { binary: true })
      if (!png?.length) return fail('the phone returned no image')
      if (!file) return { ok: true, png: Buffer.from(png).toString('base64') }
      const target = path.resolve(cwd || process.cwd(), file)
      writeFileSync(target, png)
      return { ok: true, path: target }
    },

    async install({ apk }, cwd) {
      const target = path.resolve(cwd || process.cwd(), String(apk ?? ''))
      const out = await adb(['install', '-r', target], { timeout: 300_000 })
      return { ok: /Success/i.test(out), result: out.trim(), ...(/Success/i.test(out) ? {} : { why: 'the install was refused' }) }
    },

    async launch({ package: name }) {
      // Asked which activity, then told to start that one. `monkey` is the
      // one-liner for this and a bad one: it prints its own arguments back on
      // success, buries a failure in the same noise, and exits non-zero often
      // enough that its exit code says nothing. Resolving first turns "that
      // package has nothing to launch" into a sentence instead of a wall.
      const resolved = await adb(['shell', 'cmd', 'package', 'resolve-activity', '--brief', String(name)])
      const component = resolved.split('\n').map(line => line.trim()).filter(Boolean).pop()
      if (!component?.includes('/')) return fail(`${name} is not installed, or has no launchable activity`)
      await adb(['shell', 'am', 'start', '-n', component])
      await pause(1_000)
      return { ok: true, result: `launched ${component}` }
    },

    async logcat({ lines = DEFAULT_LOG_LINES, filter }) {
      const out = await adb(['logcat', '-d', '-v', 'threadtime', '-t', String(lines)])
      const all = out.split('\n').filter(Boolean)
      return { ok: true, messages: filter ? all.filter(line => line.includes(filter)) : all }
    },

    async shell({ command }) {
      const out = await adb(['shell', String(command)])
      return { ok: true, result: out.trimEnd() }
    },
  }

  /** Boots an iOS simulator, which is as far as iOS goes. */
  async function openIos(wanted) {
    const found = findIos()
    if (!found) return fail('no Xcode on this machine, so there are no iOS simulators')
    const key = String(wanted).toLowerCase()
    const match = found.devices.find(entry => entry.udid === wanted || entry.name.toLowerCase() === key)
    if (!match) return fail(`no iOS simulator called ${wanted} — run \`devices\` for the list`)
    if (!match.booted) await run('xcrun', ['simctl', 'boot', match.udid], { timeout: 120_000 })
    await run('open', ['-a', 'Simulator'], { timeout: 30_000 }).catch(() => {})
    ios = { udid: match.udid, name: match.name }
    return {
      ok: true,
      why: `${match.name} is booted. iOS accepts no injected input, so this device can be looked at`
        + ' and started, and not tapped or typed into.',
    }
  }

  /** Waits for an emulator to appear and finish booting. */
  async function waitForBoot(found) {
    const deadline = Date.now() + BOOT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const fresh = findAndroid({ chosen, managed })
      const serial = fresh?.running?.[0]
      if (serial) {
        // Present on the network is not the same as ready to be tapped: the
        // emulator answers adb long before the launcher is up, and a dump
        // taken in between describes a boot animation.
        const done = await run(found.bin.adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], {
          encoding: 'utf8', timeout: 15_000,
        }).then(({ stdout }) => stdout.trim() === '1').catch(() => false)
        if (done) return serial
      }
      await pause(POLL_MS)
    }
    throw new Error(`the phone did not finish booting within ${Math.round(BOOT_TIMEOUT_MS / 1000)}s`)
  }

  /** Reads the screen, and turns it into the views worth naming. */
  async function readScreen() {
    const xml = await adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'])
    if (!xml.includes('<hierarchy')) {
      throw new Error('the phone returned no view hierarchy — it may still be booting, or the screen may be off')
    }
    return actionable(parseDump(xml))
  }

  /**
   * Finds, on the screen as it is now, the view a ref was taken of.
   *
   * The identity is whatever the view had to be recognised by: its resource
   * id first, because an id is what an app author chose to name something;
   * then its words; then, for the views that have neither, its class and how
   * many identical siblings came before it. Position is never the identity —
   * position is the thing being looked up.
   */
  async function locate(name) {
    const remembered = refs.get(name)
    if (!remembered) return { error: `no such ref ${name} — take a snapshot first; every snapshot renumbers them` }
    const views = await readScreen()
    const matches = views.filter(view => sameView(view, remembered))
    if (matches.length === 0) {
      return {
        error: `${name} (${describeRef(remembered)}) is not on the screen any more`
          + ' — it has scrolled away, or the screen has changed. Take another snapshot.',
      }
    }
    // Several identical views: the one that was at the remembered place is
    // the one that was meant, and being close is enough — a list that scrolled
    // by four pixels has not become a different list.
    const best = matches.length === 1 ? matches[0] : nearest(matches, remembered.point)
    const moved = Math.abs(best.point.x - remembered.point.x) + Math.abs(best.point.y - remembered.point.y)
    return {
      point: best.point,
      label: describeRef(best),
      note: moved > 8 ? { why: `it had moved ${moved}px since the snapshot; tapped where it is now` } : {},
    }
  }

  return {
    async run(op, params, cwd) {
      const verb = verbs[op]
      if (!verb) return fail(`no such command "${op}"`)
      lastUsed = Date.now()
      try {
        return await verb(params ?? {}, cwd)
      } catch (error) {
        return fail(error?.stderr?.toString?.().trim() || error?.message || String(error))
      }
    },
    isOpen: () => Boolean(device || ios),

    /** What an idle reaper needs to know; `ours` gates everything it does. */
    idle: () => ({
      open: Boolean(device || ios),
      ours: device?.ours ?? false,
      idleMs: Date.now() - lastUsed,
    }),

    /**
     * For the app's own shutdown.
     *
     * An emulator this app booted is told to shut down — fire-and-forget,
     * for the same reason the DevTools quit is: the app's exit must not
     * wait on somebody else's. One that was already running, or an iOS
     * simulator (which this app only ever looks at), is left as found.
     * A gigabyte-scale process nobody asked to keep is exactly what
     * "no orphans" was promised about.
     */
    async dispose() {
      if (device?.ours) {
        try {
          const child = execFile(findAndroid({ chosen, managed }).bin.adb, ['-s', device.serial, 'emu', 'kill'])
          child.unref?.()
        } catch { /* the SDK may be gone; so, then, is our standing to clean up */ }
      }
      device = undefined
      ios = undefined
    },
  }
}

/** Whether two readings of the screen are readings of the same view. */
function sameView(view, remembered) {
  if (view.kind !== remembered.kind) return false
  if (remembered.id) return view.id === remembered.id
  if (remembered.label) return view.label === remembered.label
  return view.depth === remembered.depth
}

function nearest(views, point) {
  return views.reduce((best, view) => {
    const distance = Math.abs(view.point.x - point.x) + Math.abs(view.point.y - point.y)
    return distance < best.distance ? { view, distance } : best
  }, { view: views[0], distance: Infinity }).view
}

function describeRef(view) {
  return [view.kind, view.id ? `#${view.id}` : undefined, view.label ? JSON.stringify(view.label) : undefined]
    .filter(Boolean).join(' ')
}

/** `"540,1800"` */
function point(value) {
  const found = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*$/.exec(String(value ?? ''))
  return found ? { x: Number(found[1]), y: Number(found[2]) } : undefined
}

const pause = ms => new Promise(resolve => { setTimeout(resolve, ms) })
const fail = (why, extra = {}) => ({ ok: false, why, ...extra })

/** What each kind of attachment is, in the words a person needs to tell them apart. */
const KIND = {
  avd: 'a Google virtual device',
  network: 'attached over the network — a third-party emulator, or a phone on wireless debugging',
  usb: 'a real phone on a cable',
}

/** One sentence per rung of the ladder, each naming the one thing to do next. */
const EXPLAIN = {
  missing: 'no Android SDK on this machine — the tools, an emulator and a system image have to be installed first',
  noImage: 'the SDK is here but has no system image, so there is nothing for a phone to run',
  noDevice: 'there are system images but no virtual device defined — one has to be created before anything can start',
  stopped: 'a virtual device is defined and not running',
  ready: 'a phone is running',
}
