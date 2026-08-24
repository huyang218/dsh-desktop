/**
 * Getting an Android SDK onto a machine that has none.
 *
 * The offer this makes is unusual for this app, so it is worth stating what
 * it is: about 1.7 gigabytes from Google, under a licence the user has to
 * agree to, installed into this app's own data directory. Every part of that
 * sentence is something the user should see before it starts, which is why
 * this module reports a plan — each step, its size — rather than doing the
 * work and narrating it afterwards.
 *
 * Nothing here decides to install anything. It resolves, downloads, unpacks
 * and runs `sdkmanager`, and every one of those is called by something that
 * has already asked.
 *
 * Two things it deliberately does not do:
 *
 * It does not hardcode a download URL. The build number in
 * `commandlinetools-mac_arm64-16111833_latest.zip` moves, and a pinned URL is
 * a feature that works until it silently does not. Google publishes the same
 * package index `sdkmanager` itself reads, with the URL, the size and a SHA-1
 * for every host; that is what gets read.
 *
 * It does not agree to anything. Google's terms are between the user and
 * Google; this refuses to start until a caller says the user has said yes,
 * and the tools themselves show the terms. There is no path through here
 * that agrees on somebody's behalf.
 *
 * ## What the command-line tools turned into
 *
 * As of cmdline-tools 23, `sdkmanager` is a deprecated shell script that
 * forwards to a new program: `android sdk`. The `android` binary in the same
 * directory is not that program either — it is a bootstrapper that downloads
 * it, about 80MB, on first use. Two consequences, both found by running it:
 *
 * The bootstrap download is one this app cannot see fail usefully — it
 * reports `io: unexpected end of file` and stops. So the CLI is downloaded
 * here instead, by the same code that fetches everything else, and the tools
 * are told where it is through `ANDROID_CLI_BIN`. That is the script's own
 * documented seam, not a trick.
 *
 * The CLI reads the proxy environment and its downloader does not survive
 * every proxy: on the machine this was written on, a local proxy that `curl`
 * uses happily produced that same truncated-file error on every download,
 * while going direct worked. There is no way to tell those apart from here,
 * so the error is reported with the proxy named in it, and the choice is left
 * with the person who knows their own network.
 *
 * Electron-free.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where Google publishes what it has, and where the archives sit. */
const INDEX_URL = 'https://dl.google.com/android/repository/repository2-3.xml'
const ARCHIVE_BASE = 'https://dl.google.com/android/repository/'

/**
 * Which index a package is listed in.
 *
 * Not all of them are in one. The tools, the emulator and the platforms are
 * in the main index; system images are published per tag in their own, and
 * looking for one in the wrong place finds nothing and says nothing — which
 * is how a progress total ends up counting 413MB of a 2.1GB install and a bar
 * that reaches 100% about a fifth of the way through.
 *
 * @param {string} sdkPath e.g. `system-images;android-35;google_apis;arm64-v8a`
 * @returns {string}
 */
function indexFor(sdkPath) {
  const image = /^system-images;[^;]+;([^;]+);/.exec(sdkPath)
  return image ? `${ARCHIVE_BASE}sys-img/${image[1]}/sys-img2-3.xml` : INDEX_URL
}

/** The terms the SDK is offered under. */
export const LICENCE_URL = 'https://developer.android.com/studio/terms'

/**
 * Where the Android CLI itself is published.
 *
 * Not in the package index — this one is a plain path per host, which is what
 * the bootstrapper in the tools reaches for. `linux_arm64` is not published;
 * a caller there gets told so rather than a 404 in the middle of an install.
 */
export function androidCliUrl(platform = process.platform, arch = process.arch) {
  const host = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform]
  const cpu = arch === 'arm64' ? 'arm64' : 'x86_64'
  if (!host) throw new Error(`Google publishes no Android CLI for ${platform}`)
  if (host === 'linux' && cpu === 'arm64') throw new Error('Google publishes no Android CLI for linux on arm64')
  if (host === 'windows' && cpu === 'arm64') throw new Error('Google publishes no Android CLI for Windows on arm64')
  const name = host === 'windows' ? 'android-cli.exe' : 'android-cli'
  return `https://dl.google.com/android/cli/latest/${host}_${cpu}/${name}`
}

