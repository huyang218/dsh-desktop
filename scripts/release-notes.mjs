/**
 * The body of a GitHub release, assembled from CHANGELOG.md.
 *
 * `gh release create --generate-notes` produces a link to a commit range and
 * nothing else, which is accurate and unreadable: a person deciding whether
 * to download a 200 MB installer learns nothing from it. The changelog entry
 * is already written by the time a tag exists, so the release can simply
 * carry it, followed by which file to download — the assets list names five
 * files and only two of them are meant for a human.
 *
 * Exits non-zero when the version has no section, so the workflow can fall
 * back to the generated notes rather than publishing an empty release.
 *
 * Usage: node scripts/release-notes.mjs v0.1.13 > notes.md
 */
import { readFileSync } from 'node:fs'

const tag = process.argv[2]
if (!tag) {
  console.error('usage: release-notes.mjs <tag>')
  process.exit(2)
}
const version = tag.replace(/^v/, '')

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
// A heading is `## <version> — <date>`; the section runs to the next one.
const lines = changelog.split('\n')
const start = lines.findIndex(line => new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`).test(line))
if (start === -1) {
  console.error(`no CHANGELOG.md section for ${version}`)
  process.exit(1)
}
let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith('## ')) { end = i; break }
}
const body = lines.slice(start + 1, end).join('\n').trim()
if (!body) {
  console.error(`the CHANGELOG.md section for ${version} is empty`)
  process.exit(1)
}

const repo = 'huyang218/dsh-desktop'
process.stdout.write(`${body}

## Download

| Platform | File |
|---|---|
| macOS (Apple Silicon) | \`DeepSeek Harness-${version}-arm64.dmg\` |
| macOS (Intel) | \`DeepSeek Harness-${version}-x64.dmg\` |
| Windows 10 (1803+) / 11 | \`DeepSeek Harness Setup ${version}.exe\` |

\`shell-${version}.zip\` and \`shell-update.json\` are the hot-update payload an
installed app fetches for itself. They are not an installer — nothing to
download by hand.

macOS builds are ad-hoc signed and not notarized: the first launch needs
approval under System Settings → Privacy & Security.

**Full changelog**: https://github.com/${repo}/blob/${tag}/CHANGELOG.md
`)
