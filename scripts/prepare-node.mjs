/**
 * Packaging step: snapshots the local Node.js toolchain (node binary + npm)
 * into `node-runtime.tgz` + `node-runtime.version`, bundled into the app as
 * `Resources/node-runtime.*`. A packaged app then runs dsh on its own Node,
 * so target machines need no Node installation at all.
 *
 * A tar archive for the same reason as the dsh seed: electron-builder's
 * extraResources copier silently skips `node_modules` directories (npm's
 * tree lives under lib/node_modules).
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findToolchain } from '../src/toolchain.js'

const projectRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const toolchain = findToolchain()
const version = execFileSync(toolchain.nodeBin, ['--version'], { encoding: 'utf8' }).trim()

const isWindows = process.platform === 'win32'
// The staged tree mirrors the platform's own Node layout, because
// ensureBundledToolchain() resolves the extracted copy with the very same
// relative lookups it uses on a real install: node.exe at the root with npm
// beside it on Windows, bin/ + lib/ on POSIX.
const stagedNodeDir = isWindows ? '.' : 'bin'
const stagedNpmParent = isWindows ? 'node_modules' : path.join('lib', 'node_modules')
const nodeInstallRoot = isWindows ? toolchain.nodeDir : path.join(toolchain.nodeDir, '..')

// npm package root: npmCli is <npm>/bin/npm-cli.js (or the bin/npm shim whose
// real tree sits under the install root).
const npmDirCandidates = [
  path.join(nodeInstallRoot, isWindows ? 'node_modules' : path.join('lib', 'node_modules'), 'npm'),
  path.dirname(path.dirname(toolchain.npmCli)),
]
const npmDir = npmDirCandidates.find(dir => existsSync(path.join(dir, 'package.json')))
if (!npmDir) {
  console.error(`npm package tree not found near ${toolchain.npmCli}`)
  process.exit(1)
}

const stage = mkdtempSync(path.join(tmpdir(), 'dsh-node-stage-'))
mkdirSync(path.join(stage, stagedNodeDir), { recursive: true })
mkdirSync(path.join(stage, stagedNpmParent), { recursive: true })
cpSync(toolchain.nodeBin, path.join(stage, stagedNodeDir, path.basename(toolchain.nodeBin)), { dereference: true })
cpSync(npmDir, path.join(stage, stagedNpmParent, 'npm'), { recursive: true, dereference: true })
writeFileSync(path.join(stage, 'VERSION'), `${version}\n`)

// A packaged app redistributes this Node binary (MIT) and npm (Artistic-2.0),
// and both licenses require their notice to travel with the copy. npm's tree
// carries its own; Node's has to be picked up explicitly.
//
// Not every installation has one to copy: the Windows MSI installs no LICENSE
// beside node.exe, while the tarball and zip distributions keep it at the
// root. A missing notice is a real gap for anyone redistributing the build —
// but it is the packager's call to make, not a reason to refuse to build, so
// this warns as loudly as it can and continues.
const nodeLicense = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
  .map(name => path.join(nodeInstallRoot, name))
  .find(candidate => existsSync(candidate))
if (nodeLicense) {
  cpSync(nodeLicense, path.join(stage, 'LICENSE-node'), { dereference: true })
} else {
  console.error(`
!! No Node LICENSE found under ${nodeInstallRoot}.
!! This Node installation (typically the Windows MSI) ships without one, so
!! the packaged app will carry no notice for the Node binary it redistributes.
!! To include it, save
!!   https://raw.githubusercontent.com/nodejs/node/${version}/LICENSE
!! as ${path.join(nodeInstallRoot, 'LICENSE')} and run this again.
`)
}

const outTar = path.join(projectRoot, 'node-runtime.tgz')
rmSync(outTar, { force: true })
execFileSync('tar', ['-czf', outTar, '-C', stage, '.'])
writeFileSync(path.join(projectRoot, 'node-runtime.version'), `${version}\n`)
rmSync(stage, { recursive: true, force: true })
console.log(`bundled Node ${version} (+npm) into node-runtime.tgz`)
