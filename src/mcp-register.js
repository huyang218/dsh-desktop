/**
 * Giving the model the browser as tools.
 *
 * dsh already knows how to speak MCP — `@deepseek-ai/dsh-mcp-client` mounts a
 * server's tools onto the agent under `mcp__<name>__<tool>`. What it needs is
 * a row in the composed plugin tree naming the command to spawn, and that row
 * is this file: one `insert` entry in a marker-delimited block in the
 * home-level `cordis.patch.yml`.
 *
 * Home level rather than per-profile, because the browser belongs to the
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

// A DATA FORMAT, not branding: written into the user's file and found again
// by exact string match. Renaming these leaves every existing block
// unfindable, so a second one would be appended while the stale one kept
// applying.
const MARKERS = {
  begin: '# >>> dsh-shell:browser-tools (由桌面应用维护,请勿在标记内手动编辑)',
  end: '# <<< dsh-shell:browser-tools',
}

/** The loader row id, and the MCP namespace the model sees in its tool names. */
const ROW_ID = 'dsh-desktop-browser'
export const TOOL_PREFIX = 'mcp__browser__'

/**
 * Writes, or removes, the row that gives the agent the browser tools.
 *
 * Idempotent by comparison rather than by write: the patch file is watched
 * live, and rewriting identical bytes would reload the whole plugin tree on
 * every launch.
 *
 * @param {object} options
 * @param {string} options.patchPath the home-level cordis.patch.yml
 * @param {string} [options.command] absolute path to the MCP stub; omit to remove
 * @returns {Promise<'added'|'updated'|'removed'|'unchanged'>}
 */
export async function registerBrowserTools({ patchPath, command }) {
  const before = await readFile(patchPath, 'utf8').catch(() => '')
  const had = before.includes(MARKERS.begin)
  const block = command ? renderBlock(command) : ''
  if (had && before.includes(block) && command) return 'unchanged'
  if (!had && !command) return 'unchanged'
  await spliceManagedBlock(patchPath, block, MARKERS)
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
function renderBlock(command) {
  return [
    MARKERS.begin,
    '# The desktop app\'s browser panel, as agent tools (mcp__browser__*).',
    '# The command is a stub the app rewrites on every launch; the socket and',
    '# token are read from the dsh process\'s own environment at mount time, so',
    '# no secret is stored here.',
    '- insert:',
    `    - id: ${ROW_ID}`,
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: browser',
    '        transport: stdio',
    `        command: ${JSON.stringify(command)}`,
    '        env:',
    '          DSH_DESKTOP_OPEN_SOCKET: !!js process.env.DSH_DESKTOP_OPEN_SOCKET',
    '          DSH_DESKTOP_OPEN_TOKEN: !!js process.env.DSH_DESKTOP_OPEN_TOKEN',
    MARKERS.end,
  ].join('\n')
}
