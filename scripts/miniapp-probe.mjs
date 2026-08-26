#!/usr/bin/env node
/**
 * What this machine can tell us about the WeChat DevTools.
 *
 * A diagnostic, not a feature. The simulator integration depends on somebody
 * else's application being installed, configured and running, and when it is
 * not, the interesting question is which of those three it is. This prints
 * that, in a form that can be pasted into a bug report.
 *
 *   node scripts/miniapp-probe.mjs [workspace]
 */
import path from 'node:path'
import { findProjects } from '../src/miniapp-project.js'
import { inspectDevTools, INSTALL_ENV } from '../src/miniapp-tool.js'

const { state, tool, service } = await inspectDevTools()

const explain = {
  missing: 'not installed, or installed somewhere this app does not look'
    + ` (set ${INSTALL_ENV} to point at it)`,
  disabled: 'installed, but its service port is switched off'
    + ' — turn it on under 设置 → 安全设置 → 服务端口',
  stopped: 'installed and not running',
  ready: 'running, and answering on its service port',
}

process.stdout.write(`devtools: ${state} — ${explain[state]}\n`)
if (tool) {
  process.stdout.write(`version:  ${tool.version || 'unknown'}\n`)
  process.stdout.write(`install:  ${tool.installPath}\n`)
  process.stdout.write(`cli:      ${tool.cliPath}\n`)
  process.stdout.write(`userdir:  ${tool.userDir ?? '(none yet — never opened)'}\n`)
}
if (service) {
  const enabled = service.enabled === undefined ? 'unknown' : String(service.enabled)
  process.stdout.write(`service:  port=${service.port ?? '-'} enabled=${enabled}\n`)
}

const workspace = path.resolve(process.argv[2] ?? process.cwd())
const projects = findProjects(workspace)
process.stdout.write(`\nprojects under ${workspace}: ${projects.length}\n`)
for (const project of projects) {
  process.stdout.write(`  ${project.name}  [${project.type}] ${project.appid ?? 'no appid'}  ${project.dir}\n`)
}
