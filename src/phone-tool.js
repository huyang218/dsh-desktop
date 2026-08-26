/**
 * Finding the phones this machine can pretend to have.
 *
 * Two families, and they are not symmetrical, so this file does not pretend
 * they are:
 *
 * **Android** can be had by anyone. The command-line tools are a zip from
 * Google, the emulator and a system image come from `sdkmanager`, and every
 * step of it is scriptable — which is what makes "install it for me" a real
 * offer rather than a link to a download page. It is also driveable: `adb`
 * injects taps and text and dumps the view hierarchy, so an agent can see and
 * act the way it does in the browser.
 *
 * **iOS** cannot. The Simulator arrives with Xcode, which is an App Store
 * download of some tens of gigabytes behind an Apple ID, and nothing this app
 * does can shorten that. What it can do is notice an Xcode that is already
 * there and use it — `simctl` boots a device and takes a picture of it. There
 * is no supported way to inject a tap, so an iOS device here is something to
 * look at rather than something to drive, and this file reports that as a
 * property of the device rather than leaving it to be discovered.
 *
 * Being clear about that asymmetry is the point. "Simulator" reads as one
 * capability, and offering both under one word, with one of them quietly
 * unable to do half of what the other does, would be the misleading kind of
 * tidy.
 *
 * Electron-free, so it can be exercised under plain Node.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const isWindows = process.platform === 'win32'

/** Names an SDK this file would not have guessed. */
export const ANDROID_ENV = ['ANDROID_HOME', 'ANDROID_SDK_ROOT']

/** Executable names, which differ only on Windows and only for the scripts. */
const BINARIES = {
  adb: ['platform-tools', isWindows ? 'adb.exe' : 'adb'],
  emulator: ['emulator', isWindows ? 'emulator.exe' : 'emulator'],
  sdkmanager: ['cmdline-tools', 'latest', 'bin', isWindows ? 'sdkmanager.bat' : 'sdkmanager'],
  avdmanager: ['cmdline-tools', 'latest', 'bin', isWindows ? 'avdmanager.bat' : 'avdmanager'],
}

/**
 * @typedef {object} AndroidSdk
 * @property {string} root the SDK directory everything below is relative to
 * @property {Record<string, string>} bin the tools found, by name
 * @property {string[]} images system images installed, e.g. `android-35`
 * @property {string[]} avds virtual devices defined, by name
 * @property {Target[]} targets everything adb can talk to, classified
 * @property {string[]} running serials of Google AVDs answering `adb`
 */

/**
 * Locates an Android SDK, and reads what is actually usable in it.
 *
 * The tools being present is the least interesting thing about an SDK. An
 * install with no system image cannot start anything, one with images but no
 * virtual device has nothing to start, and each of those is a different
 * sentence to say to the user and a different button to offer. So all three
 * are read here rather than left for a caller to discover by failing.
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {string} [options.home]
 * @param {string} [options.chosen] a directory the user pointed this app at;
 *   searched first, because being told beats every guess
 * @param {string} [options.managed] an SDK this app installed into its own
 *   data directory; searched last, so a user's own SDK always wins
 * @returns {AndroidSdk | undefined}
 */
export function findAndroid({ env = process.env, home = homedir(), chosen, managed } = {}) {
  for (const root of androidRoots({ env, home, chosen, managed })) {
    if (!root || !existsSync(root)) continue
    const bin = {}
    for (const [name, parts] of Object.entries(BINARIES)) {
      const file = path.join(root, ...parts)
      if (existsSync(file)) bin[name] = file
    }
    // `adb` is the one that has to be there. Everything else this file
    // reports on is a thing to install; without adb there is no way to talk
    // to a device even once one exists.
    if (!bin.adb) continue
    return {
      root,
      bin,
      images: listImages(root),
      avds: listAvds(bin, env),
      targets: listTargets(bin),
      // The ladder below is about a phone this app may start on its own, and
      // that is an AVD. A third-party emulator or a real device is something
      // the user attaches deliberately, and does not make the app "ready".
      running: listTargets(bin).filter(target => target.kind === 'avd').map(target => target.serial),
    }
  }
  return undefined
}

