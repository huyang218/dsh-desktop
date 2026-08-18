/**
 * Recognising macOS privacy denials.
 *
 * Anything under ~/Documents, ~/Desktop, ~/Downloads, iCloud Drive or an
 * external volume is gated by TCC. A denial arrives as `EPERM` from open(),
 * and — once the system has a decision on file for this bundle id — with no
 * dialog at all: it is simply refused. That decision is bound to the app's
 * code signature, and this app is ad-hoc signed (there is no Apple Developer
 * identity), so every rebuild gets a different signature and a permission
 * the user granted to the previous build silently stops applying to the new
 * one.
 *
 * The failure that reaches the plugin manager is therefore a bare
 * "EPERM: operation not permitted, open '…'" that says nothing about privacy
 * settings, points at a file the user can read perfectly well in Finder, and
 * looks like a broken plugin. It is worth one sentence of explanation.
 *
 * Deliberately imports nothing from Electron so it stays usable from the
 * plain-node paths of this codebase.
 */
import { t } from './i18n.js'

/**
 * Identity of the packaged app, as macOS knows it. Mirrors
 * `build.productName` and `build.appId` in package.json — the strings the
 * Privacy pane and `tccutil` expect are these, not the npm package name.
 */
const APP_NAME = 'DeepSeek Harness'
const BUNDLE_ID = 'io.github.huyang218.dsh-desktop'

/** Filesystem calls whose EPERM is a privacy denial rather than something else. */
const FS_EPERM = /\bEPERM\b[^\n]*\b(open|read|scandir|stat|lstat|readlink|access|copyfile|mkdir|rename|unlink)\b/i

/**
 * A translated explanation for a failure that is really a privacy denial.
 *
 * @param {unknown} message the error text or command output to classify
 * @returns {string} the hint, or '' when this is not that kind of failure
 */
export function macAccessHint(message) {
  if (process.platform !== 'darwin') return ''
  return FS_EPERM.test(String(message ?? '')) ? t('error.macFileAccess', { app: APP_NAME, id: BUNDLE_ID }) : ''
}

/** Appends {@link macAccessHint} to a message when one applies. */
export function withAccessHint(message) {
  const hint = macAccessHint(message)
  return hint ? `${message}\n${hint}` : String(message)
}
