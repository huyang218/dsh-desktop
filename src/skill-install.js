/**
 * Putting a skill into the directory dsh reads, and taking it out again.
 *
 * There is no package manager in this story. A skill is a directory with a
 * `SKILL.md` in it, dsh watches the root and picks up what appears, and the
 * whole of installing is a copy into the right place under the right name.
 * What earns a module is the two things a copy does not do on its own:
 * refusing an archive that would land somewhere it was not asked to, and
 * refusing a skill dsh would silently drop once it got there.
 *
 * The second is the point. dsh reads a skill's own frontmatter for its name
 * and ignores the directory, so a skill installed under the folder name the
 * user happened to have unzips fine and then answers to something else — or,
 * when the frontmatter is malformed, to nothing at all, with no error
 * anywhere the user can see it. Both are checked here, before anything is
 * moved into place, so the failure arrives while the user is still looking
 * at the button they pressed.
 *
 * Unpacking stages beside the destination and moves in with a rename, the
 * same shape `plugin-zip.js` uses and for the same reason: a broken archive
 * leaves whatever was installed before exactly as it was.
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { inspect, DISABLED_SUFFIX, SKILL_FILE } from './skills.js'
import { downloadRepo, findSkills, parseSource, readOrigins, resolveCommit, writeOrigins } from './skill-source.js'
import { extractZip } from './zip.js'

/** Directory under DSH_HOME that holds the user's own skills. */
export const SKILLS_DIR = 'skills'

/**
 * Refusals carry a code rather than a sentence: the reasons are the same
 * vocabulary the discovery diagnostics use, and the window already knows how
 * to say those in the user's language.
 *
 * @param {string} code
 * @param {string} [detail]
 */
function refuse(code, detail) {
  return Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code, detail })
}

/**
 * Installs a skill from a directory the user picked, or from a lone markdown
 * file.
 *
 * @param {{source: string, skillsDir: string, log?: (line: string) => void}} options
 * @returns {Promise<{name: string, dir: string}>}
 */
export async function installFromDirectory({ source, skillsDir, log }) {
  const info = await stat(source).catch(() => undefined)
  if (info === undefined) throw refuse('source-missing', source)

  if (info.isFile()) {
    if (!source.endsWith('.md')) throw refuse('source-not-a-skill')
    const { name } = await validate(source)
    // Normalised to a directory even though dsh would read a bare `.md` in
    // the root: one shape means removing and switching off have one
    // implementation, and the user's next skill will bring folders anyway.
    const dir = await claim(skillsDir, name)
    await mkdir(dir, { recursive: true })
    await cp(source, path.join(dir, SKILL_FILE))
    log?.(`skill ${name} installed from ${path.basename(source)}`)
    return { name, dir }
  }

  const root = await findSkillRoot(source)
  const { name } = await validate(path.join(root, SKILL_FILE))
  const dir = await claim(skillsDir, name)
  // Copied rather than moved: the source is the user's own folder, wherever
  // they keep it, and an install that emptied it would be a surprise.
  await cp(root, dir, { recursive: true })
  log?.(`skill ${name} installed from ${root}`)
  return { name, dir }
}

/**
 * Installs a skill from a zip.
 *
 * @param {{zipPath: string, skillsDir: string, log?: (line: string) => void}} options
 * @returns {Promise<{name: string, dir: string}>}
 */
export async function installFromZip({ zipPath, skillsDir, log }) {
  await mkdir(skillsDir, { recursive: true })
  // Beside the destination, so moving in is a rename inside one filesystem
  // rather than a copy that can half-finish.
  const staging = path.join(skillsDir, `.staging-${process.pid}-${Date.now()}`)
  try {
    const { files } = await extractZip(zipPath, staging, { log })
    log?.(`zip: unpacked ${files} file${files === 1 ? '' : 's'} from ${path.basename(zipPath)}`)
    const root = await findSkillRoot(staging)
    const { name } = await validate(path.join(root, SKILL_FILE))
    const dir = await claim(skillsDir, name)
    await rename(root, dir)
    log?.(`skill ${name} unpacked into ${dir}`)
    return { name, dir }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => { /* best effort */ })
  }
}

