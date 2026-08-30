/**
 * Release GC phase 1 (T-07683): fenced, reversible quarantine of old atomic
 * release directories.
 *
 * SCOPE BOUNDARY — do not weaken. This module quarantines by RENAME and can
 * never delete. It deliberately exposes no removal capability and imports no
 * unlinking primitive; `t07683-release-gc.test.ts` asserts that structurally.
 * Permanent deletion is T-07686 and is gated on a quiescence proof that does not
 * exist yet. The unprivileged observation here is admittedly partial (see
 * `assessReferences`), which is exactly why the only mutation is reversible.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, realpathSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

export const QUARANTINE_DIRNAME = '.gc-quarantine'
const RELEASE_ID_PATTERN = /^release-[A-Za-z0-9._-]+$/
/**
 * Release ids are only evidence when they sit under the CALLER's release root.
 * Matching the bare `hrc-runtime-releases/` segment matches every principal's
 * root on a shared node — measured on mini, where lherron's gc refused on lab's
 * broker and lab's refused on lherron's, leaving neither able to quarantine.
 */
export function matchReleaseIdsUnderRoot(
  haystack: string,
  known: ReadonlySet<string>,
  releaseRoot: string
): string[] {
  const found: string[] = []
  const needle = `${releaseRoot}/`
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    // The id is the first path segment after the root, or after the quarantine
    // directory — argv keeps the PRE-quarantine path, so both shapes occur.
    const match = /^(?:\.gc-quarantine\/)?(release-[A-Za-z0-9._-]+)/.exec(
      haystack.slice(at + needle.length)
    )
    const id = match?.[1]
    if (id !== undefined && known.has(id)) found.push(id)
  }
  return found
}

export type ReleaseGcDisposition =
  | 'keep'
  | 'would-quarantine'
  | 'quarantined'
  | 'restored'
  | 'error'

export interface ReleaseGcResult {
  releaseId: string
  rank: number
  disposition: ReleaseGcDisposition
  /** Every fence that matched, not just the first — observers must stay visible. */
  reasons: string[]
}

export interface ReleaseGcReport {
  mode: 'dry-run' | 'apply' | 'restore'
  releaseRoot: string
  keep: number
  /** Pids the open-paths probe could not inspect. Reported, never assumed away. */
  omittedPidCount: number
  observers: { argv: string[]; openPaths: string[]; runtimeRecords: string[] }
  installed?: string
  running?: string
  df: { before: string; after: string }
  results: ReleaseGcResult[]
  summary: {
    total: number
    kept: number
    wouldQuarantine: number
    quarantined: number
    errors: number
  }
}

export interface PidRecord {
  pid: number
  command: string
}

/**
 * Every observation is injectable so the fences are unit-testable without live
 * processes. There is no remover here, by design (see the file header).
 */
export interface ReleaseGcDependencies {
  listPids?: () => PidRecord[]
  readOpenPaths?: (pids: number[]) => { covered: number[]; paths: string[]; failed: boolean }
  readRuntimeRecords?: () => string[]
  readServerStatus?: () => { running: boolean; releasePath?: string }
  readInstalledLink?: () => string | undefined
  listReleaseDirs?: () => string[]
  isInstallLockHeld?: () => boolean
  rename?: (from: string, to: string) => void
  readDiskFree?: () => string
}

export interface ReleaseGcOptions {
  keep?: number
  apply?: boolean
  restore?: string
  releaseRoot?: string
  deps?: ReleaseGcDependencies
}

export class ReleaseGcAbort extends Error {
  readonly reason: string
  constructor(reason: string, message: string) {
    super(message)
    this.reason = reason
    this.name = 'ReleaseGcAbort'
  }
}

export function defaultReleaseRoot(): string {
  return join(homedir(), '.bun', 'install', 'hrc-runtime-releases')
}

function installedLinkPath(releaseRoot: string): string {
  return join(dirname(releaseRoot), 'hrc-runtime-current')
}

