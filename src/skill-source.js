/**
 * Where a skill came from, and whether it has moved on since.
 *
 * A skill has no version. No registry declares one, no manifest carries one,
 * and nothing in the file changes when its author edits it — so "update this
 * skill" means nothing unless the shell remembers where the copy came from.
 * So it does, and the note it keeps is chosen for what checking it costs.
 *
 * Nothing here downloads a repository. The first attempt did — a zipball per
 * install, another per update — which is megabytes to place three kilobytes,
 * and it asked the API for a commit per repository per check, against an
 * unauthenticated limit of sixty an hour shared with everything else the app
 * does. Conditional requests do not rescue that: a 304 from api.github.com
 * decrements the remaining count exactly as a 200 does, which is worth
 * knowing before building on the opposite assumption.
 *
 * What this uses instead:
 *
 * - **One trees call to find skills.** `git/trees/…?recursive=1` returns the
 *   whole file list in a single request, tens of kilobytes, and the SKILL.md
 *   paths fall out of it. Nothing is fetched to discover what is there.
 * - **raw.githubusercontent.com to fetch and to check.** It carries no
 *   rate-limit headers because it is not the API, it honours `If-None-Match`,
 *   and an unchanged file answers 304 with no body. An update check is
 *   therefore one conditional GET per skill that costs no quota and, in the
 *   common case, no bytes.
 *
 * The consequence, stated plainly because it is a real limit: an update is
 * offered when the skill's own SKILL.md changed. A repository that edits only
 * a resource beside it goes unnoticed until the skill's text moves too. That
 * is the price of not spending the API on every skill on every check, and for
 * a file that *is* the skill it is a fair one.
 *
 * Deliberately free of Electron imports; the caller injects fetch.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

const REQUEST_TIMEOUT_MS = 30_000
/**
 * A skill's own files; more than this is a repository, not a skill.
 *
 * Generous, and checked where it can be reported. An early version applied it
 * as a filter while listing, which dropped a perfectly good 43-file skill out
 * of the results with nothing said — the exact silence this whole feature
 * exists to end, reproduced inside it.
 */
const MAX_FILES = 250
/** One file. A skill is prose and a few references. */
const MAX_FILE_BYTES = 4 * 1024 * 1024
/** Everything one skill brings with it. */
const MAX_SKILL_BYTES = 32 * 1024 * 1024
/** How many of a skill's files to fetch at once. */
const CONCURRENCY = 5

export const SKILL_FILE = 'SKILL.md'

/**
 * @typedef {object} Origin
 * @property {string} repo `owner/name`
 * @property {string} [subpath] the directory inside the repository
 * @property {string} [ref] the branch or tag asked for, when one was
 * @property {string} [etag] of SKILL.md, for the next conditional request
 * @property {string} [digest] of SKILL.md, because an ETag can change while
 *   the bytes do not — a CDN is entitled to that, and offering an update
 *   over it would be a lie the user cannot check
 */

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * A repository web URL, a `github:` spec, or a bare `owner/repo`, optionally
 * pointing into a subdirectory — the shape of a link to one skill inside a
 * collection, which is how most of them are published.
 */
const GITHUB_URL = /^(?:https?:\/\/(?:www\.)?github\.com\/|github:)([^/]+\/[^/?#]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/

/**
 * @param {string} input whatever the user pasted
 * @returns {{repo: string, ref?: string, subpath?: string}|undefined}
 */
export function parseSource(input) {
  const raw = String(input ?? '').trim()
  const match = GITHUB_URL.exec(raw)
  if (match) {
    const [, repo, ref, subpath] = match
    if (!OWNER_REPO.test(repo)) return undefined
    return { repo, ...ref ? { ref } : {}, ...subpath ? { subpath: subpath.replace(/\/+$/, '') } : {} }
  }
  return OWNER_REPO.test(raw) ? { repo: raw } : undefined
}

/**
 * The skills a repository holds, and the files each is made of.
 *
 * One request for any number of skills. The tree comes back flat, so a skill
 * is a directory holding a SKILL.md and its files are the entries beneath
 * that directory — no walking, no second request, and nothing fetched that
 * the user did not ask to install.
 *
 * @param {{repo: string, ref?: string, subpath?: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{skills: {subpath: string, files: {path: string, size: number}[]}[]}>}
 */
export async function listRepoSkills({ repo, ref, subpath, fetchImpl = fetch }) {
  const tree = await getJson(
    `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref ?? 'HEAD')}?recursive=1`,
    fetchImpl,
  )
  const blobs = (tree?.tree ?? []).filter(entry => entry.type === 'blob')

  const wanted = subpath === undefined ? undefined : subpath.replace(/\/+$/, '')
  const roots = blobs
    .filter(entry => entry.path === SKILL_FILE || entry.path.endsWith('/' + SKILL_FILE))
    .map(entry => entry.path.slice(0, -SKILL_FILE.length).replace(/\/$/, ''))
    .filter(root => wanted === undefined || root === wanted || root.startsWith(wanted + '/'))

  const skills = roots.map(root => ({
    subpath: root,
    files: blobs
      .filter(entry => (root === '' ? true : entry.path.startsWith(root + '/')))
      // A nested skill's files belong to it, not to its parent: a collection
      // whose root also holds a SKILL.md would otherwise claim every file in
      // the repository as its own.
      .filter(entry => !roots.some(other => other !== root && other.startsWith(root === '' ? '' : root + '/')
        && entry.path.startsWith(other + '/')))
      .map(entry => ({ path: entry.path, size: Number(entry.size) || 0 })),
  })).filter(skill => skill.files.length > 0)

  if (skills.length === 0 && tree?.truncated === true) {
    // The tree came back cut short and nothing was found in what arrived.
    // Saying so beats reporting "no skills here" about a repository that has
    // them, and the fix — link to the directory — is one the user can act on.
    throw refuse('source-too-large', repo)
  }
  return { skills }
}

/**
 * Downloads one skill's files into a directory.
 *
 * @param {{repo: string, ref?: string, files: {path: string, size: number}[],
 *   subpath: string, dest: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{etag?: string, digest: string}>} the SKILL.md's identity,
 *   which is what a later check compares against
 */
export async function fetchSkill({ repo, ref, files, subpath, dest, fetchImpl = fetch }) {
  // Checked here rather than while listing, so an oversized skill is a
  // refusal the user can read next to the ones that installed, not an entry
  // that quietly failed to appear.
  if (files.length > MAX_FILES) throw refuse('source-too-many-files', String(files.length))
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_SKILL_BYTES) throw refuse('source-too-large', `${Math.round(total / 1024 / 1024)}MB`)

  let identity
  const queue = [...files]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      if (next.size > MAX_FILE_BYTES) throw refuse('source-too-large', next.path)
      const relative = subpath === '' ? next.path : next.path.slice(subpath.length + 1)
      const target = path.join(dest, relative)
      const { body, etag } = await getRaw({ repo, ref, filePath: next.path, fetchImpl })
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, body)
      if (relative === SKILL_FILE) identity = { ...etag ? { etag } : {}, digest: digestOf(body) }
    }
  })
  await Promise.all(workers)
  if (identity === undefined) throw refuse('no-skill-file', subpath || repo)
  return identity
}