/** Where this app keeps the CLI it downloaded, inside the SDK it belongs to. */
export function androidCliPath(sdkRoot) {
  return path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin',
    process.platform === 'win32' ? 'android-cli.exe' : 'android-cli')
}

/**
 * Downloads the Android CLI the tools would otherwise bootstrap themselves.
 *
 * No digest to check: Google publishes none for this one. The size is
 * checked against what the server said instead, which catches the truncation
 * that is the failure actually seen here.
 *
 * @param {object} options
 * @param {string} options.sdkRoot
 * @param {(received: number, total: number) => void} [options.onProgress]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<string>} the path it was written to
 */
export async function installCli({ sdkRoot, onProgress, fetchImpl = fetch, signal }) {
  const target = androidCliPath(sdkRoot)
  await mkdir(path.dirname(target), { recursive: true })
  const { bytes, expected } = await downloadSized(androidCliUrl(), target, { fetchImpl, onProgress, signal })
  if (expected && bytes !== expected) {
    await rm(target, { force: true })
    throw new Error(`the Android CLI download stopped after ${bytes} of ${expected} bytes`
      + proxyHint())
  }
  // Downloaded files are not executable, and this one has to be.
  await chmod(target, 0o755)
  return target
}

/** Names the proxy in an error, when there is one to name. */
function proxyHint() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY
  return proxy
    ? ` — this is what the Android CLI's downloader does behind some proxies; ${proxy} is configured here,`
      + ' and going direct may be what works'
    : ''
}

/** How long to wait to reach the server. The transfer itself is unbounded. */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * The system image to install, for this machine.
 *
 * An emulator running an image built for another architecture is emulating a
 * CPU as well as a phone, which on a laptop is the difference between usable
 * and not. So the image follows the host, and `google_apis` rather than the
 * bare AOSP one because an app that calls Play services on a bare image fails
 * in a way that looks like the app's fault.
 *
 * @param {string} [arch] @returns {string}
 */
export function defaultImage(arch = process.arch) {
  const abi = arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
  return `system-images;android-35;google_apis;${abi}`
}

/** The packages a phone needs, beyond the tools that install them. */
export function requiredPackages(arch = process.arch) {
  return ['platform-tools', 'emulator', defaultImage(arch)]
}

/**
 * Whether `sdkmanager` can run at all.
 *
 * It is a Java program. Android Studio brings its own runtime and the
 * command-line tools do not, so on a machine with neither, an install that
 * looked fine until the first `sdkmanager` call fails with a stack trace
 * about a missing class. Asking first turns that into a sentence.
 *
 * @returns {Promise<boolean>}
 */
export async function hasJava() {
  return run('java', ['-version'], { timeout: 20_000 }).then(() => true, () => false)
}

/**
 * @typedef {object} Archive
 * @property {string} url absolute
 * @property {number} size bytes
 * @property {string} sha1
 */

/**
 * Finds the command-line tools download for this host.
 *
 * The index is XML and this reads it with regular expressions, which is worth
 * defending: the questions asked of it are "which archive block names my
 * operating system and architecture" and "what is its url, size and digest".
 * A parser would answer those no better, and would be a dependency.
 *
 * @param {{fetchImpl?: typeof fetch, platform?: string, arch?: string}} [options]
 * @returns {Promise<Archive>}
 */
