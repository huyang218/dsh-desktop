/**
 * Giving the model this app's own surfaces as tools.
 *
 * dsh already knows how to speak MCP — `@deepseek-ai/dsh-mcp-client` mounts a
 * server's tools onto the agent under `mcp__<name>__<tool>`. What it needs is
 * a row in the composed plugin tree naming the command to spawn, and that row
 * is this file: one `insert` entry in a marker-delimited block in the
 * home-level `cordis.patch.yml`.
 *
 * Home level rather than per-profile, because these belong to the
 * application and not to one profile: a user who makes a second profile
 * should not lose the tools, and the user's own per-profile patch — which
 * holds their plugin configuration — stays untouched.
 *
 * The token never lands on disk. `!!js` expressions in a patch are evaluated
 * in the dsh process at mount time, so the row asks *that* process for its
 * own environment rather than carrying a secret the shell would have to
 * rewrite every launch and leave behind on every crash.
 *
 * Electron-free.
 */
import { readFile } from 'node:fs/promises'
import { spliceManagedBlock } from './plugin-config.js'

/**
 * A DATA FORMAT, not branding: written into the user's file and found again
 * by exact string match. Renaming these leaves every existing block
 * unfindable, so a second one would be appended while the stale one kept
 * applying — which is also why the name is interpolated rather than the
 * whole string rewritten per feature. `browser` has to keep producing the
 * exact bytes it produced before there was a second server.
 *
 * @param {string} name
 */
const markersFor = name => ({
  begin: `# >>> dsh-shell:${name}-tools (由桌面应用维护,请勿在标记内手动编辑)`,
  end: `# <<< dsh-shell:${name}-tools`,
})

/** What each server is called, and what it is for, in the user's own file. */
const SERVERS = {
  browser: "The desktop app's browser panel, as agent tools (mcp__browser__*).",
  miniapp: "The desktop app's mini program simulator, as agent tools (mcp__miniapp__*).",
  phone: "The desktop app's phone simulator, as agent tools (mcp__phone__*).",
}

/** The MCP namespace the model sees in a server's tool names. */
export const toolPrefix = name => `mcp__${name}__`

/**
 * Writes, or removes, the row that gives the agent one server's tools.
 *
 * Idempotent by comparison rather than by write: the patch file is watched
 * live, and rewriting identical bytes would reload the whole plugin tree on
 * every launch.
 *
 * @param {object} options
 * @param {string} options.patchPath the home-level cordis.patch.yml
 * @param {string} options.name which server: a key of {@link SERVERS}
 * @param {string} [options.command] absolute path to the MCP stub; omit to remove
 * @returns {Promise<'added'|'updated'|'removed'|'unchanged'>}
 */
export async function registerMcpTools({ patchPath, name, command }) {
  const markers = markersFor(name)
  const before = await readFile(patchPath, 'utf8').catch(() => '')
  const had = before.includes(markers.begin)
  const block = command ? renderBlock(name, command) : ''
  if (had && before.includes(block) && command) return 'unchanged'
  if (!had && !command) return 'unchanged'
  await spliceManagedBlock(patchPath, block, markers)
  if (!command) return 'removed'
  return had ? 'updated' : 'added'
}

/**
 * The block, as YAML.
 *
 * Written as text rather than dumped from an object because `!!js` is not a
 * value any YAML serialiser will produce — it is a tag the loader interprets,
 * and it is the whole reason the token stays out of this file.
 */
function renderBlock(name, command) {
  const markers = markersFor(name)
  return [
    markers.begin,
    `# ${SERVERS[name]}`,
    '# The command is a stub the app rewrites on every launch; the socket and',
    '# token are read from the dsh process\'s own environment at mount time, so',
    '# no secret is stored here.',
    '- insert:',
    `    - id: dsh-desktop-${name}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    `        serverName: ${name}`,
    '        transport: stdio',
    `        command: ${JSON.stringify(command)}`,
    '        env:',
    '          DSH_DESKTOP_OPEN_SOCKET: !!js process.env.DSH_DESKTOP_OPEN_SOCKET',
    '          DSH_DESKTOP_OPEN_TOKEN: !!js process.env.DSH_DESKTOP_OPEN_TOKEN',
    markers.end,
  ].join('\n')
}

/**
 * Switches the skill loader on, for every profile under this home.
 *
 * The web profile ships with `skill-filesystem` — the provider that reads
 * skill roots, `DSH_BUNDLED_SKILL_DIR` among them — and `tool-skill`, the
 * model-facing loader, both disabled. Nothing else enables them, which was
 * discovered the hard way: the app deployed its bundled skills, set the
 * environment, and every session saw zero skills, the shipped browser skill
 * included. The deployment, the variable, and the files were all correct;
 * the reader was off.
 *
 * Home level for the reason the tool rows are: skills the application ships
 * belong to the application, not to one profile. This also turns on the
 * loading of skills the user installs through the manager window, which
 * lands them in `<dshHome>/skills` — a root the same provider owns.
 *
 * @param {object} options
 * @param {string} options.patchPath the home-level cordis.patch.yml
 * @param {boolean} [options.enabled] false removes the block
 * @returns {Promise<'added'|'updated'|'removed'|'unchanged'>}
 */
export async function registerSkillLoader({ patchPath, enabled = true }) {
  const markers = markersFor('skill-loader')
  const before = await readFile(patchPath, 'utf8').catch(() => '')
  const had = before.includes(markers.begin)
  const block = enabled
    ? [
      markers.begin,
      '# The skill loader, switched on: the web profile ships it disabled, and',
      "# with it off the app's bundled skills and the user's installed ones are",
      '# deployed but never read.',
      '- id: skill-filesystem',
      '  disabled: false',
      '- id: tool-skill',
      '  disabled: false',
      markers.end,
    ].join('\n')
    : ''
  if (had && enabled && before.includes(block)) return 'unchanged'
  if (!had && !enabled) return 'unchanged'
  await spliceManagedBlock(patchPath, block, markers)
  if (!enabled) return 'removed'
  return had ? 'updated' : 'added'
}
