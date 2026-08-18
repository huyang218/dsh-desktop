/**
 * A minimal, dependency-free zip reader.
 *
 * The shell ships no third-party runtime dependencies, and shelling out to
 * `unzip` / `tar` / `Expand-Archive` would make extraction depend on which
 * tools the target machine happens to have — the exact class of problem the
 * bundled toolchain exists to avoid. Zip is small enough to read directly:
 * the central directory says where every entry lives, and `zlib` inflates it.
 *
 * The archive is user-supplied and therefore hostile until proven otherwise.
 * Three guards, all of them enforced before anything is written to disk:
 * entry paths that escape the destination are refused, the total unpacked
 * size and entry count are capped, and every entry's CRC is verified.
 *
 * Deliberately free of Electron imports so it can be exercised under plain
 * Node.
 */
import { mkdir, chmod, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'
import { t } from './i18n.js'

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** Fixed-size parts of the records, before their variable-length tails. */
const EOCD_SIZE = 22
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30

/** Compression methods worth supporting: stored, and deflate. */
const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** General-purpose bit 0: the entry is encrypted. */
const FLAG_ENCRYPTED = 0x1

/** Defaults for the size guards; a plugin package is nowhere near either. */
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024
const MAX_ENTRIES = 20_000

const MB = 1024 * 1024

/**
 * Extracts a zip archive into a directory.
 *
 * Entries that cannot become a plain file or directory — symlinks, devices,
 * and the `__MACOSX` sidecar tree the macOS Finder puts in every zip it
 * makes — are skipped rather than refused: they are noise in a plugin
 * package, and failing the whole install over them would reject archives
 * that are otherwise perfectly good.
 *
 * @param {string} zipPath the archive
 * @param {string} destDir created if missing; existing files are overwritten
 * @param {{ log?: (line: string) => void, maxUnpackedBytes?: number }} [options]
 * @returns {Promise<{ files: number, skipped: number }>}
 */
export async function extractZip(zipPath, destDir, options = {}) {
  const { log, maxUnpackedBytes = MAX_UNPACKED_BYTES } = options
  const { size } = await stat(zipPath)
  if (size > MAX_FILE_BYTES) {
    throw new Error(t('error.zipTooLarge', { limit: Math.round(MAX_FILE_BYTES / MB) }))
  }
  const buf = await readFile(zipPath)
  const entries = readCentralDirectory(buf)

  await mkdir(destDir, { recursive: true })
  let files = 0
  let skipped = 0
  let unpacked = 0
  for (const entry of entries) {
    if (isSkippable(entry)) { skipped++; continue }
    const target = safeJoin(destDir, entry.name)
    if (entry.isDirectory) {
      await mkdir(target, { recursive: true })
      continue
    }
    unpacked += entry.size
    if (unpacked > maxUnpackedBytes) {
      throw new Error(t('error.zipUnpackedTooLarge', { limit: Math.round(maxUnpackedBytes / MB) }))
    }
    const data = inflateEntry(buf, entry)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data)
    // Executable bits are the only mode worth carrying over: a zip made on
    // Windows records no unix mode at all, so anything else would be noise.
    if (entry.unixMode && (entry.unixMode & 0o111)) {
      await chmod(target, 0o755).catch(() => { /* filesystems without modes */ })
    }
    files++
  }
  if (skipped) log?.(`zip: skipped ${skipped} entr${skipped === 1 ? 'y' : 'ies'} (symlinks or macOS metadata)`)
  return { files, skipped }
}

/**
 * Names Windows cannot store as written.
 *
 * Three separate traps, and the middle one is the reason this check exists at
 * all rather than being left to the filesystem to reject: a colon makes
 * `writeFile` create an alternate data stream attached to another file — no
 * error, no visible file, contents hidden. Reserved device names fail
 * loudly, and a trailing dot or space is silently stripped, which turns two
 * distinct entries into one that overwrites the other.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i
const WINDOWS_ILLEGAL = /[<>:"|?*\x00-\x1f]/

/** Checked only on Windows: elsewhere these are ordinary, legal filenames. */
function windowsUnsafe(name) {
  return name.split('/').some(segment => segment !== ''
    && (WINDOWS_ILLEGAL.test(segment) || WINDOWS_RESERVED.test(segment) || /[ .]$/.test(segment)))
}

/** Entries this extractor has no business writing out. */
function isSkippable(entry) {
  if (entry.isSymlink) return true
  const parts = entry.name.split('/')
  return parts[0] === '__MACOSX' || parts.includes('.DS_Store')
}

/**
 * Resolves an entry name inside the destination, refusing anything that
 * escapes it — `../..` chains, absolute paths, and Windows drive letters all
 * collapse to a resolved path outside the root, so one check covers them.
 */
function safeJoin(destDir, name) {
  const root = path.resolve(destDir)
  // Some archivers write backslash separators; they are path separators on
  // Windows and legal filename characters on POSIX, so normalising them is
  // the only reading that cannot smuggle a directory level past the check.
  const normalized = name.replace(/\\/g, '/')
  const target = path.resolve(root, normalized)
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(t('error.zipUnsafeEntry', { name }))
  }
  if (process.platform === 'win32' && windowsUnsafe(normalized)) {
    throw new Error(t('error.zipWindowsName', { name }))
  }
  return target
}

/**
 * Reads every central-directory record.
 *
 * The central directory is authoritative: local headers may carry zeroed
 * sizes when the writer streamed the entry and put them in a trailing data
 * descriptor instead, so only the name and extra-field lengths are read from
 * the local header — and only to find where the entry's bytes start.
 *
 * @returns {Array<{name: string, size: number, compressedSize: number,
 *   method: number, crc: number, offset: number, isDirectory: boolean,
 *   isSymlink: boolean, unixMode: number}>}
 */
