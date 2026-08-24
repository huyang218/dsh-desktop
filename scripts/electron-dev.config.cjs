/**
 * A small, branded macOS shell for `npm start`.
 *
 * The stock Electron.app bundle calls itself "Electron" in the macOS menu
 * bar, and app.setName() deliberately cannot change an OS-level identity.
 * This cache contains only the app shell and source files: no runtime seed or
 * installer payload. start-dev.mjs refreshes the source and ad-hoc signature
 * before each launch.
 */
const path = require('node:path')
const { readFileSync } = require('node:fs')

const root = path.join(__dirname, '..')
const brand = JSON.parse(readFileSync(path.join(root, 'assets', 'brand.json'), 'utf8'))

module.exports = {
  // The product name is the installed one on purpose — reading the real name
  // in the menu bar is the whole point of this bundle. The bundle identifier
  // is not: two applications claiming one identifier leaves LaunchServices to
  // pick between them for `open -b`, Open With and the open-file handler, and
  // the copy under node_modules is the one that disappears when it is
  // cleaned. They still share a data directory, so a source run debugs real
  // sessions; main.js is what keeps the two from running at once.
  appId: `${brand.appId}.dev`,
  productName: brand.name,
  asar: false,
  // npm has already installed this exact Electron build. Reusing the unpacked
  // distribution keeps the first branded start available offline instead of
  // downloading the same 100+ MB archive a second time.
  electronDist: path.join(root, 'node_modules', 'electron', 'dist'),
  directories: {
    output: path.join(root, 'node_modules', '.cache', 'dsh-desktop-dev'),
  },
  files: [
    'src/**',
    'assets/**',
    'package.json',
  ],
  mac: {
    target: ['dir'],
    identity: null,
    icon: brand.icons?.mac ?? 'assets/icon.icns',
  },
}