/** @returns {Generator<string | undefined>} */
function* androidRoots({ env, home, chosen, managed }) {
  // First, and ahead of the environment: someone who used the app's own
  // picker has said which SDK they mean, and an ANDROID_HOME left over in a
  // shell profile is not a better answer than that.
  yield chosen?.trim()
  for (const name of ANDROID_ENV) yield env[name]?.trim()
  if (isWindows) {
    if (env.LOCALAPPDATA) yield path.join(env.LOCALAPPDATA, 'Android', 'Sdk')
    if (env.ProgramFiles) yield path.join(env.ProgramFiles, 'Android', 'android-sdk')
  } else {
    // Android Studio's own default, first: someone who has Studio has this.
    yield path.join(home, 'Library', 'Android', 'sdk')
    yield path.join(home, 'Android', 'Sdk')
    // Homebrew's command-line-tools cask, on both silicon and Intel prefixes.
    yield '/opt/homebrew/share/android-commandlinetools'
    yield '/usr/local/share/android-commandlinetools'
  }
  // Last: wherever the `adb` on PATH lives. It finds the installs nobody
  // anticipated, and it is last because a stray adb somewhere on PATH should
  // not outrank a real SDK in its usual place.
  const onPath = which(isWindows ? 'adb.exe' : 'adb', env)
  if (onPath) yield path.resolve(path.dirname(onPath), '..')
  // Ours, if we ever installed one. Last of all: someone who has their own
  // SDK has more in it than we would ever install, and a machine that has
  // both should use theirs.
  yield managed
}

/** @param {string} root @returns {string[]} */
function listImages(root) {
  try {
    return readdirSync(path.join(root, 'system-images')).filter(name => name.startsWith('android-')).sort()
  } catch {
    return []
  }
}

/**
 * The virtual devices defined for this SDK.
 *
 * Asked of the emulator rather than read out of `~/.android/avd`, because the
 * emulator honours `ANDROID_AVD_HOME` and a user who moved theirs would
 * otherwise be told they have none.
 *
 * @param {Record<string, string>} bin @param {Record<string, string | undefined>} env
 * @returns {string[]}
 */
function listAvds(bin, env) {
  if (!bin.emulator) return []
  try {
    const out = execFileSync(bin.emulator, ['-list-avds'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ...env },
    })
    return out.split('\n').map(line => line.trim()).filter(Boolean)
  } catch {
    return []
  }
}

/**
 * Where the third-party Android emulators listen for `adb connect`.
 *
 * None of these announce themselves. A Google AVD registers with the running
 * adb server and shows up in `adb devices` on its own; MuMu, LDPlayer, Nox
 * and the rest expose a port and wait to be connected to, so a machine with
 * one running looks, to adb, exactly like a machine with nothing running.
 * The only way to find them is to knock.
 *
 * Ports change between major versions of these products and each of them
 * offsets per extra instance, so this list is a starting point and not a
 * promise — which is why `connect` takes an address as well, for the one
 * somebody is running on a port nobody guessed.
 */
export const KNOWN_EMULATOR_PORTS = [
  { port: 16384, name: 'MuMu 12' },
  { port: 7555, name: 'MuMu 6' },
  { port: 5555, name: 'LDPlayer / BlueStacks' },
  { port: 5565, name: 'BlueStacks 5' },
  { port: 62001, name: 'Nox' },
  { port: 21503, name: 'MEmu' },
  { port: 6555, name: 'Genymotion' },
]

/**
 * @typedef {object} Target
 * @property {string} serial what adb calls it
 * @property {'avd'|'network'|'usb'} kind how it is attached
 * @property {string} [model] what it says it is
 * @property {boolean} simulated whether this app is confident it is not a real phone
 */

/**
 * Everything adb can currently talk to, and what each thing is.
 *
 * The classification matters more than the list. A Google AVD is a device
 * this app may start, stop and tap on freely. A phone on the end of a USB
 * cable is somebody's actual telephone, with their messages and their bank on
 * it, and an agent that picks it up because it happened to be first in the
 * list has done something nobody asked for. So the kind travels with the
 * serial everywhere, and the engine refuses to choose anything but an AVD on
 * its own.
 *
 * `network` is the ambiguous one, deliberately: a third-party emulator and a
 * phone on wireless debugging are the same shape to adb. It is reported as
 * unconfirmed rather than guessed, and named by its model so a person can
 * tell at a glance.
 *
 * @param {Record<string, string>} bin @returns {Target[]}
 */