function installLockPath(releaseRoot: string): string {
  return join(dirname(releaseRoot), 'hrc-runtime-install.lock')
}

/**
 * The open-paths probe emits ~2.9MB on a busy host, well over the 1MB default
 * `maxBuffer`, and truncation is SILENT — measured: 2,854,925 bytes produced,
 * 1,572,702 returned, 715 of ~1160 pids visible. That under-observation is in
 * the unsafe direction (a missed reference reads as "unreferenced"), so the
 * buffer is explicit and any truncation is surfaced rather than absorbed.
 */
const PROBE_MAX_BUFFER = 256 * 1024 * 1024

/**
 * Every probe here is synchronous and was previously unbounded, so a single
 * wedged child blocked the whole GC indefinitely. `lsof` in particular makes
 * blocking kernel calls on mounted filesystems and can stall for tens of
 * seconds on a degraded network mount. (T-07740)
 */
const PROBE_TIMEOUT_MS = 20_000

function run(
  command: string,
  args: string[]
): { status: number | null; stdout: string; truncated: boolean } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: PROBE_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: PROBE_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  })
  // Node/Bun signal an exceeded buffer through `error` (ENOBUFS). Treat it as a
  // probe failure, never as a short but valid reading.
  const truncated =
    result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOBUFS'
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
    truncated,
  }
}

/** Release ids embed a sortable timestamp; one sort key, deliberately. */
export function isReleaseId(name: string): boolean {
  return RELEASE_ID_PATTERN.test(name)
}

function defaultListPids(): PidRecord[] {
  const { status, stdout, truncated } = run('ps', ['-Axo', 'pid=,command='])
  if (truncated) throw new ReleaseGcAbort('probe-failed', 'ps output was truncated')
  if (status !== 0) throw new ReleaseGcAbort('probe-failed', 'ps enumeration failed')
  const records: PidRecord[] = []
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const space = trimmed.indexOf(' ')
    if (space <= 0) continue
    const pid = Number.parseInt(trimmed.slice(0, space), 10)
    if (!Number.isFinite(pid)) continue
    records.push({ pid, command: trimmed.slice(space + 1) })
  }
  if (records.length === 0) throw new ReleaseGcAbort('probe-failed', 'ps returned no processes')
  return records
}

/**
 * Pid-scoped, never `+D` — a tree walk over the release root does not converge.
 *
 * `-b` keeps lsof off blocking kernel calls against mounted filesystems. A
 * degraded network mount otherwise stalls this probe for tens of seconds, and
 * this probe is SYNCHRONOUS. Verified on max3 that `-b` preserves every
 * release-root path this gate reads (parity across repeated samples); `-w`
 * drops the mount warnings `-b` would otherwise print.
 *
 * `-b` is safe here ONLY because the selector is a pid list. With path
 * arguments it forbids the stat() lsof needs to resolve a path to a dev/inode
 * and silently reports nothing — and "nothing open" here means "unreferenced",
 * which deletes a release out from under a running process. Do not convert this
 * probe to path arguments. (T-07740)
 */
export function lsofOpenPathsArgv(pids: number[]): string[] {
  return ['-b', '-w', '-n', '-P', '-Fpn', '-p', pids.join(',')]
}

function defaultReadOpenPaths(pids: number[]): {
  covered: number[]
  paths: string[]
  failed: boolean
} {
  const { stdout, truncated } = run('lsof', lsofOpenPathsArgv(pids))
  if (truncated) {
    throw new ReleaseGcAbort('probe-failed', 'open-paths probe output was truncated')
  }
  const { covered, paths } = parseLsofOpenPaths(stdout)
  // Partial coverage is expected and is NOT a failure; total silence is.
  return { covered, paths, failed: covered.length === 0 }
}

