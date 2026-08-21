/**
 * Which skills dsh will load, and — for the ones it will not — why.
 *
 * dsh finds skills by scanning a list of roots for directories holding a
 * `SKILL.md`. Every way that can fail ends the same: `logger.warn` and a
 * silent skip. A skill whose frontmatter is missing a field, or whose name
 * has an underscore in it, is indistinguishable from one that was never
 * installed — it simply is not there, and the only account of why is a line
 * in a log the user has no reason to open. Naming that reason is what this
 * module is for; installing and removing are the easy part.
 *
 * It re-implements exactly three of dsh's rules: where the user's root is,
 * what counts as a skill inside a root, and which frontmatter fields decide
 * whether the file loads. Precedence between roots, the rank arithmetic and
 * the watcher are deliberately not mirrored — dsh is at rc, those are the
 * parts most likely to move, and a shell that guessed at them would not fail
 * loudly, it would quietly start lying. Where two roots hold the same name
 * this reports the collision and leaves the adjudication to dsh.
 *
 * Deliberately free of Electron imports, so it runs under plain node.
 */
import { readdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'

/** The skill file dsh looks for inside a directory root entry. */
export const SKILL_FILE = 'SKILL.md'

/**
 * Suffix that parks a skill without moving it.
 *
 * dsh has no notion of a disabled skill — a plugin carries `disabled: true`
 * on its loader row, but a skill's only state is whether discovery finds it.
 * Renaming the directory out of the way would work and is what a first guess
 * reaches for, except that a skill's body addresses its own files relative to
 * the directory it sits in, and anything the user pointed at that path by
 * hand breaks with it. Renaming the entry file leaves every byte where it is:
 * the directory survives, its resources survive, and discovery finds no
 * `SKILL.md` and moves on. A dot prefix, the other obvious trick, does not
 * work at all — dsh skips no dot-directory except `.system`.
 */
export const DISABLED_SUFFIX = '.off'

/**
 * Copied from `@deepseek-ai/dsh-skill`, and the reason this module exists:
 * a name outside it is not an error the user ever sees, just an absence.
 */
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Reserved by dsh on the user root; not ours to list or touch. */
const SYSTEM_ENTRY = '.system'

/**
 * Invocation keys dsh renamed. These do not degrade to a default — the parse
 * throws, and the whole skill vanishes, which is a harsh outcome for a
 * spelling the user copied from older documentation.
 */
const LEGACY_INVOCATION_KEYS = new Map([
  ['disableModelInvocation', 'disable-model-invocation'],
  ['modelInvocable', 'disable-model-invocation'],
  ['userInvocable', 'user-invocable'],
])

/**
 * @typedef {object} Problem
 * @property {string} code machine-readable; the UI maps it to a message
 * @property {string} [detail] the offending value, when quoting it helps
 * @property {boolean} fatal whether dsh drops the skill over this
 */

/**
 * @typedef {object} Skill
 * @property {string} entry the directory or file name inside the root
 * @property {string} root the root directory it was found in
 * @property {string} source dsh's own label for that root
 * @property {boolean} writable whether this shell owns the root
 * @property {string} file path to the skill's markdown, disabled or not
 * @property {string} directory what the skill's body addresses relatively
 * @property {boolean} enabled false when parked with {@link DISABLED_SUFFIX}
 * @property {string} [name] frontmatter `name`, when it reads as one
 * @property {string} [description] frontmatter `description`
 * @property {string} [whenToUse] frontmatter `whenToUse`
 * @property {Problem[]} problems empty means dsh will load it
 */

/**
 * Splits a skill file into its frontmatter fields and body.
 *
 * Only the top-level scalars are read, and only the ones that decide whether
 * the file loads. A value this cannot read confidently — a block scalar, a
 * nested mapping, an anchor — is recorded as present with an unknown value
 * rather than guessed at, because the diagnostics below are worth more when
 * they stay quiet than when they are thorough and occasionally wrong. dsh
 * runs a real YAML parser; this one only has to agree about whether a field
 * is there.
 *
 * @param {string} raw the file's contents
 * @returns {{present: boolean, fields: Map<string, string|boolean|null>}}
 *   `present` is false when the `---` fences are missing, which is the one
 *   structural failure that is unambiguous without a parser
 */
export function readFrontmatter(raw) {
  const fields = new Map()
  const duplicates = new Set()
  const malformed = new Set()
  const firstBreak = raw.indexOf('\n')
  if (firstBreak < 0) return { present: false, fields }
  if (raw.slice(0, firstBreak).replace(/\r$/, '') !== '---') return { present: false, fields }

  const lines = raw.slice(firstBreak + 1).split('\n')
  let closed = false
  for (const line of lines) {
    const text = line.replace(/\r$/, '')
    if (text === '---') { closed = true; break }
    // An indented line continues whatever key came before it. That key is
    // already recorded; its value is one this reader does not claim to know.
    if (/^\s/.test(text) || text.trim() === '' || text.trimStart().startsWith('#')) continue

    const colon = text.indexOf(':')
    if (colon < 0) continue
    const key = text.slice(0, colon).trim()
    if (key === '') continue
    const value = text.slice(colon + 1).trim()
    // YAML rejects a duplicate key outright, and the throw takes the whole
    // file with it — the skill does not lose a field, it disappears.
    if (fields.has(key)) duplicates.add(key)
    if (nestsAMapping(value)) malformed.add(key)
    fields.set(key, scalar(value))
  }
  return { present: closed, fields, duplicates, malformed }
}

/**
 * Whether an unquoted value would have YAML read a second mapping inside the
 * first, which it refuses. A colon followed by space is the case; `a:b` is
 * not, and neither is anything quoted — that is the whole discrimination,
 * and it is the one a real parser makes too.
 *
 * Worth detecting without a parser because the failure is total: one stray
 * colon in a description and the file is gone, with nothing on screen to say
 * which character did it.
 */
function nestsAMapping(value) {
  if (value.startsWith('"') || value.startsWith("'")) return false
  if (value === '|' || value === '>' || value.startsWith('|') || value.startsWith('>')) return false
  if (value.startsWith('{') || value.startsWith('[')) return false
  const bare = value.replace(/\s+#.*$/, '').trim()
  return /:\s/.test(bare) || bare.endsWith(':')
}

/**
 * The part of a `key: value` line after the colon, when it is a scalar this
 * reader is sure of. Everything else is null — see {@link readFrontmatter}.
 *
 * @param {string} text
 * @returns {string|boolean|null}
 */
function scalar(text) {
  if (text === '') return null
  // Block scalars and flow collections open a value that continues past this
  // line, or nests. Both are legal and neither is ours to interpret.
  if (text === '|' || text === '>' || text.startsWith('|') || text.startsWith('>')) return null
  if (text.startsWith('{') || text.startsWith('[') || text.startsWith('&') || text.startsWith('*')) return null

  const quoted = /^"(.*)"$|^'(.*)'$/.exec(text)
  if (quoted) return quoted[1] ?? quoted[2] ?? ''

  // Trailing comments only count when something separates them from the
  // value; `a#b` is one scalar, and dsh's parser reads it that way too.
  const value = text.replace(/\s+#.*$/, '').trim()
  return BOOLEANS.get(value.toLowerCase()) ?? value
}

/** The spellings dsh's `frontmatterBoolean` accepts, both ways. */
const BOOLEANS = new Map([
  ['true', true], ['yes', true], ['on', true], ['1', true],
  ['false', false], ['no', false], ['off', false], ['0', false],
])

/**
 * Every reason dsh would drop this file, in the order it checks them.
 *
 * @param {string} raw the file's contents
 * @param {string} entry the directory or file name it was found under
 * @returns {{problems: Problem[], name?: string, description?: string, whenToUse?: string}}
 */
export function inspect(raw, entry) {
  /** @type {Problem[]} */
  const problems = []
  const { present, fields, duplicates, malformed } = readFrontmatter(raw)
  if (!present) return { problems: [{ code: 'missing-frontmatter', fatal: true }] }

  // Both of these break the YAML parse rather than one field, so they are
  // reported before the fields are: a file with a duplicate key has no
  // fields at all as far as dsh is concerned.
  for (const key of duplicates) problems.push({ code: 'duplicate-key', detail: key, fatal: true })
  for (const key of malformed) problems.push({ code: 'unparsable-value', detail: key, fatal: true })

  /**
   * A required string field, or undefined with the reason already reported.
   *
   * The null case is this reader saying it did not read the value — a block
   * scalar, a nested mapping — not that the value is wrong. dsh runs a real
   * parser and will very likely be happy with it, so nothing is reported:
   * a diagnostic that fires on a working skill costs more than one that
   * misses a broken one, because the user believes it.
   */
  const required = (key, code) => {
    if (!fields.has(key)) { problems.push({ code: `missing-${code}`, fatal: true }); return undefined }
    const value = fields.get(key)
    if (value === null) return undefined
    if (typeof value !== 'string' || value === '') {
      problems.push({ code: `${code}-not-text`, detail: String(value), fatal: true })
      return undefined
    }
    return value
  }

  // Both fields checked rather than stopping at the first: a file missing
  // both should say so once per field.
  const name = required('name', 'name')
  const description = required('description', 'description')
  if (name !== undefined && !SKILL_NAME.test(name)) {
    problems.push({ code: 'invalid-name', detail: name, fatal: true })
  }

  for (const [legacy, canonical] of LEGACY_INVOCATION_KEYS) {
    if (fields.has(legacy)) problems.push({ code: 'legacy-invocation-key', detail: `${legacy} → ${canonical}`, fatal: true })
  }
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    const value = fields.get(key)
    if (fields.has(key) && typeof value !== 'boolean' && value !== null) {
      problems.push({ code: 'invalid-invocation-value', detail: `${key}: ${value}`, fatal: true })
    }
  }

  // Not fatal, and not dsh's opinion at all: it keys the skill by the
  // frontmatter name and never looks at the directory. Worth saying anyway,
  // because the user typed the directory name and will look for it there.
  if (name !== undefined && entry !== undefined && directoryName(entry) !== name) {
    problems.push({ code: 'name-mismatch', detail: `${directoryName(entry)} ≠ ${name}`, fatal: false })
  }

  return {
    problems,
    ...name !== undefined ? { name } : {},
    ...description !== undefined ? { description } : {},
    ...typeof fields.get('whenToUse') === 'string' && fields.get('whenToUse') !== '' ? { whenToUse: fields.get('whenToUse') } : {},
  }
}

/** A root entry's name with the markdown extension a single-file skill wears. */
function directoryName(entry) {
  return entry.endsWith('.md') ? entry.slice(0, -'.md'.length) : entry
}

/**
 * Lists what one root holds.
 *
 * Mirrors dsh's own rule and nothing more: a subdirectory is a skill when it
 * holds a `SKILL.md`, and a `.md` file sitting directly in the root is one by
 * itself. A missing root is not an error — none of them are required to
 * exist, and the user's own is absent until the first install.
 *
 * @param {{path: string, source: string, writable?: boolean}} root
 * @returns {Promise<Skill[]>}
 */
export async function listRoot(root) {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch {
    return []
  }

  const skills = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === SYSTEM_ENTRY) continue

    const full = path.join(root.path, entry.name)
    const directory = await isDirectory(entry, full)
    const found = directory
      ? await entryFile(full, SKILL_FILE)
      : markdownFile(entry.name, root.path)
    if (found === undefined) continue

    const raw = await readFile(found.file, 'utf8').catch(() => undefined)
    const inspected = raw === undefined
      ? { problems: [{ code: 'unreadable-file', fatal: true }] }
      : inspect(raw, entry.name)

    skills.push({
      entry: entry.name,
      root: root.path,
      source: root.source,
      writable: root.writable === true,
      file: found.file,
      directory: directory ? full : root.path,
      enabled: found.enabled,
      ...inspected,
    })
  }
  return skills
}