export async function resolveTools({ fetchImpl = fetch, platform = process.platform, arch = process.arch } = {}) {
  const xml = await getText(INDEX_URL, fetchImpl)
  const block = /<remotePackage path="cmdline-tools;latest"[\s\S]*?<\/remotePackage>/.exec(xml)?.[0]
  if (!block) throw new Error('Google\'s package index no longer lists the command-line tools where this looks for them')

  const wantedOs = { darwin: 'macosx', win32: 'windows', linux: 'linux' }[platform]
  const wantedArch = arch === 'arm64' ? 'aarch64' : 'x64'
  const archives = [...block.matchAll(/<archive>[\s\S]*?<\/archive>/g)].map(match => match[0])
  const found = archives.find(entry => {
    if (hostOs(entry) !== wantedOs) return false
    const host = /<host-arch>([^<]+)<\/host-arch>/.exec(entry)?.[1]
    // No host-arch means the archive serves every architecture of that OS,
    // which is how Windows and Linux are published.
    return host === undefined || host === wantedArch
  })
  if (!found) throw new Error(`Google publishes no command-line tools for ${platform}/${arch}`)

  const url = /<url>([^<]+)<\/url>/.exec(found)?.[1]
  const size = Number(/<size>(\d+)<\/size>/.exec(found)?.[1])
  const sha1 = /<checksum type="sha1">([0-9a-f]+)<\/checksum>/.exec(found)?.[1]
  if (!url || !sha1) throw new Error('the package index gave no download for the command-line tools')
  return { url: ARCHIVE_BASE + url, size, sha1 }
}

const hostOs = entry => /<host-os>([^<]+)<\/host-os>/.exec(entry)?.[1]

/**
 * Downloads and unpacks the command-line tools.
 *
 * The digest is checked because it is published and checking it is free. An
 * SDK is a directory of programs this app is about to run; a truncated
 * download that unpacks to something almost right is a worse failure than a
 * refused one.
 *
 * Unpacked with `tar` rather than this repository's own zip reader, for the
 * reason {@link ./toolchain.js} uses it too: the reader holds the archive in
 * memory, and more to the point these entries carry an executable bit that
 * has to survive. A `sdkmanager` without it is a file, not a command.
 *
 * @param {object} options
 * @param {string} options.sdkRoot the SDK directory to build
 * @param {Archive} [options.archive] from {@link resolveTools}
 * @param {(received: number, total: number) => void} [options.onProgress]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ sdkRoot: string }>}
 */
export async function installTools({ sdkRoot, archive, onProgress, fetchImpl = fetch, signal }) {
  const wanted = archive ?? await resolveTools({ fetchImpl })
  // Two directories, and the difference is the whole reason resuming works.
  // The unpack area is wiped on every attempt, because a half-extracted tree
  // is not something to build on. The download is not: the partial file is
  // what the next attempt continues from, and putting it where the wipe
  // reaches would make the resume machinery above dead code — which it was,
  // until this was separated.
  const downloads = `${sdkRoot}.download`
  const staging = `${sdkRoot}.staging`
  await mkdir(downloads, { recursive: true })
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const zip = path.join(downloads, 'cmdline-tools.zip')

  const digest = await download(wanted.url, zip, { fetchImpl, onProgress, signal })
  if (digest !== wanted.sha1) {
    // Thrown away rather than kept for the next attempt: a file that does not
    // match its digest is not a partial download, it is a wrong one, and
    // resuming it would fail the same way for ever.
    await rm(downloads, { recursive: true, force: true })
    await rm(staging, { recursive: true, force: true })
    throw new Error('the downloaded command-line tools did not match the digest Google published for them')
  }
  await run('tar', ['-xf', zip, '-C', staging], { timeout: 600_000 })

  // The archive unpacks to `cmdline-tools/`, and `sdkmanager` insists on
  // living at `cmdline-tools/latest/` — it works out the SDK root by walking
  // up from itself, and refuses the layout the zip actually has.
  const unpacked = path.join(staging, 'cmdline-tools')
  await stat(unpacked).catch(() => {
    throw new Error('the command-line tools archive did not contain what this expected')
  })
  const destination = path.join(sdkRoot, 'cmdline-tools', 'latest')
  await mkdir(path.dirname(destination), { recursive: true })
  await rm(destination, { recursive: true, force: true })
  await rename(unpacked, destination)
  await rm(staging, { recursive: true, force: true })
  await rm(downloads, { recursive: true, force: true })
  return { sdkRoot }
}