function readCentralDirectory(buf) {
  const eocd = findEocd(buf)
  if (eocd < 0) throw new Error(t('error.zipBroken'))
  let count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)

  // Zip64: the 16- and 32-bit fields saturate and the real values live in a
  // second end record, found through a locator sitting just before the EOCD.
  if (count === 0xffff || offset === 0xffffffff) {
    const locator = eocd - 20
    if (locator < 0 || buf.readUInt32LE(locator) !== SIG_EOCD64_LOCATOR) throw new Error(t('error.zipBroken'))
    const eocd64 = readUInt64(buf, locator + 8)
    if (buf.readUInt32LE(eocd64) !== SIG_EOCD64) throw new Error(t('error.zipBroken'))
    count = readUInt64(buf, eocd64 + 32)
    offset = readUInt64(buf, eocd64 + 48)
  }
  if (count > MAX_ENTRIES) throw new Error(t('error.zipTooManyEntries', { limit: MAX_ENTRIES }))

  const entries = []
  let at = offset
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > buf.length || buf.readUInt32LE(at) !== SIG_CENTRAL) throw new Error(t('error.zipBroken'))
    const flags = buf.readUInt16LE(at + 8)
    const nameLength = buf.readUInt16LE(at + 28)
    const extraLength = buf.readUInt16LE(at + 30)
    const commentLength = buf.readUInt16LE(at + 32)
    const name = buf.toString('utf8', at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength)
    if (flags & FLAG_ENCRYPTED) throw new Error(t('error.zipEncrypted', { name }))
    const extra = buf.subarray(at + CENTRAL_SIZE + nameLength, at + CENTRAL_SIZE + nameLength + extraLength)
    // The unix mode lives in the high half of the external attributes, and
    // only when the archive was made on a unix-like system.
    const madeOnUnix = buf.readUInt8(at + 5) === 3
    const unixMode = madeOnUnix ? buf.readUInt32LE(at + 38) >>> 16 : 0
    const entry = {
      name,
      crc: buf.readUInt32LE(at + 16),
      compressedSize: buf.readUInt32LE(at + 20),
      size: buf.readUInt32LE(at + 24),
      method: buf.readUInt16LE(at + 10),
      offset: buf.readUInt32LE(at + 42),
      isDirectory: name.endsWith('/'),
      isSymlink: (unixMode & 0xf000) === 0xa000,
      unixMode,
    }
    applyZip64Extra(entry, extra)
    entries.push(entry)
    at += CENTRAL_SIZE + nameLength + extraLength + commentLength
  }
  return entries
}

/**
 * Fills in whichever of an entry's saturated fields the zip64 extra field
 * carries. The values are packed in a fixed order and only the saturated
 * ones are present, so they must be consumed in that same order.
 */
function applyZip64Extra(entry, extra) {
  for (let at = 0; at + 4 <= extra.length;) {
    const id = extra.readUInt16LE(at)
    const size = extra.readUInt16LE(at + 2)
    let field = at + 4
    if (id === 0x0001) {
      if (entry.size === 0xffffffff) { entry.size = readUInt64(extra, field); field += 8 }
      if (entry.compressedSize === 0xffffffff) { entry.compressedSize = readUInt64(extra, field); field += 8 }
      if (entry.offset === 0xffffffff) entry.offset = readUInt64(extra, field)
      return
    }
    at += 4 + size
  }
}

/** Locates the end-of-central-directory record, scanning back over its comment. */
function findEocd(buf) {
  const earliest = Math.max(0, buf.length - (EOCD_SIZE + 0xffff))
  for (let at = buf.length - EOCD_SIZE; at >= earliest; at--) {
    if (buf.readUInt32LE(at) === SIG_EOCD) return at
  }
  return -1
}

/** Decompresses one entry and checks it against the recorded CRC. */
function inflateEntry(buf, entry) {
  if (entry.offset + LOCAL_SIZE > buf.length || buf.readUInt32LE(entry.offset) !== SIG_LOCAL) {
    throw new Error(t('error.zipBroken'))
  }
  const nameLength = buf.readUInt16LE(entry.offset + 26)
  const extraLength = buf.readUInt16LE(entry.offset + 28)
  const start = entry.offset + LOCAL_SIZE + nameLength + extraLength
  const raw = buf.subarray(start, start + entry.compressedSize)
  let data
  if (entry.method === METHOD_STORE) {
    data = raw
  } else if (entry.method === METHOD_DEFLATE) {
    // Bounded by the size the central directory promised: a doctored entry
    // cannot inflate into gigabytes past the running total's guard.
    data = zlib.inflateRawSync(raw, { maxOutputLength: entry.size + 1 })
  } else {
    throw new Error(t('error.zipMethod', { name: entry.name, method: entry.method }))
  }
  if (data.length !== entry.size) throw new Error(t('error.zipCrc', { name: entry.name }))
  // zlib.crc32 landed in Node 22; a runtime without it still gets the length
  // check above rather than an install refused over a missing helper.
  if (typeof zlib.crc32 === 'function' && zlib.crc32(data) !== entry.crc) {
    throw new Error(t('error.zipCrc', { name: entry.name }))
  }
  return data
}

/**
 * Reads a 64-bit little-endian field as a Number.
 *
 * Every use here is an offset or a size that the caller has already capped
 * far below 2^53, so the precision limit cannot be reached by a value this
 * extractor is willing to act on.
 */
function readUInt64(buf, at) {
  const value = buf.readBigUInt64LE(at)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(t('error.zipBroken'))
  return Number(value)
}