/**
 * Whether a skill's own file has changed at its source.
 *
 * The conditional request is the whole point: an unchanged skill answers 304
 * with no body, off a CDN that has no rate limit to spend. Fifty installed
 * skills cost fifty small round trips and nothing else.
 *
 * @param {{origin: Origin, fetchImpl?: typeof fetch}} options
 * @returns {Promise<{changed: boolean, etag?: string, digest?: string}>}
 */
export async function probeSkill({ origin, fetchImpl = fetch }) {
  const filePath = origin.subpath ? `${origin.subpath}/${SKILL_FILE}` : SKILL_FILE
  const { status, body, etag } = await getRaw({
    repo: origin.repo, ref: origin.ref, filePath, etag: origin.etag, fetchImpl,
  })
  if (status === 304) return { changed: false, etag: origin.etag, digest: origin.digest }
  const digest = digestOf(body)
  // The digest decides, not the ETag: a CDN may hand out a new one for the
  // same bytes, and an update badge the user cannot explain is worse than a
  // missed one.
  return { changed: origin.digest !== undefined && digest !== origin.digest, etag, digest }
}

/**
 * Which installed skills have changed at their source.
 *
 * @param {{origins: Record<string, Origin>, fetchImpl?: typeof fetch,
 *   log?: (line: string) => void}} options
 * @returns {Promise<Record<string, {digest: string, etag?: string}>>}
 */
export async function findSkillUpdates({ origins, fetchImpl = fetch, log }) {
  const entries = Object.entries(origins).filter(([, origin]) => origin?.repo)
  const updates = {}
  const queue = [...entries]
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [entry, origin] = next
      try {
        const result = await probeSkill({ origin, fetchImpl })
        if (result.changed) updates[entry] = { digest: result.digest, ...result.etag ? { etag: result.etag } : {} }
      } catch (error) {
        // One unreachable repository must not hide the others' answers.
        log?.(`update check: ${entry}: ${error?.code ?? error?.message ?? error}`)
      }
    }
  })
  await Promise.all(workers)
  return updates
}

/** @param {string} file @returns {Promise<Record<string, Origin>>} */
export async function readOrigins(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // A missing index means no skill has a known origin, which is what a
    // fresh install looks like — not an error to report.
    return {}
  }
}

/**
 * @param {string} file
 * @param {(origins: Record<string, Origin>) => void} mutate
 */
export async function writeOrigins(file, mutate) {
  const origins = await readOrigins(file)
  mutate(origins)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(origins, null, 2))
  return origins
}

function digestOf(body) {
  return createHash('sha256').update(body).digest('hex').slice(0, 16)
}

/**
 * One file from the raw CDN, conditionally when an ETag is known.
 *
 * @returns {Promise<{status: number, body: Buffer, etag?: string}>}
 */
async function getRaw({ repo, ref, filePath, etag, fetchImpl }) {
  const url = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref ?? 'HEAD')}/`
    + filePath.split('/').map(encodeURIComponent).join('/')
  const response = await withTimeout(signal => fetchImpl(url, {
    headers: etag ? { 'if-none-match': etag } : {}, signal,
  }))
  if (response.status === 304) return { status: 304, body: Buffer.alloc(0) }
  if (response.status === 404) throw refuse('source-not-found', filePath)
  if (!response.ok) throw refuse('source-unreachable', `HTTP ${response.status}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.byteLength > MAX_FILE_BYTES) throw refuse('source-too-large', filePath)
  return { status: response.status, body, etag: response.headers.get('etag') ?? undefined }
}

async function getJson(url, fetchImpl) {
  const response = await withTimeout(signal => fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json' }, signal,
  }))
  // The unauthenticated limit is sixty an hour and shared with every other
  // GitHub request the app makes, so it is named rather than reported as a
  // bare 403 the user would read as "this repository is private".
  if (response.status === 403 || response.status === 429) throw refuse('source-rate-limited')
  if (response.status === 404) throw refuse('source-not-found', url.split('/repos/')[1]?.split('/git/')[0])
  if (!response.ok) throw refuse('source-unreachable', `HTTP ${response.status}`)
  return await response.json()
}

function refuse(code, detail) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail })
}

async function withTimeout(run) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    return await run(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}