export function parseLsofOpenPaths(stdout: string): { covered: number[]; paths: string[] } {
  const covered: number[] = []
  const paths: string[] = []
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number.parseInt(line.slice(1), 10)
      if (Number.isFinite(pid)) covered.push(pid)
    } else if (line.startsWith('n/')) {
      // Only ABSOLUTE names are paths. lsof also emits non-path `n` fields such
      // as `ncount=3, state=0x10` for sockets; admitting those as "open paths"
      // feeds noise to the release-id matcher. (T-07740)
      paths.push(line.slice(1))
    }
  }
  return { covered, paths }
}

function defaultReadRuntimeRecords(): string[] {
  const { status, stdout } = run('hrc', ['runtime', 'list', '--json'])
  if (status !== 0) return []
  return [stdout]
}

function defaultReadServerStatus(): { running: boolean; releasePath?: string } {
  const { status, stdout } = run('hrc', ['server', 'status', '--json'])
  if (status !== 0 && stdout.trim() === '') {
    throw new ReleaseGcAbort('status-unreadable', 'hrc server status did not answer')
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>
  } catch {
    throw new ReleaseGcAbort('status-unreadable', 'hrc server status returned unparseable JSON')
  }
  const running = parsed['running'] === true
  const release = parsed['release']
  if (release !== null && typeof release === 'object') {
    const record = release as Record<string, unknown>
    // Read from the daemon's own captured identity, NEVER derived from the symlink.
    if (record['mode'] === 'atomic' && typeof record['releasePath'] === 'string') {
      return { running, releasePath: record['releasePath'] }
    }
  }
  return { running }
}

function defaultReadInstalledLink(releaseRoot: string): () => string | undefined {
  return () => {
    try {
      return realpathSync(installedLinkPath(releaseRoot))
    } catch {
      throw new ReleaseGcAbort(
        'installed-link-unreadable',
        `cannot resolve ${installedLinkPath(releaseRoot)}`
      )
    }
  }
}

function defaultDiskFree(releaseRoot: string): () => string {
  return () => run('df', ['-h', releaseRoot]).stdout.trim().split('\n').slice(-1)[0] ?? ''
}

interface ReferenceIndex {
  argv: Set<string>
  openPaths: Set<string>
  runtimeRecords: Set<string>
  omittedPidCount: number
}

/**
 * Three independent partial observers, unioned. Each has been measured to catch
 * something the others miss, and which one is load-bearing changes over time —
 * so none is ever pruned for looking redundant today.
 */
function assessReferences(
  known: ReadonlySet<string>,
  releaseRoot: string,
  deps: Required<Pick<ReleaseGcDependencies, 'listPids' | 'readOpenPaths' | 'readRuntimeRecords'>>
): ReferenceIndex {
  const pids = deps.listPids()
  const selfPids = new Set([process.pid, process.ppid])

  const argv = new Set<string>()
  const argvByPid = new Map<number, string>()
  for (const record of pids) {
    if (selfPids.has(record.pid)) continue
    argvByPid.set(record.pid, record.command)
    for (const id of matchReleaseIdsUnderRoot(record.command, known, releaseRoot)) argv.add(id)
  }

  const probe = deps.readOpenPaths(pids.map((record) => record.pid))
  if (probe.failed) {
    throw new ReleaseGcAbort('probe-failed', 'open-paths probe returned no process records')
  }
  const openPaths = new Set<string>()
  for (const path of probe.paths)
    for (const id of matchReleaseIdsUnderRoot(path, known, releaseRoot)) openPaths.add(id)

  // Per-pid omission is expected (SIP-protected and foreign-uid processes are
  // unreadable unprivileged). It is only an abort when an UNINSPECTED pid is
  // itself running out of the release root — a case `ps` can always answer.
  const covered = new Set(probe.covered)
  let omittedPidCount = 0
  for (const [pid, command] of argvByPid) {
    if (covered.has(pid)) continue
    omittedPidCount += 1
    // Anchored on the CALLER's root. `basename(releaseRoot)` is
    // "hrc-runtime-releases", which every principal on the node shares, so the
    // old check fired on a foreign uid's broker — uninspectable by construction,
    // making the gate permanently unsatisfiable for both users.
    if (command.includes(`${releaseRoot}/release-`)) {
      throw new ReleaseGcAbort(
        'probe-incomplete',
        `pid ${pid} runs from this release root but could not be inspected: ${command}`
      )
    }
  }

  const runtimeRecords = new Set<string>()
  for (const blob of deps.readRuntimeRecords()) {
    for (const id of matchReleaseIdsUnderRoot(blob, known, releaseRoot)) runtimeRecords.add(id)
  }

  return { argv, openPaths, runtimeRecords, omittedPidCount }
}

