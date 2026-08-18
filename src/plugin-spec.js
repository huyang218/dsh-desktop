/**
 * What a user pastes, turned into what pnpm installs.
 *
 * The install field takes package managers' own syntax, which nobody has in
 * hand when they find a plugin: what they have is the page they are looking
 * at. A repository URL is already close enough to `github:owner/repo` to be
 * worth translating, and a link into a subdirectory — how a collection
 * repository points at one of its plugins — is the case that actually needs
 * it, because the spec pnpm wants for that (`#path:/packages/name`) is
 * nothing like the URL and is not guessable.
 *
 * Translation only. Anything this does not recognise is passed through
 * untouched, so an npm name, a local path, a `github:` spec someone typed
 * deliberately, and every syntax pnpm gains later keep working.
 *
 * Deliberately free of Electron imports and of I/O.
 */

/** GitHub's own limits: owner and repo names, and the path in between. */
const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SUBPATH_SEGMENT = /^[A-Za-z0-9_.-]+$/

/**
 * A repository web URL, optionally pointing into a subdirectory:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/main/packages/ainfo
 */
const GITHUB_URL = /^https?:\/\/(?:www\.)?github\.com\/([^/]+\/[^/?#]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+?))?)?\/?$/

/**
 * @typedef {object} Spec
 * @property {string} value what to hand to `dsh plugin add`
 * @property {string} [from] the input it was translated from, when it was
 */

/**
 * @param {string} input whatever the user typed or pasted
 * @returns {Spec}
 */
export function normalizeSpec(input) {
  const raw = String(input ?? '').trim()
  const match = GITHUB_URL.exec(raw)
  if (!match) return { value: raw }

  const [, repo, , subpath] = match
  if (!OWNER_REPO.test(repo)) return { value: raw }
  if (subpath === undefined) return { value: `github:${repo}`, from: raw }

  // Every segment checked rather than the whole string: this ends up inside
  // pnpm's `#path:` selector, and `..` there would climb out of the package
  // the user chose and into the rest of the repository.
  const segments = subpath.split('/')
  if (!segments.every(segment => SUBPATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..')) {
    return { value: raw }
  }
  // The branch in a /tree/ URL is deliberately dropped: pnpm's git specs take
  // either a ref or a path after the fragment, and a collection's links are
  // to its default branch anyway. Someone who needs another ref can write the
  // github: spec themselves — which is exactly what passing input through
  // untouched leaves room for.
  return { value: `github:${repo}#path:/${segments.join('/')}`, from: raw }
}
