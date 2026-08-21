/**
 * Repositories worth suggesting, written down because the market cannot.
 *
 * The catalog the plugin market reads classifies 22 of its 7,210 crawled
 * repositories as skills, while another 135 sit unclassified with "skill" in
 * the name — it is a crawl, and its `entity_type` is a guess it makes about
 * what it found. Browsing it is fine; relying on it to answer "where do I get
 * skills" is not, and a user who has just opened this window has no way to
 * know that.
 *
 * So the answer is kept here instead. Each of these was checked the only way
 * that means anything: its SKILL.md files were read and run through the same
 * validation the manager applies, and every one of them passed unchanged —
 * 58 skills across the three general collections, with no dsh-specific
 * adaptation. That is the finding worth encoding. The skills published for
 * other agents in this format are not merely convertible, they already work,
 * which makes the useful universe of skills far larger than the catalog's
 * twenty-two.
 *
 * Only the repository is recorded — never a count, never a description of
 * what is inside. Those change without this file changing, and a list that
 * quietly goes stale is worse than one that says less. What is on screen
 * comes from the repository itself, at the moment the user looks.
 */

/**
 * @typedef {object} RecommendedSource
 * @property {string} repo `owner/name`
 * @property {string} label i18n key for the one-line description
 */

/** @type {RecommendedSource[]} */
export const RECOMMENDED_SOURCES = [
  { repo: 'anthropics/skills', label: 'skills.recommended.anthropics' },
  { repo: 'addyosmani/agent-skills', label: 'skills.recommended.addyosmani' },
  { repo: 'obra/superpowers', label: 'skills.recommended.superpowers' },
  { repo: 'csyangwen/dsh-memory-evolve', label: 'skills.recommended.dshMemory' },
  { repo: 'AtlasCloudAI/atlas-cloud-skills', label: 'skills.recommended.atlasCloud' },
]
