/**
 * electron-builder afterPack hook: ad-hoc signs the packed app.
 *
 * With signing skipped, the renamed Electron binary keeps a stale signature
 * whose resource seal no longer matches, so Gatekeeper reports the app as
 * "damaged" on quarantined copies (DMG installs). A valid ad-hoc signature
 * turns that into the standard unidentified-developer flow, which System
 * Settings can approve. Real distribution still wants Developer ID +
 * notarization.
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • ad-hoc signed ${appPath}`)
}