/**
 * The markdown a directory entry offers, enabled or parked.
 *
 * @returns {Promise<{file: string, enabled: boolean}|undefined>} undefined
 *   when the directory holds neither, which is dsh's "not a skill" and not a
 *   fault worth reporting: plenty of directories are just directories.
 */
async function entryFile(directory, file) {
  const active = path.join(directory, file)
  if (await exists(active)) return { file: active, enabled: true }
  const parked = active + DISABLED_SUFFIX
  if (await exists(parked)) return { file: parked, enabled: false }
  return undefined
}

/** The same question for a root-level file, which needs no filesystem call. */
function markdownFile(name, root) {
  if (name.endsWith('.md')) return { file: path.join(root, name), enabled: true }
  if (name.endsWith('.md' + DISABLED_SUFFIX)) return { file: path.join(root, name), enabled: false }
  return undefined
}

async function isDirectory(entry, full) {
  if (entry.isDirectory()) return true
  // Symlinked skill directories are how a user keeps one under version
  // control elsewhere; dsh follows them, so following them here keeps the
  // two views of the same disk in agreement.
  if (!entry.isSymbolicLink()) return false
  return stat(full).then(info => info.isDirectory()).catch(() => false)
}

async function exists(target) {
  return stat(target).then(() => true).catch(() => false)
}

