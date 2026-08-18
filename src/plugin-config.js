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
 *
 * The same store and the same block also carry whether a plugin is switched
 * off. `disabled: true` on a loader entry is the runtime's own mechanism —
 * the profile patch template names it in as many words — and it belongs here
 * rather than in the profile's bundle list, because `dsh plugin` reconciles
 * that list against what is installed on every operation and would put back
 * anything taken out of it.
 */
import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t } from './i18n.js'
import { withAccessHint } from './permission.js'

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
export async function probePluginConfig({ nodeBin, probePath, profileDir, runtimeDir, name, env, log, locale, rowOnly = false }) {
  const source = await readFile(probePath, 'utf8')
  return await new Promise(resolve => {
    const argv = [profileDir, runtimeDir, name, locale, ...(rowOnly ? ['--row-only'] : [])]
    const child = spawn(nodeBin, ['--input-type=module', '-', ...argv], {
      cwd: profileDir, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    child.stdin.write(source)
    child.stdin.end()
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000) })
    const fail = message => resolve({ rowId: null, fields: [], error: withAccessHint(message) })
    const timer = setTimeout(() => { child.kill('SIGKILL'); fail(t('error.configProbeTimeout')) }, 15_000)
    child.on('error', error => { clearTimeout(timer); fail(String(error.message)) })
    child.on('exit', () => {
      clearTimeout(timer)
      // The probe prints exactly one JSON line; plugin top-level code may
      // print noise before it, so parse the last non-empty line.
      const lines = stdout.split('\n').filter(line => line.trim())
      try {
        const result = JSON.parse(lines[lines.length - 1])
        // The probe reports its own failures in the payload; a plugin living
        // in a protected folder arrives here as a bare EPERM.
        if (result?.error) result.error = withAccessHint(result.error)
        resolve(result)
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

/** Package names currently switched off. @returns {Promise<string[]>} */
export async function getDisabledPlugins(profileDir) {
  const store = await readStore(profileDir)
  return Object.entries(store).filter(([, entry]) => entry?.disabled).map(([name]) => name)
}

/**
 * Switches a plugin off or back on without uninstalling it.
 *
 * @param {string} profileDir @param {string} name package name
 * @param {string} rowId the loader row the plugin's bundle patch inserts
 * @param {boolean} disabled
 */
export async function setPluginDisabled(profileDir, name, rowId, disabled) {
  const store = await readStore(profileDir)
  const entry = store[name] ?? {}
  if (disabled) {
    store[name] = { ...entry, rowId, disabled: true }
  } else if (entry.values && Object.keys(entry.values).length > 0) {
    // Re-enabling keeps configuration the user filled in earlier.
    store[name] = { rowId: entry.rowId ?? rowId, values: entry.values }
  } else {
    delete store[name]
  }
  await writeStore(profileDir, store)
}

/**
 * Saves one plugin's config values and regenerates the managed patch block.
 * An empty `values` object removes the plugin's override entry.
 */
export async function setPluginConfig(profileDir, name, rowId, values) {
  const store = await readStore(profileDir)
  const disabled = store[name]?.disabled === true
  if (values && Object.keys(values).length > 0) {
    store[name] = { rowId, values, ...(disabled ? { disabled: true } : {}) }
  } else if (disabled) {
    // Clearing every value leaves the plugin switched off, not forgotten.
    store[name] = { rowId, disabled: true }
  } else {
    delete store[name]
  }
  await writeStore(profileDir, store)
}

/** Writes the store and regenerates the managed patch block from it. */
async function writeStore(profileDir, store) {
  await writeFile(path.join(profileDir, STORE_FILE), JSON.stringify(store, null, 2) + '\n')
  await spliceManagedBlock(path.join(profileDir, 'cordis.patch.yml'), renderBlock(store))
}

/**
 * The managed block: one id-targeted JSON-flow override entry per plugin.
 *
 * A plugin appears once, carrying whichever of the two overrides apply —
 * both go into the same entry, because the runtime merges a patch key by key
 * onto the row it names.
 */
function renderBlock(store) {
  const lines = [MARK_BEGIN]
  for (const [name, entry] of Object.entries(store)) {
    if (!entry?.rowId) continue
    const hasValues = entry.values && Object.keys(entry.values).length > 0
    if (!hasValues && !entry.disabled) continue
    lines.push(`# ${name}`)
    lines.push(`- ${JSON.stringify({
      id: entry.rowId,
      ...(hasValues ? { config: entry.values } : {}),
      ...(entry.disabled ? { disabled: true } : {}),
    })}`)
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