export function collectReleaseGc(options: ReleaseGcOptions = {}): ReleaseGcReport {
  const releaseRoot = resolve(options.releaseRoot ?? defaultReleaseRoot())
  const keep = options.keep ?? 5
  if (!Number.isInteger(keep) || keep < 1) {
    throw new ReleaseGcAbort('bad-usage', '--keep must be an integer >= 1')
  }
  const deps = options.deps ?? {}
  const listReleaseDirs =
    deps.listReleaseDirs ??
    (() =>
      readdirSync(releaseRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name))
  const isInstallLockHeld =
    deps.isInstallLockHeld ??
    (() => {
      try {
        return statSync(installLockPath(releaseRoot)).isDirectory()
      } catch {
        return false
      }
    })
  const readDiskFree = deps.readDiskFree ?? defaultDiskFree(releaseRoot)
  const rename = deps.rename ?? ((from: string, to: string) => renameSync(from, to))

  // Fence (d): an in-flight install has a valid-named dir with no manifest, no
  // symlink pointing at it and no live process inside — every other fence misses it.
  if (isInstallLockHeld()) {
    throw new ReleaseGcAbort('install-in-progress', 'an install holds the release lock')
  }

  const releaseIds = listReleaseDirs()
    .filter((name) => name !== QUARANTINE_DIRNAME && isReleaseId(name))
    .sort()
    .reverse()
  const known = new Set(releaseIds)

  const references = assessReferences(known, releaseRoot, {
    listPids: deps.listPids ?? defaultListPids,
    readOpenPaths: deps.readOpenPaths ?? defaultReadOpenPaths,
    readRuntimeRecords: deps.readRuntimeRecords ?? defaultReadRuntimeRecords,
  })

  // Fences (a) and (b) are INDEPENDENT and both always apply: atomic-install
  // moves the symlink before the daemon restarts, so installed != running is a
  // legitimate steady state and must never collapse into one value.
  const installedPath = (deps.readInstalledLink ?? defaultReadInstalledLink(releaseRoot))()
  const installed = installedPath ? basename(installedPath) : undefined
  const status = (deps.readServerStatus ?? defaultReadServerStatus)()
  const running = status.releasePath ? basename(status.releasePath) : undefined

  const before = readDiskFree()
  const results: ReleaseGcResult[] = []
  let quarantined = 0
  let errors = 0
  let kept = 0
  let wouldQuarantine = 0

  releaseIds.forEach((releaseId, index) => {
    const rank = index + 1
    const reasons: string[] = []
    if (releaseId === installed) reasons.push('installed')
    if (releaseId === running) reasons.push('running')
    if (references.argv.has(releaseId)) reasons.push('referenced: argv')
    if (references.openPaths.has(releaseId)) reasons.push('referenced: open path')
    if (references.runtimeRecords.has(releaseId)) reasons.push('referenced: runtime record')
    if (rank <= keep) reasons.push(`within --keep ${keep}`)

    if (reasons.length > 0) {
      kept += 1
      results.push({ releaseId, rank, disposition: 'keep', reasons })
      return
    }
    if (options.apply !== true) {
      wouldQuarantine += 1
      results.push({ releaseId, rank, disposition: 'would-quarantine', reasons: [] })
      return
    }
    try {
      const from = join(releaseRoot, releaseId)
      // Re-check at the point of mutation, not only in the plan.
      if (!statSync(from).isDirectory()) throw new Error('not a directory')
      mkdirSync(join(releaseRoot, QUARANTINE_DIRNAME), { recursive: true })
      rename(from, join(releaseRoot, QUARANTINE_DIRNAME, releaseId))
      quarantined += 1
      results.push({ releaseId, rank, disposition: 'quarantined', reasons: [] })
    } catch (error) {
      errors += 1
      results.push({
        releaseId,
        rank,
        disposition: 'error',
        reasons: [error instanceof Error ? error.message : String(error)],
      })
    }
  })

  return {
    mode: options.apply === true ? 'apply' : 'dry-run',
    releaseRoot,
    keep,
    omittedPidCount: references.omittedPidCount,
    observers: {
      argv: [...references.argv].sort(),
      openPaths: [...references.openPaths].sort(),
      runtimeRecords: [...references.runtimeRecords].sort(),
    },
    ...(installed ? { installed } : {}),
    ...(running ? { running } : {}),
    df: { before, after: readDiskFree() },
    results,
    summary: { total: releaseIds.length, kept, wouldQuarantine, quarantined, errors },
  }
}

