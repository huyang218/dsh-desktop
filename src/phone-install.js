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
 * It does not accept the licence. `sdkmanager` will take a `y` on stdin and
 * this could send one, which would make an agreement between the user and
 * Google into a thing this app did on their behalf while they were looking
 * elsewhere. The acceptance is passed in, by a caller that showed the terms
 * and got an answer.
 *
 * Electron-free.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Where Google publishes what it has, and where the archives sit. */
const INDEX_URL = 'https://dl.google.com/android/repository/repository2-3.xml'
const ARCHIVE_BASE = 'https://dl.google.com/android/repository/'

/** The terms `sdkmanager` will not proceed without. */
export const LICENCE_URL = 'https://developer.android.com/studio/terms'

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
export async function installTools({ sdkRoot, archive, onProgress, fetchImpl = fetch }) {
  const wanted = archive ?? await resolveTools({ fetchImpl })
  const staging = `${sdkRoot}.staging`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  const zip = path.join(staging, 'cmdline-tools.zip')

  const digest = await download(wanted.url, zip, { fetchImpl, onProgress })
  if (digest !== wanted.sha1) {
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
  return { sdkRoot }
}

/**
 * Accepts the SDK licences, having been told to.
 *
 * `accepted` is a parameter and not a default, and this throws rather than
 * asking, because there is exactly one right way for this to be called: after
 * a person has been shown {@link LICENCE_URL} and said yes.
 *
 * @param {object} options
 * @param {string} options.sdkRoot
 * @param {boolean} options.accepted what the user answered
 * @param {(line: string) => void} [options.onLine]
 */
export async function acceptLicences({ sdkRoot, accepted, onLine }) {
  if (!accepted) throw new Error('the Android SDK licences have not been accepted')
  return sdkmanager({ sdkRoot, args: ['--licenses'], answer: 'y\n'.repeat(40), onLine })
}

/**
 * Installs SDK packages, reporting as it goes.
 *
 * @param {object} options
 * @param {string} options.sdkRoot
 * @param {string[]} options.packages
 * @param {(line: string) => void} [options.onLine]
 */
export async function installPackages({ sdkRoot, packages, onLine }) {
  return sdkmanager({ sdkRoot, args: [...packages], onLine, timeout: 3_600_000 })
}

/**
 * Creates a virtual device from an installed system image.
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

/** One `sdkmanager` run, pointed at the SDK it is installing into. */
function sdkmanager({ sdkRoot, args, answer, onLine, timeout = 600_000 }) {
  const binary = path.join(sdkRoot, 'cmdline-tools', 'latest', 'bin',
    process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager')
  return spawnText(binary, [`--sdk_root=${sdkRoot}`, ...args], {
    env: { ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot },
    answer,
    onLine,
    timeout,
  })
}

/**
 * Runs a tool and streams its output a line at a time.
 *
 * These print progress percentages for tens of minutes; collecting all of it
 * and handing it over at the end would be a feature that looks frozen.
 *
 * @returns {Promise<string>} everything it said
 */
function spawnText(binary, args, { env = {}, answer, onLine, timeout }) {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, {
      env: { ...process.env, ...env },
      timeout,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${path.basename(binary)}: ${(stderr || stdout || error.message).trim().slice(0, 800)}`))
      else resolve(stdout)
    })
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

/** @returns {Promise<string>} the sha1 of what was written */
async function download(url, file, { fetchImpl, onProgress }) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${url}`)
  const total = Number(response.headers.get('content-length')) || 0
  const hash = createHash('sha1')
  let received = 0
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
    createWriteStream(file),
  )
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