/**
 * Installs SDK packages, reporting as it goes.
 *
 * `agreed` is a required parameter and this throws without it. There is no
 * default, because the only correct way to reach this is after somebody was
 * shown {@link LICENCE_URL} and said yes — and a default would be this
 * module having an opinion about somebody else's agreement.
 *
 * Nothing is piped to accept anything. The old `sdkmanager --licenses` took a
 * `y` on stdin and is now a no-op that prints "no longer needed"; the CLI
 * presents Google's terms itself. So the consent here gates whether this runs
 * at all, which is the honest shape: this app does not agree, it declines to
 * start until the user has.
 *
 * @param {object} options
 * @param {string} options.sdkRoot
 * @param {string[]} options.packages
 * @param {boolean} options.agreed what the user answered to the terms
 * @param {(line: string) => void} [options.onLine]
 */
export async function installPackages({ sdkRoot, packages, agreed, onLine, signal }) {
  if (!agreed) throw new Error('the Android SDK terms have not been accepted')
  return androidCli({ sdkRoot, args: ['sdk', 'install', ...packages], onLine, signal, timeout: 3_600_000 })
}

/** What the SDK already has, as the CLI reports it. */
export async function listInstalled({ sdkRoot, onLine }) {
  return androidCli({ sdkRoot, args: ['sdk', 'list'], onLine, timeout: 300_000 })
}

/**
 * Creates a virtual device from an installed system image.
 *
 * Still `avdmanager`: the new CLI took over package management and left this
 * where it was.
 *
 * @param {object} options
 * @param {string} options.sdkRoot
 * @param {string} options.name
 * @param {string} [options.image]
 * @param {(line: string) => void} [options.onLine]
 */