function listTargets(bin) {
  let out
  try {
    out = execFileSync(bin.adb, ['devices', '-l'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return []
  }
  const targets = []
  for (const line of out.split('\n').slice(1)) {
    const [serial, rest] = line.split(/\s+/, 1).concat(line.replace(/^\S+\s*/, ''))
    if (!serial || !rest?.startsWith('device')) continue
    const model = /\bmodel:(\S+)/.exec(rest)?.[1]?.replace(/_/g, ' ')
    const kind = /^emulator-\d+$/.test(serial) ? 'avd' : serial.includes(':') ? 'network' : 'usb'
    targets.push({ serial, kind, model, simulated: kind === 'avd' })
  }
  return targets
}

/**
 * Knocks on the ports the third-party emulators are usually behind.
 *
 * Each connect is cheap and failing is the normal answer — most of these
 * ports have nothing on them on any given machine. A connection that
 * succeeds joins the adb device list and stays there, which is the point.
 *
 * Two things it has to avoid, both found by running it.
 *
 * A Google AVD listens for adb one port above its console port, so
 * `emulator-5554` has an adbd on 5555 — which is also where LDPlayer and
 * BlueStacks are. Knocking there connects to the device already in the list
 * under another name, and adb keeps both: one phone, two entries, and a scan
 * that reports the user's own AVD as somebody else's product. Those ports are
 * skipped.
 *
 * And the name in this table is a guess about which product uses a port,
 * while the model adb reports is what actually answered. Both are returned,
 * the fact first.
 *
 * @param {Record<string, string>} bin
 * @param {Array<{port: number, name: string}>} [ports]
 * @returns {Array<{port: number, name: string, serial: string, model?: string}>}
 */
export function scanEmulators(bin, ports = KNOWN_EMULATOR_PORTS) {
  const before = listTargets(bin)
  const taken = new Set(before
    .map(target => /^emulator-(\d+)$/.exec(target.serial)?.[1])
    .filter(Boolean)
    .map(console_ => Number(console_) + 1))

  const found = []
  for (const entry of ports) {
    if (taken.has(entry.port)) continue
    const address = `127.0.0.1:${entry.port}`
    try {
      const out = execFileSync(bin.adb, ['connect', address], {
        encoding: 'utf8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      if (/connected to/i.test(out)) found.push({ ...entry, serial: address })
    } catch { /* nothing there, which is the usual answer */ }
  }
  if (found.length === 0) return found
  // Ask what answered rather than reporting what the table guessed.
  const after = listTargets(bin)
  return found.map(entry => ({ ...entry, model: after.find(target => target.serial === entry.serial)?.model }))
}

/**
 * Attaches to one address.
 *
 * @param {Record<string, string>} bin @param {string} address `host:port`
 * @returns {{ ok: boolean, why: string }}
 */
export function connectTo(bin, address) {
  try {
    const out = execFileSync(bin.adb, ['connect', address], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return { ok: /connected to/i.test(out), why: out }
  } catch (error) {
    return { ok: false, why: String(error?.message ?? error) }
  }
}

/**
 * @typedef {object} IosSimulator
 * @property {string} udid
 * @property {string} name e.g. `iPhone 17 Pro`
 * @property {string} runtime e.g. `iOS 26.3`
 * @property {boolean} booted
 */

/**
 * The iOS simulators Xcode has, if Xcode is here at all.
 *
 * @returns {{ developerDir: string, devices: IosSimulator[] } | undefined}
 */
export function findIos() {
  if (process.platform !== 'darwin') return undefined
  let developerDir
  try {
    developerDir = execFileSync('xcode-select', ['-p'], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
  // The command line tools alone answer `xcode-select -p` and have no
  // simulators; only a real Xcode does, and `simctl` saying so is a better
  // test than inspecting the path.
  let listed
  try {
    listed = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }))
  } catch {
    return undefined
  }
  const devices = []
  for (const [runtime, entries] of Object.entries(listed?.devices ?? {})) {
    for (const entry of entries ?? []) {
      devices.push({
        udid: entry.udid,
        name: entry.name,
        runtime: runtimeName(runtime),
        booted: entry.state === 'Booted',
      })
    }
  }
  return { developerDir, devices }
}

/** `com.apple.CoreSimulator.SimRuntime.iOS-26-3` is nobody's idea of a label. */
function runtimeName(identifier) {
  const found = /SimRuntime\.([A-Za-z]+)-([\d-]+)$/.exec(identifier)
  return found ? `${found[1]} ${found[2].replace(/-/g, '.')}` : identifier
}

/**
 * @typedef {object} PhoneInspection
 * @property {'missing'|'noImage'|'noDevice'|'stopped'|'ready'} android
 * @property {AndroidSdk} [sdk]
 * @property {{developerDir: string, devices: IosSimulator[]}} [ios]
 */

/**
 * What this machine can do about phones, in the terms an offer is made in.
 *
 * Android's states are a ladder, and each rung is a different thing to say
 * and a different thing to download: no SDK at all, an SDK with nothing to
 * run, something to run with no device configured, a device that is not
 * started, and a device answering. Collapsing them into "not available"
 * would leave the user holding a two-gigabyte download when what they needed
 * was one command.
 *
 * @param {{env?: Record<string, string | undefined>, home?: string,
 *   chosen?: string, managed?: string}} [options]
 * @returns {PhoneInspection}
 */
export function inspectPhones({ env = process.env, home = homedir(), chosen, managed } = {}) {
  const sdk = findAndroid({ env, home, chosen, managed })
  const ios = findIos()
  if (!sdk) return { android: 'missing', ios }
  if (sdk.running.length > 0) return { android: 'ready', sdk, ios }
  if (sdk.images.length === 0) return { android: 'noImage', sdk, ios }
  if (sdk.avds.length === 0) return { android: 'noDevice', sdk, ios }
  return { android: 'stopped', sdk, ios }
}

/**
 * @param {string} command
 * @param {Record<string, string | undefined>} env the caller's environment,
 *   not this process's — an `env` argument that some of the search ignores is
 *   a seam that lies, and the lie only shows up in a test that passes
 * @returns {string | undefined}
 */
function which(command, env) {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, command)
    if (existsSync(file)) return file
  }
  return undefined
}

/**
 * Judges one directory the user picked, and says what is wrong with it.
 *
 * The search elsewhere in this file answers "is there an SDK anywhere"; this
 * answers "is *this* one usable", which is a different question and needs a
 * different answer. Somebody who points at a directory and is told "not
 * found" learns nothing — the useful reply names what is there, what is
 * missing, and whether what is missing can be downloaded.
 *
 * Accepts being pointed slightly wrong, too. `platform-tools` and
 * `cmdline-tools` are inside an SDK, and picking one of them in a file dialog
 * is the natural mistake; the parent is checked rather than refused.
 *
 * @param {string} directory
 * @returns {{ ok: boolean, root?: string, images: string[], avds: string[],
 *   missing: Array<'sdk'|'adb'|'emulator'|'image'|'device'> }}
 */
export function verifyAndroid(directory) {
  const candidates = [directory, path.dirname(directory), path.dirname(path.dirname(directory))]
  for (const root of candidates) {
    if (!root || !existsSync(root)) continue
    const found = findAndroid({ env: {}, home: '\u0000', chosen: root })
    // findAndroid searches on past a candidate it does not like, so the
    // answer only counts when it is about the directory that was asked about.
    if (!found || path.resolve(found.root) !== path.resolve(root)) continue
    const missing = []
    if (!found.bin.emulator) missing.push('emulator')
    if (found.images.length === 0) missing.push('image')
    if (found.avds.length === 0) missing.push('device')
    return { ok: missing.length === 0, root: found.root, images: found.images, avds: found.avds, missing }
  }
  // Nothing here answered. `adb` is what {@link findAndroid} requires before
  // it will call a directory an SDK, so its absence is what to report.
  return { ok: false, images: [], avds: [], missing: ['sdk'] }
}