/**
 * Installs every skill a GitHub repository holds, or the one a link points
 * into.
 *
 * A collection is installed as a collection. Most published skills arrive
 * that way — a repository of a dozen under one folder — and asking the user
 * to paste the same URL a dozen times, once per subdirectory, would be
 * asking them to do the walk this already did.
 *
 * One bad skill does not fail the rest. A repository is somebody else's, its
 * twelfth skill may have a typo in its frontmatter, and refusing all twelve
 * over it would be the shell taking a position on files it does not own —
 * the ones that could not be installed come back named, alongside the ones
 * that could.
 *
 * @param {{input: string, skillsDir: string, originsFile: string,
 *   fetchImpl?: typeof fetch, log?: (line: string) => void}} options
 * @returns {Promise<{installed: {name: string, dir: string}[],
 *   skipped: {where: string, code: string, detail?: string}[]}>}
 */
export async function installFromGitHub({ input, skillsDir, originsFile, fetchImpl, log }) {
  const source = parseSource(input)
  if (source === undefined) throw refuse('source-not-github', String(input))

  const sha = await resolveCommit({ repo: source.repo, ref: source.ref, fetchImpl })
  const { dir: tree, dispose } = await downloadRepo({ repo: source.repo, sha, fetchImpl, log })
  try {
    const found = await findSkills(tree, source.subpath)
    if (found.length === 0) throw refuse('no-skill-file', source.repo)
    log?.(`${source.repo}@${sha.slice(0, 7)}: ${found.length} skill${found.length === 1 ? '' : 's'}`)

    const installed = []
    const skipped = []
    for (const relative of found) {
      const from = path.join(tree, relative)
      let name
      try {
        ({ name } = await validate(path.join(from, SKILL_FILE)))
        const dir = await claim(skillsDir, name)
        await cp(from, dir, { recursive: true })
        await writeOrigins(originsFile, origins => {
          origins[name] = {
            repo: source.repo,
            sha,
            ...source.ref ? { ref: source.ref } : {},
            ...relative ? { subpath: relative } : {},
          }
        })
        installed.push({ name, dir })
        log?.(`skill ${name} installed from ${source.repo}`)
      } catch (error) {
        skipped.push({ where: relative || source.repo, code: error.code ?? 'unreadable-file', detail: error.detail })
        log?.(`skill ${relative || source.repo} skipped: ${error.code ?? error.message}`)
      }
    }
    if (installed.length === 0 && skipped.length > 0) {
      // Nothing landed, so the operation failed rather than partly succeeded;
      // the first reason is the one worth putting on the button.
      throw refuse(skipped[0].code, skipped[0].detail ?? skipped[0].where)
    }
    return { installed, skipped }
  } finally {
    await dispose()
  }
}

/**
 * Re-fetches a skill from the source it was installed from.
 *
 * Whether it was switched off survives the replacement: that is the user's
 * decision about their own machine, not a property of the copy, and an
 * update that quietly switched a skill back on would be one they never asked
 * for and might not notice.
 *
 * @param {{entry: string, skillsDir: string, originsFile: string,
 *   fetchImpl?: typeof fetch, log?: (line: string) => void}} options
 * @returns {Promise<{name: string, sha: string, changed: boolean}>}
 */
export async function updateSkill({ entry, skillsDir, originsFile, fetchImpl, log }) {
  const origins = await readOrigins(originsFile)
  const origin = origins[entry]
  if (origin?.repo === undefined) throw refuse('no-origin', entry)

  const sha = await resolveCommit({ repo: origin.repo, ref: origin.ref, fetchImpl })
  if (sha === origin.sha) return { name: entry, sha, changed: false }

  const { dir: tree, dispose } = await downloadRepo({ repo: origin.repo, sha, fetchImpl, log })
  try {
    // The recorded subpath first; a repository that has since rearranged
    // itself falls back to the search, which is how a skill that moved one
    // directory up stays updatable instead of becoming an error.
    const candidates = await findSkills(tree, origin.subpath).catch(() => [])
    const relative = candidates[0] ?? (await findSkills(tree)).find(found => path.basename(found) === entry)
    if (relative === undefined) throw refuse('no-skill-file', origin.repo)

    const from = path.join(tree, relative)
    await validate(path.join(from, SKILL_FILE))
    const dir = path.join(skillsDir, entry)
    const parked = await exists(path.join(dir, SKILL_FILE + DISABLED_SUFFIX))
    await rm(dir, { recursive: true, force: true })
    await cp(from, dir, { recursive: true })
    if (parked) await rename(path.join(dir, SKILL_FILE), path.join(dir, SKILL_FILE + DISABLED_SUFFIX))
    await writeOrigins(originsFile, saved => { saved[entry] = { ...origin, sha, subpath: relative } })
    log?.(`skill ${entry} updated to ${sha.slice(0, 7)}`)
    return { name: entry, sha, changed: true }
  } finally {
    await dispose()
  }
}