export async function createAvd({ sdkRoot, name, image = defaultImage(), onLine }) {
  const binary = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin',
    process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager')
  return spawnText(binary, ['create', 'avd', '-n', name, '-k', image, '--force'], {
    env: { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
    // It asks whether to customise the hardware profile; no is the answer,
    // and the default profile is what every "create me a phone" means.
    answer: 'no\n',
    onLine,
    timeout: 300_000,
  })
}

/**
 * One run of the Android CLI, pointed at the SDK it is managing.
 *
 * `ANDROID_CLI_BIN` is set as well as the binary being invoked directly, so
 * that anything the CLI shells out to — `avdmanager`, the deprecated
 * `sdkmanager` script — finds the copy this app downloaded rather than trying
 * to bootstrap its own.
 */
async function androidCli({ sdkRoot, args, onLine, timeout, signal }) {
  const binary = androidCliPath(sdkRoot)
  try {
    return await spawnText(binary, [`--sdk=${sdkRoot}`, ...args], {
      env: { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot, ANDROID_CLI_BIN: binary },
      onLine,
      timeout,
      signal,
    })
  } catch (error) {
    // The CLI's own downloader fails this way behind some proxies, and its
    // message says nothing about why. Naming the proxy turns a stack trace
    // into something the person whose network it is can act on.
    throw TRUNCATED.test(error.message) ? new Error(error.message + proxyHint()) : error
  }
}

/** How the CLI reports a transfer that stopped early. */
const TRUNCATED = /unexpected end of file|Failed to connect/i

/**
 * How big the packages about to be installed are.
 *
 * From the same index the tools read. Sizes matter here for one reason: the
 * CLI that downloads them says nothing at all while it does — measured, two
 * minutes of silence while two hundred megabytes arrived — so the only way to
 * show progress is to watch the bytes land and compare them with a total
 * somebody has to know in advance.
 *
 * @param {string[]} paths sdk-style paths, e.g. `system-images;android-35;…`
 * @param {{fetchImpl?: typeof fetch, platform?: string, arch?: string}} [options]
 * @returns {Promise<{total: number, byPath: Record<string, number>}>}
 */
export async function packageSizes(paths, { fetchImpl = fetch, platform = process.platform, arch = process.arch } = {}) {
  const wantedOs = { darwin: 'macosx', win32: 'windows', linux: 'linux' }[platform]
  const wantedArch = arch === 'arm64' ? 'aarch64' : 'x64'
  const byPath = {}
  let total = 0
  /** @type {Map<string, string>} one fetch per index, however many packages want it */
  const indexes = new Map()
  for (const wanted of paths) {
    const url = indexFor(wanted)
    if (!indexes.has(url)) indexes.set(url, await getText(url, fetchImpl))
    const xml = indexes.get(url)
    const block = new RegExp(`<remotePackage path="${escapeForRegExp(wanted)}"[\\s\\S]*?</remotePackage>`).exec(xml)?.[0]
    if (!block) continue
    const archives = [...block.matchAll(/<archive>[\s\S]*?<\/archive>/g)].map(match => match[0])
    // A package with no host-os at all is one archive for everybody, which is
    // how the system images are published.
    const found = archives.find(entry => {
      const os = /<host-os>([^<]+)<\/host-os>/.exec(entry)?.[1]
      if (os !== undefined && os !== wantedOs) return false
      const host = /<host-arch>([^<]+)<\/host-arch>/.exec(entry)?.[1]
      return host === undefined || host === wantedArch
    }) ?? archives[0]
    const size = Number(/<size>(\d+)<\/size>/.exec(found ?? '')?.[1] ?? 0)
    if (size > 0) { byPath[wanted] = size; total += size }
  }
  return { total, byPath }
}

const escapeForRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where the Android CLI puts a download while it is still arriving.
 *
 * `<sdk>/.sdk/arch/<sha1>.part`, found by looking rather than by being
 * documented, and the only progress signal the CLI offers — it prints nothing
 * to a pipe from the moment it starts until the moment it finishes.
 */
const PART_DIR = ['.sdk', 'arch']

/**
 * Watches an install happen, and reports how far along it is.
 *
 * Monotonic on purpose. A part file vanishes when its package is unpacked,
 * and reporting the sum of what is on disk right now would send the bar
 * backwards every time something completed — so a finished part is added to a
 * running total instead, and progress only ever goes forwards.
 *
 * @param {object} options
 * @param {string} options.sdkRoot
 * @param {number} [options.total] expected bytes, from {@link packageSizes}
 * @param {(state: {received: number, total: number}) => void} options.onProgress
 * @param {number} [options.intervalMs]
 * @returns {() => void} stops watching
 */
export function watchDownloads({ sdkRoot, total = 0, onProgress, intervalMs = 1_000 }) {
  const dir = path.join(sdkRoot, ...PART_DIR)
  /** @type {Map<string, number>} last seen size of each part still present */
  let inFlight = new Map()
  let finished = 0

  const tick = async () => {
    let entries
    try {
      entries = await readdir(dir)
    } catch {
      // The directory appears when the first download starts; before that
      // there is nothing to report and nothing wrong.
      return
    }
    const seen = new Map()
    for (const name of entries.filter(entry => entry.endsWith('.part'))) {
      const size = await stat(path.join(dir, name)).then(info => info.size, () => 0)
      seen.set(name, size)
    }
    for (const [name, size] of inFlight) {
      if (!seen.has(name)) finished += size
    }
    inFlight = seen
    const received = finished + [...seen.values()].reduce((sum, size) => sum + size, 0)
    onProgress({ received, total })
  }

  const timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
  // `unref` so a watcher nobody stopped cannot hold the process open.
  timer.unref?.()
  tick().catch(() => {})
  return () => { clearInterval(timer) }
}

/**
 * Runs a tool and streams its output a line at a time.
 *
 * These print progress for tens of minutes; collecting all of it and handing
 * it over at the end would be a feature that looks frozen.
 *
 * @returns {Promise<string>} everything it said
 */
function spawnText(binary, args, { env = {}, answer, onLine, timeout, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('cancelled'))
    const child = execFile(binary, args, {
      env: { ...process.env, ...env },
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      signal?.removeEventListener('abort', stop)
      if (signal?.aborted) reject(new Error('cancelled'))
      else if (error) reject(new Error(`${path.basename(binary)}: ${(stderr || stdout || error.message).trim().slice(0, 800)}`))
      else resolve(stdout)
    })
    // Killed rather than left to finish: the point of cancelling a
    // multi-gigabyte install is that it stops now. What is already on disk
    // stays, and the CLI keeps its own part files, so resuming is what
    // starting again does.
    const stop = () => { try { child.kill('SIGTERM') } catch { /* gone */ } }
    signal?.addEventListener('abort', stop, { once: true })
    if (answer !== undefined) child.stdin?.end(answer)
    let pending = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding('utf8')
      stream?.on('data', chunk => {
        pending += chunk
        const lines = pending.split(/\r?\n|\r/)
        pending = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) onLine?.(line.trim())
      })
    }
  })
}