export function restoreQuarantinedRelease(options: ReleaseGcOptions = {}): ReleaseGcReport {
  const releaseRoot = resolve(options.releaseRoot ?? defaultReleaseRoot())
  const releaseId = options.restore
  if (releaseId === undefined || !isReleaseId(releaseId)) {
    throw new ReleaseGcAbort('bad-usage', `not a release id: ${releaseId ?? '(missing)'}`)
  }
  const deps = options.deps ?? {}
  const rename = deps.rename ?? ((from: string, to: string) => renameSync(from, to))
  const readDiskFree = deps.readDiskFree ?? defaultDiskFree(releaseRoot)
  const before = readDiskFree()
  rename(join(releaseRoot, QUARANTINE_DIRNAME, releaseId), join(releaseRoot, releaseId))
  return {
    mode: 'restore',
    releaseRoot,
    keep: 0,
    omittedPidCount: 0,
    observers: { argv: [], openPaths: [], runtimeRecords: [] },
    df: { before, after: readDiskFree() },
    results: [{ releaseId, rank: 0, disposition: 'restored', reasons: [] }],
    summary: { total: 1, kept: 0, wouldQuarantine: 0, quarantined: 0, errors: 0 },
  }
}

export function formatReleaseGcReport(report: ReleaseGcReport): string {
  const lines = [`release gc (${report.mode}) root=${report.releaseRoot}`]
  for (const result of report.results) {
    const why = result.reasons.length > 0 ? `: ${result.reasons.join(', ')}` : ''
    lines.push(`[${result.disposition}] #${result.rank} ${result.releaseId}${why}`)
  }
  lines.push(
    `observers: argv=${report.observers.argv.length} open-paths=${report.observers.openPaths.length} runtime-records=${report.observers.runtimeRecords.length} uninspected-pids=${report.omittedPidCount}`
  )
  lines.push(`df before: ${report.df.before}`)
  lines.push(`df after:  ${report.df.after}`)
  lines.push(
    `summary: total=${report.summary.total} kept=${report.summary.kept} would-quarantine=${report.summary.wouldQuarantine} quarantined=${report.summary.quarantined} errors=${report.summary.errors}`
  )
  return `${lines.join('\n')}\n`
}

export interface ReleaseGcCommandOptions {
  keep?: string
  apply?: boolean
  restore?: string
  json?: boolean
}

export function cmdAdminReleaseGc(options: ReleaseGcCommandOptions): ReleaseGcReport {
  const report =
    options.restore !== undefined
      ? restoreQuarantinedRelease({ restore: options.restore })
      : collectReleaseGc({
          ...(options.keep !== undefined ? { keep: Number.parseInt(options.keep, 10) } : {}),
          apply: options.apply === true,
        })
  process.stdout.write(
    options.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatReleaseGcReport(report)
  )
  return report
}
