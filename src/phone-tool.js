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
 * @property {string[]} running serial numbers of emulators answering `adb`
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
 * @param {string} [options.managed] an SDK this app installed into its own
 *   data directory; searched last, so a user's own SDK always wins
 * @returns {AndroidSdk | undefined}
 */
export function findAndroid({ env = process.env, home = homedir(), managed } = {}) {
  for (const root of androidRoots({ env, home, managed })) {
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
      running: listRunning(bin),
    }
  }
  return undefined
}

/** @returns {Generator<string | undefined>} */
function* androidRoots({ env, home, managed }) {
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
  const onPath = which(isWindows ? 'adb.exe' : 'adb')
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
 * Emulators currently answering.
 *
 * `adb devices` also lists real phones plugged in over USB, which are not
 * ours to drive: somebody's actual telephone is not a simulated device, and
 * an agent tapping around on one is a different feature with a different
 * conversation attached. Only the `emulator-NNNN` serials are kept.
 *
 * @param {Record<string, string>} bin @returns {string[]}
 */
function listRunning(bin) {
  try {
    const out = execFileSync(bin.adb, ['devices'], {
      encoding: 'utf8',
      timeout: 15_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').slice(1)
      .map(line => line.split('\t'))
      .filter(([serial, state]) => serial?.startsWith('emulator-') && state?.trim() === 'device')
      .map(([serial]) => serial)
  } catch {
    return []
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
 * @param {{env?: Record<string, string | undefined>, home?: string, managed?: string}} [options]
 * @returns {PhoneInspection}
 */
export function inspectPhones({ env = process.env, home = homedir(), managed } = {}) {
  const sdk = findAndroid({ env, home, managed })
  const ios = findIos()
  if (!sdk) return { android: 'missing', ios }
  if (sdk.running.length > 0) return { android: 'ready', sdk, ios }
  if (sdk.images.length === 0) return { android: 'noImage', sdk, ios }
  if (sdk.avds.length === 0) return { android: 'noDevice', sdk, ios }
  return { android: 'stopped', sdk, ios }
}

/** @param {string} command @returns {string | undefined} */
function which(command) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, command)
    if (existsSync(file)) return file
  }
  return undefined
}