/**
 * Parks an installed skill, or brings it back.
 *
 * @param {Skill} skill
 * @param {boolean} enabled
 * @returns {Promise<string>} the file's path afterwards
 */
export async function setEnabled(skill, enabled) {
  if (skill.enabled === enabled) return skill.file
  const target = enabled
    ? skill.file.slice(0, -DISABLED_SUFFIX.length)
    : skill.file + DISABLED_SUFFIX
  await rename(skill.file, target)
  return target
}

/**
 * The roots this shell can describe.
 *
 * Only the two user-level roots and the preset's own: the project roots dsh
 * also scans hang off the session's working directory, and the shell hands
 * the server one at startup without ever learning which workspace the page
 * went on to open. Listing them from here would mean guessing at that, and a
 * skills window that shows the wrong project's skills is worse than one that
 * admits it only covers the user's own.
 *
 * @param {{dshHome: string, agentsHome?: string, bundledDir?: string}} paths
 * @returns {{path: string, source: string, writable?: boolean}[]}
 */
export function roots({ dshHome, agentsHome, bundledDir }) {
  const list = [{ path: path.join(dshHome, 'skills'), source: 'user-dsh', writable: true }]
  // Shared with whatever else on this machine reads ~/.agents. Shown so the
  // user can see why a name collides or where one came from, never written.
  if (agentsHome) list.push({ path: path.join(agentsHome, 'skills'), source: 'user-agents' })
  if (bundledDir) list.push({ path: bundledDir, source: 'bundled' })
  return list
}

/**
 * Every skill the shell can see, with the collisions marked.
 *
 * @param {{dshHome: string, agentsHome?: string, bundledDir?: string}} paths
 * @returns {Promise<Skill[]>}
 */
export async function listSkills(paths) {
  const found = (await Promise.all(roots(paths).map(listRoot))).flat()
  const counts = new Map()
  for (const skill of found) {
    if (skill.name === undefined || !skill.enabled) continue
    counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1)
  }
  for (const skill of found) {
    if (skill.name === undefined || (counts.get(skill.name) ?? 0) < 2) continue
    // Which one wins is dsh's ranking to decide, and this deliberately does
    // not mirror it — saying that two exist is the honest half.
    skill.problems = [...skill.problems, { code: 'shadowed', detail: skill.name, fatal: false }]
  }
  return found
}