/**
 * Removes an installed skill.
 *
 * The entry name is resolved against the root and checked to still be inside
 * it, because it arrives over IPC from a window: a name is not a path the
 * shell chose, and `..` in one would delete a directory nobody asked about.
 *
 * @param {{skillsDir: string, entry: string}} options
 */
export async function removeSkill({ skillsDir, entry, originsFile }) {
  const dir = path.resolve(skillsDir, entry)
  const root = path.resolve(skillsDir)
  if (dir === root || !dir.startsWith(root + path.sep)) throw refuse('outside-root', entry)
  await rm(dir, { recursive: true, force: true })
  // The note goes with the skill: leaving it behind would offer an update for
  // something that is no longer installed, and claim the name if it came back
  // from somewhere else.
  if (originsFile) await writeOrigins(originsFile, origins => { delete origins[entry] }).catch(() => {})
}

/**
 * The directory holding the skill file.
 *
 * Both shapes people have are accepted: the skill's own directory, and one
 * wrapper around it — which is what a zip of a folder, and every GitHub
 * source download, unpacks to. Anything deeper is ambiguous, and an archive
 * of several skills has no single right answer, so it is refused instead of
 * guessed at.
 *
 * @param {string} dir
 * @returns {Promise<string>}
 */
async function findSkillRoot(dir) {
  if (await holdsSkill(dir)) return dir
  const children = (await readdir(dir, { withFileTypes: true }))
    .filter(child => child.isDirectory() && !child.name.startsWith('.'))
  if (children.length === 1) {
    const nested = path.join(dir, children[0].name)
    if (await holdsSkill(nested)) return nested
  }
  throw refuse('no-skill-file')
}

async function holdsSkill(dir) {
  return stat(path.join(dir, SKILL_FILE)).then(info => info.isFile()).catch(() => false)
}

/**
 * Reads a skill file and refuses it for any reason dsh would drop it for.
 *
 * Refusing here is the whole argument for the feature: dsh's own answer to a
 * malformed skill is to say nothing and carry on without it, so an install
 * that succeeded and produced nothing would be indistinguishable from one
 * that worked.
 *
 * @param {string} file
 * @returns {Promise<{name: string}>}
 */
async function validate(file) {
  const raw = await readFile(file, 'utf8').catch(() => undefined)
  if (raw === undefined) throw refuse('unreadable-file', file)
  // No entry name passed: the source folder is about to be renamed to the
  // frontmatter name anyway, so a mismatch between them is not news.
  const { problems, name } = inspect(raw, undefined)
  const fatal = problems.find(problem => problem.fatal)
  if (fatal) throw refuse(fatal.code, fatal.detail)
  return { name }
}

/**
 * The directory a skill of this name will occupy, refused if taken.
 *
 * Named from the frontmatter rather than the source folder, because that is
 * the name dsh will answer to — installing `~/Downloads/my-skill-main` and
 * then finding it under something else is the confusion this avoids.
 *
 * @param {string} skillsDir
 * @param {string} name validated by {@link validate} against dsh's grammar,
 *   which has no separators in it, so it cannot climb out of the root
 * @returns {Promise<string>}
 */
async function claim(skillsDir, name) {
  const dir = path.join(skillsDir, name)
  // Refused rather than overwritten: unlike a plugin, whose profile links to
  // one path and must be replaced in place, a skill of the same name is
  // simply a different skill, and silently replacing the user's own edits to
  // one is not a thing to do without asking.
  if (await stat(dir).then(() => true).catch(() => false)) throw refuse('already-installed', name)
  await mkdir(skillsDir, { recursive: true })
  return dir
}

async function exists(target) {
  return stat(target).then(() => true).catch(() => false)
}
