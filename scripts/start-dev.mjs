/**
 * Starts the current source tree through a branded development application.
 *
 * macOS takes the application-menu name from the outer .app bundle, not from
 * app.setName(). electron-builder creates that bundle once; subsequent starts
 * copy only the small source/assets directories into the cache, drop the
 * marker that tells the shell it is a development launch, and re-sign it.
 */
import { spawn } from 'node:child_process'
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_MARKER } from '../src/source-launch.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
// Read rather than reconstructed: the bundle's name and identifier are the
// installer's decision, and a copy of that decision here is a copy that goes
// stale without anything failing.
const config = createRequire(import.meta.url)('./electron-dev.config.cjs')
const cacheDir = config.directories.output
const stampFile = path.join(cacheDir, '.dsh-dev-stamp.json')
const electronPackage = JSON.parse(await readFile(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
const expectedStamp = JSON.stringify({
  schema: 2,
  electron: electronPackage.version,
  name: config.productName,
  appId: config.appId,
})

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(command)} exited ${signal ?? code}`))
    })
  })
}

async function findApp(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const candidate = path.join(directory, entry.name)
    if (entry.isDirectory() && entry.name === `${config.productName}.app`) return candidate
    if (entry.isDirectory()) {
      const nested = await findApp(candidate)
      if (nested) return nested
    }
  }
}

async function cacheIsCurrent() {
  try {
    return (await readFile(stampFile, 'utf8')).trim() === expectedStamp && Boolean(await findApp(cacheDir))
  } catch {
    return false
  }
}

async function buildShell() {
  await mkdir(cacheDir, { recursive: true })
  const builder = path.join(root, 'node_modules', '.bin', 'electron-builder')
  await run(builder, ['--config', 'scripts/electron-dev.config.cjs', '--mac', 'dir', '--publish', 'never'])
  await writeFile(stampFile, `${expectedStamp}\n`)
}

async function refreshSource(appPath) {
  const appRoot = path.join(appPath, 'Contents', 'Resources', 'app')
  for (const name of ['src', 'assets']) {
    const target = path.join(appRoot, name)
    await rm(target, { recursive: true, force: true })
    await cp(path.join(root, name), target, { recursive: true })
  }
  await cp(path.join(root, 'package.json'), path.join(appRoot, 'package.json'))
  // How the shell knows it is a development launch. Inside the bundle rather
  // than in the environment, so that starting this app from Finder is the
  // same launch as `npm start` — see src/source-launch.js.
  await writeFile(path.join(appRoot, DEV_MARKER), `${new Date().toISOString()}\n`)
  // --deep, even though only the outer seal covers the source that just
  // changed: electron-builder is told not to sign at all, and copying the
  // unpacked distribution leaves Electron Framework.framework with a
  // signature its own resources no longer satisfy. Signing the outer bundle
  // alone builds an app that verification rejects.
  await run('codesign', ['--force', '--deep', '--sign', '-', appPath])
  await run('codesign', ['--verify', '--deep', '--strict', appPath])
}

/** Forwards this terminal's signals to the app and mirrors its exit code. */
function supervise(child) {
  const forward = signal => { if (!child.killed) child.kill(signal) }
  process.once('SIGINT', () => forward('SIGINT'))
  process.once('SIGTERM', () => forward('SIGTERM'))
  child.once('error', error => {
    console.error(`could not start the development app: ${error?.message ?? error}`)
    process.exitCode = 1
  })
  child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0) })
}

async function startMac() {
  if (!(await cacheIsCurrent())) await buildShell()
  const appPath = await findApp(cacheDir)
  if (!appPath) throw new Error('branded development app was not created')
  await refreshSource(appPath)
  supervise(spawn(path.join(appPath, 'Contents', 'MacOS', config.productName), [], { cwd: root, stdio: 'inherit' }))
}

async function startElectron() {
  const cli = path.join(root, 'node_modules', 'electron', 'cli.js')
  await run(process.execPath, [cli, '.'])
}

if (process.platform === 'darwin') await startMac()
else await startElectron()
