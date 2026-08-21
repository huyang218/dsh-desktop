/**
 * Where a skill came from, and whether it has moved on since.
 *
 * A skill has no version. There is no registry to ask, no manifest that
 * declares one, nothing in the file that changes when its author edits it —
 * which leaves "update this skill" with no meaning at all unless the shell
 * remembers where the copy came from. So it does: an install from GitHub
 * writes down the repository, the path inside it, and the commit that was
 * current, and updating is fetching that repository again and seeing whether
 * the commit moved.
 *
 * The index lives with the shell's own settings rather than inside the skill
 * directory. A file dropped in there would sit in a folder the user edits by
 * hand and syncs between machines, and it is not theirs — it is the shell's
 * note to itself. Skills installed from a local folder get no entry, which is
 * the honest answer for a copy whose source may since have been deleted or
 * moved: they show no update, rather than a broken one.
 *
 * Deliberately free of Electron imports; the caller injects fetch.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractZip } from './zip.js'

/** A repository archive; anything larger is not a skill collection. */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
/** How deep to look for skills in a downloaded tree. */
const MAX_DEPTH = 4
/** How many skills one repository may install at once. */
const MAX_SKILLS = 64

/**
 * @typedef {object} Origin
 * @property {string} repo `owner/name`
 * @property {string} [subpath] the directory inside the repository, when the
 *   skill is one of several it holds
 * @property {string} sha the commit this copy was taken from
 * @property {string} [ref] the branch or tag asked for, when one was
 */

/** GitHub's own limits for the two path segments. */
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * A repository web URL, a `github:` spec, or a bare `owner/repo`, optionally
 * pointing into a subdirectory — the shape of a link to one skill inside a
 * collection, which is how most of them are published.
 */
const GITHUB_URL = /^(?:https?:\/\/(?:www\.)?github\.com\/|github:)([^/]+\/[^/?#]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/

/**
 * Reads whatever the user pasted as a repository and a place inside it.
 *
 * @param {string} input
 * @returns {{repo: string, ref?: string, subpath?: string}|undefined}
 *   undefined when this is not a GitHub reference at all
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
 * The commit a reference currently points at.
 *
 * One request, and the same one for a check and for an install: asking for
 * the newest commit of a branch answers both "what is there" and "has it
 * moved", and the unauthenticated rate limit is low enough that a second
 * request per skill would be felt.
 *
 * @param {{repo: string, ref?: string, fetchImpl?: typeof fetch}} options
 * @returns {Promise<string>} the full commit sha
 */
export async function resolveCommit({ repo, ref, fetchImpl = fetch }) {
  const query = ref ? `?per_page=1&sha=${encodeURIComponent(ref)}` : '?per_page=1'
  const commits = await getJson(`https://api.github.com/repos/${repo}/commits${query}`, fetchImpl)
  const sha = Array.isArray(commits) ? commits[0]?.sha : undefined
  if (typeof sha !== 'string' || sha === '') throw refuse('source-no-commit', repo)
  return sha
}

/**
 * Downloads a repository at one commit and unpacks it.
 *
 * Straight from codeload rather than through the API's redirect: the archive
 * is the one thing here that does not have to spend a request against an
 * hourly limit shared with the update checks.
 *
 * @param {{repo: string, sha: string, fetchImpl?: typeof fetch, log?: (line: string) => void}} options
 * @returns {Promise<{dir: string, dispose: () => Promise<void>}>}
 */
export async function downloadRepo({ repo, sha, fetchImpl = fetch, log }) {
  const staging = await mkdtemp(path.join(tmpdir(), 'dsh-skill-'))
  const dispose = () => rm(staging, { recursive: true, force: true }).catch(() => {})
  try {
    const archive = path.join(staging, 'repo.zip')
    const response = await withTimeout(signal => fetchImpl(
      `https://codeload.github.com/${repo}/zip/${sha}`, { signal },
    ))
    if (!response.ok) throw refuse('source-unreachable', `HTTP ${response.status}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw refuse('source-too-large', repo)
    await writeFile(archive, bytes)
    const unpacked = path.join(staging, 'tree')
    await extractZip(archive, unpacked, { log })
    // GitHub wraps everything in one `name-sha` directory.
    const entries = (await readdir(unpacked, { withFileTypes: true })).filter(e => e.isDirectory())
    return { dir: entries.length === 1 ? path.join(unpacked, entries[0].name) : unpacked, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

/**
 * Every skill in a downloaded tree, as a path relative to its root.
 *
 * The three layouts the published collections actually use are all just this
 * search: a `SKILL.md` at the top for a repository that is one skill, and any
 * number of them nested for a repository that is a collection — which is why
 * nothing here special-cases a `skills/` directory. Depth is bounded because
 * an unbounded walk of an arbitrary repository is somebody else's node_modules.
 *
 * @param {string} root
 * @param {string} [subpath] restrict the search to one directory
 * @returns {Promise<string[]>} directories, relative to `root`, holding a SKILL.md
 */
export async function findSkills(root, subpath) {
  const base = subpath ? path.join(root, subpath) : root
  const found = []
  const walk = async (dir, depth) => {
    if (found.length >= MAX_SKILLS || depth > MAX_DEPTH) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some(entry => entry.isFile() && entry.name === 'SKILL.md')) {
      found.push(path.relative(root, dir))
      // Not descending further: a skill's own directory holds its resources,
      // and a SKILL.md among them is a reference, not a second skill.
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
      await walk(path.join(dir, entry.name), depth + 1)
    }
  }
  await walk(base, 0)
  return found
}

/**
 * The recorded origins, keyed by the entry name in the skills directory.
 *
 * @param {string} file
 * @returns {Promise<Record<string, Origin>>}
 */
export async function readOrigins(file) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    // A missing or unreadable index means no skill has a known origin, which
    // is exactly what a fresh install looks like — not an error to report.
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

/**
 * Which installed skills have moved on at their source.
 *
 * Repositories are asked once each however many skills came from them: a
 * collection of twelve is one commit, and twelve requests against a limit of
 * sixty an hour would be the difference between working and not.
 *
 * @param {{origins: Record<string, Origin>, fetchImpl?: typeof fetch, log?: (line: string) => void}} options
 * @returns {Promise<Record<string, string>>} entry name → the newer commit
 */
export async function findSkillUpdates({ origins, fetchImpl = fetch, log }) {
  const heads = new Map()
  const updates = {}
  for (const [entry, origin] of Object.entries(origins)) {
    if (!origin?.repo || !origin?.sha) continue
    const key = `${origin.repo}@${origin.ref ?? ''}`
    if (!heads.has(key)) {
      heads.set(key, resolveCommit({ repo: origin.repo, ref: origin.ref, fetchImpl }).catch(error => {
        // One unreachable repository must not hide the others' answers.
        log?.(`update check: ${origin.repo}: ${error?.message ?? error}`)
        return undefined
      }))
    }
    const head = await heads.get(key)
    if (head !== undefined && head !== origin.sha) updates[entry] = head
  }
  return updates
}

function refuse(code, detail) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail })
}

async function getJson(url, fetchImpl) {
  const response = await withTimeout(signal => fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json' }, signal,
  }))
  // The unauthenticated limit is sixty an hour and shared with every other
  // GitHub request the app makes, so it is named rather than reported as a
  // bare 403 the user would read as "this repository is private".
  if (response.status === 403 || response.status === 429) throw refuse('source-rate-limited')
  if (response.status === 404) throw refuse('source-not-found', url.split('/repos/')[1]?.split('/commits')[0])
  if (!response.ok) throw refuse('source-unreachable', `HTTP ${response.status}`)
  return await response.json()
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
