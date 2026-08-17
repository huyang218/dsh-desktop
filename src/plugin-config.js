/**
 * Install-time plugin configuration.
 *
 * A dsh plugin that exports a Schemastery `Config` schema is configurable;
 * the shell renders a form from that schema (via the subprocess probe) and
 * persists submitted values in two places:
 *
 *  - `<profile>/plugin-config.json` — the shell-owned source of truth;
 *  - `<profile>/cordis.patch.yml` — a marker-delimited managed block of
 *    id-targeted config overrides, regenerated from the store on every save.
 *
 * The patch file is spliced textually, never parsed: user-authored entries
 * (including `!!js` expressions the yaml lib cannot round-trip) stay
 * byte-identical outside the managed block. Entries inside the block are
 * JSON flow mappings, which are valid YAML.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from './i18n.js'

// These markers are a DATA FORMAT, not branding: they are written into the
// user's cordis.patch.yml and located again by exact string match. Renaming
// them would leave every existing managed block unfindable, so the manager
// would append a second one while the stale block kept applying. They keep
// the project's former name for that reason.
const MARK_BEGIN = '# >>> dsh-shell:plugin-config (由插件管理器维护,请勿在标记内手动编辑)'
const MARK_END = '# <<< dsh-shell:plugin-config'
const STORE_FILE = 'plugin-config.json'

/**
 * Runs the config probe against an installed plugin.
 *
 * The probe source is read here (Electron's patched fs can read inside
 * app.asar) and fed to a plain-node subprocess over stdin — plain node
 * cannot open paths inside an asar archive, so the script must never be
 * spawned by its packaged path.
 * @returns {Promise<{rowId: string|null, fields: Array, error?: string}>}
 */
export async function probePluginConfig({ nodeBin, probePath, profileDir, runtimeDir, name, env, log }) {
  const source = await readFile(probePath, 'utf8')
  return await new Promise(resolve => {
    const child = spawn(nodeBin, ['--input-type=module', '-', profileDir, runtimeDir, name], {
      cwd: profileDir, env, stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.write(source)
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000) })
    const fail = message => resolve({ rowId: null, fields: [], error: message })
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(t('error.configProbeTimeout')) }, 15_000)
    child.on('error', error => { clearTimeout(timer); fail(String(error.message)) })
    child.on('exit', () => {
      clearTimeout(timer)
      // The probe prints exactly one JSON line; plugin top-level code may
      // print noise before it, so parse the last non-empty line.
      const lines = stdout.split('\n').filter(line => line.trim())
      try {
        resolve(JSON.parse(lines[lines.length - 1]))
      } catch {
        log?.(`config probe for ${name} produced no JSON; stderr: ${stderr}`)
        fail(t('error.configProbeOutput', { name }))
      }
    })
  })
}

/** @returns {Promise<Object>} The whole store: { [packageName]: { rowId, values } } */
async function readStore(profileDir) {
  try {
    return JSON.parse(await readFile(path.join(profileDir, STORE_FILE), 'utf8'))
  } catch {
    return {}
  }
}

/** Stored values for one plugin, for form prefill. */
export async function getPluginConfigValues(profileDir, name) {
  const store = await readStore(profileDir)
  return store[name]?.values ?? {}
}

/**
 * Saves one plugin's config values and regenerates the managed patch block.
 * An empty `values` object removes the plugin's override entry.
 */
export async function setPluginConfig(profileDir, name, rowId, values) {
  const store = await readStore(profileDir)
  if (values && Object.keys(values).length > 0) {
    store[name] = { rowId, values }
  } else {
    delete store[name]
  }
  await writeFile(path.join(profileDir, STORE_FILE), JSON.stringify(store, null, 2) + '\n')
  await spliceManagedBlock(path.join(profileDir, 'cordis.patch.yml'), renderBlock(store))
}

/** The managed block: one id-targeted JSON-flow override entry per plugin. */
function renderBlock(store) {
  const lines = [MARK_BEGIN]
  for (const [name, entry] of Object.entries(store)) {
    if (!entry?.rowId || !entry.values || Object.keys(entry.values).length === 0) continue
    lines.push(`# ${name}`)
    lines.push(`- ${JSON.stringify({ id: entry.rowId, config: entry.values })}`)
  }
  lines.push(MARK_END)
  return lines.join('\n')
}

/**
 * Replaces the marker-delimited block in the patch file, touching nothing
 * else. A pristine profile patch is the literal `[]` (an empty flow
 * sequence), which cannot coexist with block-sequence entries — that token
 * is replaced by the block instead of appended to.
 */
async function spliceManagedBlock(patchPath, block) {
  let text = ''
  try {
    text = await readFile(patchPath, 'utf8')
  } catch { /* first write into a profile without a patch file */ }
  const begin = text.indexOf(MARK_BEGIN)
  const end = text.indexOf(MARK_END)
  if (begin !== -1 && end !== -1 && end >= begin) {
    text = text.slice(0, begin) + block + text.slice(end + MARK_END.length)
  } else if (/^\s*\[\]\s*$/m.test(text)) {
    text = text.replace(/^\s*\[\]\s*$/m, block)
  } else {
    text = (text.trimEnd() ? text.trimEnd() + '\n\n' : '') + block
  }
  await writeFile(patchPath, text.trimEnd() + '\n')
}