/**
 * Downloads without a digest to check, reporting what the server promised.
 *
 * @returns {Promise<{bytes: number, expected: number}>}
 */
async function downloadSized(url, file, { fetchImpl, onProgress, signal }) {
  const part = `${file}.part`
  let already = await stat(part).then(info => info.size, () => 0)
  const response = await fetched(url, fetchImpl, already > 0 ? { Range: `bytes=${already}-` } : undefined, signal)
  const resuming = response.status === 206
  if (already > 0 && !resuming) {
    await rm(part, { force: true })
    already = 0
  }
  const expected = (Number(response.headers.get('content-length')) || 0) + already
  let received = already
  await pipeline(
    async function* () {
      for await (const chunk of response.body) {
        received += chunk.length
        onProgress?.(received, expected)
        yield chunk
      }
    },
    createWriteStream(part, resuming ? { flags: 'a' } : {}),
  )
  await rename(part, file)
  return { bytes: received, expected }
}

/** One request, with a timeout on reaching the server and none on the body. */
async function fetched(url, fetchImpl, headers, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  // The timeout applies to reaching the server; the caller's signal applies
  // to the whole thing, including a transfer already in flight.
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: combined, headers })
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
    return response
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Downloads to a `.part` beside the target, and picks up where it left off.
 *
 * A hundred and fifty megabytes is long enough for a laptop to sleep, a
 * network to drop, or a user to quit the app — and starting again from zero
 * each time is how a download on a bad connection never finishes at all. So
 * the partial file stays, and the next attempt asks for the rest of it.
 *
 * The digest is over the whole file, so a resumed download has to hash what
 * is already on disk before it can continue. That costs a read of the part —
 * cheap next to fetching those bytes again, and the alternative is trusting a
 * file this code did not watch arrive.
 *
 * A server that ignores the range and sends the whole thing answers 200
 * rather than 206, and that is not an error: it is the same download without
 * the shortcut, so the part is thrown away and it starts over.
 *
 * @returns {Promise<string>} the sha1 of what was written
 */
async function download(url, file, { fetchImpl, onProgress, signal }) {
  const part = `${file}.part`
  let already = await stat(part).then(info => info.size, () => 0)
  const hash = createHash('sha1')

  const response = await fetched(url, fetchImpl, already > 0 ? { Range: `bytes=${already}-` } : undefined, signal)
  const resuming = response.status === 206
  if (already > 0 && !resuming) {
    await rm(part, { force: true })
    already = 0
  }
  if (resuming) {
    // Everything already on disk is part of the digest, and only this side
    // knows that — the server is sending the remainder and nothing else.
    await pipeline(createReadStream(part), async function* (source) {
      for await (const chunk of source) hash.update(chunk)
    })
  }

  const total = (Number(response.headers.get('content-length')) || 0) + already
  let received = already
  // Hashed as the bytes go past and never held: this is 150MB, and buffering
  // it to digest it afterwards would put that much in the main process.
  await pipeline(
    async function* () {
      for await (const chunk of response.body) {
        received += chunk.length
        hash.update(chunk)
        onProgress?.(received, total)
        yield chunk
      }
    },
    createWriteStream(part, resuming ? { flags: 'a' } : {}),
  )
  await rename(part, file)
  return hash.digest('hex')
}

async function getText(url, fetchImpl) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}
