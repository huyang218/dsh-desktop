/**
 * Plugin config probe, run by the shell as a plain-node subprocess.
 *
 * Given an installed plugin package, this discovers what the shell needs to
 * render an install-time config form:
 *  - the loader row id its bundle patch inserts (config overrides target row
 *    ids, not package names);
 *  - the form fields described by the plugin's exported Schemastery `Config`
 *    (dsh convention: plugins export their config schema as `Config`).
 *
 * Runs out of process on purpose: importing the entry executes plugin code
 * (the same code the dsh server runs at startup), and a subprocess keeps that
 * out of the Electron main process and free of module-cache staleness after
 * reinstalls.
 *
 * argv: <profileDir> <runtimeDir> <packageName> [locale]
 * stdout: one JSON object { rowId, fields, error? }; always exits 0 so the
 * shell handles failures from the payload, not the exit code.
 */
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
  const [profileDir, runtimeDir, packageName, locale] = process.argv.slice(2)
  const pkgDir = path.join(profileDir, 'node_modules', packageName)
  const pkg = JSON.parse(await readFile(path.join(pkgDir, 'package.json'), 'utf8'))

  return {
    rowId: await findBundleRowId(runtimeDir, pkgDir, pkg),
    fields: await extractConfigFields(pkgDir, pkg, locale),
  }
}

/**
 * Row id from the plugin's bundle patch: the insert row whose `name` is the
 * package itself. Rows referencing subpaths (pkg/startup) are not config
 * targets for this form. The runtime's own yaml package does the parsing —
 * the shell ships no dependencies.
 */
async function findBundleRowId(runtimeDir, pkgDir, pkg) {
  const patchRel = pkg.dsh?.bundle?.patch
  if (!patchRel) return null
  const yaml = createRequire(path.join(runtimeDir, 'node_modules', 'probe.js'))('yaml')
  const patch = yaml.parse(await readFile(path.join(pkgDir, patchRel), 'utf8'))
  if (!Array.isArray(patch)) return null
  for (const entry of patch) {
    for (const row of entry?.insert ?? []) {
      if (row?.name === pkg.name && row.id) return String(row.id)
    }
  }
  return null
}

/** Form fields from the exported Schemastery `Config` object schema. */
async function extractConfigFields(pkgDir, pkg, locale) {
  const entry = path.join(pkgDir, pkg.main ?? 'index.js')
  const mod = await import(pathToFileURL(entry).href)
  const schema = mod.Config
  if (typeof schema !== 'function' || schema.type !== 'object' || !schema.dict) return []

  const fields = []
  for (const [key, sub] of Object.entries(schema.dict)) {
    const meta = sub.meta ?? {}
    const field = {
      key,
      type: sub.type,
      default: meta.default,
      required: Boolean(meta.required),
      role: meta.role ?? '',
      description: localizedDescription(meta.description, locale),
    }
    // A union of consts renders as a select.
    if (sub.type === 'union' && Array.isArray(sub.list) && sub.list.every(x => x?.type === 'const')) {
      field.options = sub.list.map(x => x.value)
    }
    fields.push(field)
  }
  return fields
}

/**
 * Schemastery descriptions are either a string or a map keyed by locale.
 * Prefer the shell's active language, so a form's help text matches the menu
 * around it rather than always speaking Chinese.
 */
function localizedDescription(description, locale) {
  if (typeof description === 'string') return description
  if (!description || typeof description !== 'object') return ''
  const preferred = String(locale ?? '').toLowerCase().startsWith('zh')
    ? ['zh-CN', 'zh', 'en']
    : ['en', 'zh-CN', 'zh']
  for (const key of preferred) {
    if (typeof description[key] === 'string') return description[key]
  }
  return Object.values(description).find(value => typeof value === 'string') ?? ''
}

main()
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => console.log(JSON.stringify({ rowId: null, fields: [], error: String(error?.message ?? error) })))
