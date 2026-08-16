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

// npm package root: npmCli is <npm>/bin/npm-cli.js (or the bin/npm shim whose
// real tree sits at <bin>/../lib/node_modules/npm).
const npmDirCandidates = [
  path.join(toolchain.nodeDir, '..', 'lib', 'node_modules', 'npm'),
  path.dirname(path.dirname(toolchain.npmCli)),
]
const npmDir = npmDirCandidates.find(dir => existsSync(path.join(dir, 'package.json')))
if (!npmDir) {
  console.error(`npm package tree not found near ${toolchain.npmCli}`)
  process.exit(1)
}

const stage = mkdtempSync(path.join(tmpdir(), 'dsh-node-stage-'))
mkdirSync(path.join(stage, 'bin'), { recursive: true })
mkdirSync(path.join(stage, 'lib', 'node_modules'), { recursive: true })
cpSync(toolchain.nodeBin, path.join(stage, 'bin', 'node'), { dereference: true })
cpSync(npmDir, path.join(stage, 'lib', 'node_modules', 'npm'), { recursive: true, dereference: true })
writeFileSync(path.join(stage, 'VERSION'), `${version}\n`)

const outTar = path.join(projectRoot, 'node-runtime.tgz')
rmSync(outTar, { force: true })
execFileSync('/usr/bin/tar', ['-czf', outTar, '-C', stage, '.'])
writeFileSync(path.join(projectRoot, 'node-runtime.version'), `${version}\n`)
rmSync(stage, { recursive: true, force: true })
console.log(`bundled Node ${version} (+npm) into node-runtime.tgz`)
