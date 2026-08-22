/**
 * What the harness is costing, read from the tools the platform already has.
 *
 * The app ships no dependencies, so there is no native module to ask — and
 * none is needed: `ps` answers in about two milliseconds. What it will not
 * answer is the question people actually want. Its `%cpu` is an average over
 * the process's whole life, so a server that has been idle since Tuesday and
 * one that is pinned right now both read close to zero. The number worth
 * showing is a rate, so this samples the *cumulative* CPU time twice and
 * divides by the wall clock between them, which is instantaneous by
 * construction and means the same thing on every platform.
 *
 * The whole process group is measured, not the server alone. dsh installs
 * plugins with pnpm and delegates to other CLIs, and those children are as
 * much "what the harness is costing" as the parent — a figure that ignored
 * them would be most wrong exactly when the user went looking for it.
 *
 * Deliberately free of Electron imports; the caller injects the exec.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
/** A sample that takes longer than this is not worth the one after it. */
const SAMPLE_TIMEOUT_MS = 4000

/**
 * @typedef {object} Sample
 * @property {number} at monotonic milliseconds
 * @property {number} cpuSeconds cumulative across the tree
 * @property {number} rssBytes resident memory, summed
 * @property {number} processes how many were counted
 * @property {number} threads across the tree, when the platform says
 */

/**
 * Seconds from the shapes `ps` prints elapsed and CPU time in.
 *
 * `MM:SS.ss`, `HH:MM:SS` and `D-HH:MM:SS` all occur, the last once a process
 * has been up for a day — which the server, being a service, reaches often.
 *
 * @param {string} text
 * @returns {number} seconds, or NaN when this is not a time at all
 */
export function parseCpuTime(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return Number.NaN
  const [days, clock] = raw.includes('-') ? raw.split('-') : ['0', raw]
  const parts = clock.split(':').map(Number)
  if (parts.some(Number.isNaN) || parts.length === 0 || parts.length > 3) return Number.NaN
  const [hours, minutes, seconds] = parts.length === 3 ? parts : [0, ...parts.length === 2 ? parts : [0, parts[0]]]
  return Number(days) * 86400 + hours * 3600 + minutes * 60 + seconds
}

/**
 * Totals from `ps -o pid,cputime,rss`.
 *
 * @param {string} stdout including its header line
 * @returns {{processes: number, cpuSeconds: number, rssBytes: number}}
 */
export function parsePs(stdout) {
  let processes = 0
  let cpuSeconds = 0
  let rssBytes = 0
  for (const line of String(stdout ?? '').split('\n').slice(1)) {
    const [, cpu, rss] = line.trim().split(/\s+/)
    const seconds = parseCpuTime(cpu)
    if (Number.isNaN(seconds)) continue
    processes += 1
    cpuSeconds += seconds
    // ps reports RSS in kilobytes on both platforms this ships to.
    rssBytes += (Number(rss) || 0) * 1024
  }
  return { processes, cpuSeconds, rssBytes }
}

/**
 * One reading of a process group.
 *
 * @param {{pid: number, pgid?: number, platform?: string,
 *   exec?: typeof execFileAsync, now?: () => number}} options
 * @returns {Promise<Sample|undefined>} undefined when the process is gone,
 *   which is not an error: the server restarts, and a badge that threw every
 *   time it did would be noisier than the thing it measures
 */
export async function sample({ pid, pgid, platform = process.platform, exec = execFileAsync, now = Date.now }) {
  try {
    return platform === 'win32'
      ? await sampleWindows(pid, exec, now)
      : await samplePosix(pid, pgid, exec, now)
  } catch {
    return undefined
  }
}

async function samplePosix(pid, pgid, exec, now) {
  const at = now()
  // The group when there is one, the process alone otherwise: a server whose
  // group has gone should still report itself rather than nothing.
  const { stdout } = await exec('ps', pgid
    ? ['-o', 'pid,cputime,rss', '-g', String(pgid)]
    : ['-o', 'pid,cputime,rss', '-p', String(pid)], { timeout: SAMPLE_TIMEOUT_MS })
  const totals = parsePs(stdout)
  if (totals.processes === 0) return undefined
  return { at, ...totals, threads: await countThreads(pid, exec) }
}

/**
 * Threads of the main process.
 *
 * Only the server's own, not the group's: `ps -M` takes one pid, and a second
 * process spawn per child to total them would cost more than the number is
 * worth. The server is where the threads that matter are.
 */
async function countThreads(pid, exec) {
  try {
    const { stdout } = await exec('ps', ['-M', '-p', String(pid)], { timeout: SAMPLE_TIMEOUT_MS })
    // One header line, then one line per thread.
    return Math.max(0, String(stdout).trim().split('\n').length - 1)
  } catch {
    return 0
  }
}

/**
 * The same reading on Windows, where there is no process group to ask about.
 *
 * The tree is walked from the root pid through Win32_Process's parent links,
 * and PowerShell returns the totals already summed — one process spawn rather
 * than one per generation. It is the expensive platform: PowerShell costs
 * hundreds of milliseconds to start where `ps` costs two, which is why the
 * badge samples on an interval rather than continuously.
 */
async function sampleWindows(pid, exec, now) {
  const script = `
$ErrorActionPreference = 'Stop'
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId
$ids = New-Object System.Collections.Generic.HashSet[int]
[void]$ids.Add(${pid})
$added = $true
while ($added) {
  $added = $false
  foreach ($p in $all) {
    if ($ids.Contains([int]$p.ParentProcessId) -and -not $ids.Contains([int]$p.ProcessId)) {
      [void]$ids.Add([int]$p.ProcessId); $added = $true
    }
  }
}
$procs = Get-Process -Id $ids -ErrorAction SilentlyContinue
$cpu = ($procs | Measure-Object -Property CPU -Sum).Sum
$ws = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
$threads = ($procs | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum
[pscustomobject]@{
  processes = @($procs).Count
  cpuSeconds = [double]($cpu | ForEach-Object { $_ })
  rssBytes = [double]($ws | ForEach-Object { $_ })
  threads = [int]($threads | ForEach-Object { $_ })
} | ConvertTo-Json -Compress
`
  const at = now()
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { timeout: SAMPLE_TIMEOUT_MS, windowsHide: true })
  const parsed = JSON.parse(String(stdout).trim())
  if (!parsed || Number(parsed.processes) === 0) return undefined
  return {
    at,
    processes: Number(parsed.processes) || 0,
    cpuSeconds: Number(parsed.cpuSeconds) || 0,
    rssBytes: Number(parsed.rssBytes) || 0,
    threads: Number(parsed.threads) || 0,
  }
}

/**
 * The CPU a tree used between two samples, as a percentage of one core.
 *
 * Above 100 on a machine with more than one core, which is the honest
 * reading and the same one `top` gives: a build using four cores flat is
 * doing four hundred percent of a core, and rescaling that to the machine
 * would hide the fact that it is saturating them.
 *
 * @param {Sample} [previous]
 * @param {Sample} [current]
 * @returns {number|undefined} undefined until there are two samples to compare
 */
export function cpuPercent(previous, current) {
  if (previous === undefined || current === undefined) return undefined
  const elapsed = (current.at - previous.at) / 1000
  if (!(elapsed > 0)) return undefined
  const used = current.cpuSeconds - previous.cpuSeconds
  // A restart resets the counter; a negative delta means the thing being
  // measured is not the thing that was measured, so report nothing rather
  // than a number shaped like an answer.
  if (used < 0) return undefined
  return (used / elapsed) * 100
}
