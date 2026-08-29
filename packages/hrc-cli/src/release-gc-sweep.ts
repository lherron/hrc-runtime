/**
 * Release GC phase 2 (T-07686): permanent, irreversible sweep of quarantined
 * release directories.
 *
 * SCOPE BOUNDARY — this is the ONLY module in the repository permitted to unlink
 * a release directory, and only past the quiescence gate below. `release-gc.ts`
 * (phase 1) quarantines by rename and structurally cannot delete;
 * `t07686-release-gc-sweep.test.ts` asserts both halves of that line.
 *
 * The design and its proof are in T-07686's specification field (daedalus
 * APPROVE on rev 9, etag 42; durable invariant `hrc-runtime.quarantined-release-sweep`).
 * Two properties are load-bearing and easy to break by a well-meaning edit:
 *
 *  1. NO REFUSAL PATH MUTATES ANYTHING. Every gate runs to completion before the
 *     first byte of state changes. A safety refusal that still harms inverts the
 *     entire point of a fail-closed gate — that is why the directory tightening
 *     lives inside the delete loop rather than before the probe.
 *  2. PER-CANDIDATE ORDER IS sentinel -> tighten -> unlink. The sentinel precedes
 *     the mode change, not merely the unlink, so a mode-mutated tree is never
 *     classified as intact and restorable.
 */
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  QUARANTINE_DIRNAME,
  ReleaseGcAbort,
  defaultReleaseRoot,
  isReleaseId,
} from './release-gc.js'

export const MAINTENANCE_LOCK_DIRNAME = 'hrc-runtime-maintenance.lock'
export const SWEEP_SENTINEL = '.sweep-in-progress'
const PROBE_MAX_BUFFER = 256 * 1024 * 1024
const PROBE_SENTINEL = '__PROBE_COMPLETE'
/** Measured on max3: coherence is reached in 1-7 attempts; 10 is the fail-closed ceiling. */
const DEFAULT_BRACKET_ATTEMPTS = 10

export interface SweptRelease {
  releaseId: string
  disposition: 'would-sweep' | 'swept' | 'skipped'
  reason?: string
}

export interface SweepReport {
  mode: 'dry-run' | 'apply'
  releaseRoot: string
  quarantineDir: string
  candidates: string[]
  results: SweptRelease[]
  df: { before: string; after: string }
  probe: { passes: number; attempts: number; inspectedPids: number; privileged: boolean }
  summary: { total: number; swept: number; wouldSweep: number; skipped: number }
}

/**
 * Every observation is injectable so the gate is unit-testable without a real
 * quiescent machine. There is exactly one remover and it is named `remove`.
 */
export interface SweepDependencies {
  listQuarantined?: () => string[]
  listPids?: () => { pid: number; command: string; lstart: string }[]
  probeOpenPaths?: () => { paths: string[]; inspectedPids: number[]; privileged: boolean }
  readAttestation?: () => SweepAttestation | undefined
  listServerProcesses?: () => { pid: number; command: string }[]
  isSocketLive?: () => boolean
  isInstallLockHeld?: () => boolean
  statMode?: (path: string) => { mode: number; uid: number }
  listSubtreeDirs?: (releaseDir: string) => string[]
  chmod?: (path: string, mode: number) => void
  writeSentinel?: (releaseDir: string) => void
  remove?: (releaseDir: string) => void
  readDiskFree?: () => string
  now?: () => number
}

export interface SweepAttestation {
  nonce: string
  releaseIds: string[]
  paths: string[]
  inspectedPids: number[]
  privileged: boolean
}

export interface SweepOptions {
  apply?: boolean
  releaseRoot?: string
  minAgeMs?: number
  maxBracketAttempts?: number
  /** Nonce of the maintenance lock this sweep holds. */
  lockNonce?: string
  deps?: SweepDependencies
}

function run(command: string, args: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: PROBE_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const truncated =
    result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOBUFS'
  if (truncated) throw new ReleaseGcAbort('probe-failed', `${command} output was truncated`)
  return { status: result.error ? null : result.status, stdout: result.stdout ?? '' }
}

/**
 * A wrapper's sentinel proves the WRAPPER finished, not the probe. The status it
 * carries must be CHECKED, not merely captured: a probe that emits partial
 * records then dies by SIGTERM still leaves the shell printing
 * `__PROBE_COMPLETE:143`. Measured; that reading was accepted by an earlier
 * revision of this design and would have swept over a live reference.
 */
function runProbe(
  command: string,
  allowedStatuses: readonly number[]
): { stdout: string; status: number } {
  const { stdout } = run('sh', ['-c', `${command}; echo "${PROBE_SENTINEL}:$?"`])
  const match = /__PROBE_COMPLETE:(\d+)\s*$/.exec(stdout.trimEnd())
  if (match === null) {
    throw new ReleaseGcAbort('probe-failed', `probe produced no completion sentinel: ${command}`)
  }
  const status = Number.parseInt(match[1] ?? '', 10)
  if (status >= 128) {
    throw new ReleaseGcAbort(
      'probe-failed',
      `probe died by signal (status ${status}, signal ${status - 128}): ${command}`
    )
  }
  if (!allowedStatuses.includes(status)) {
    throw new ReleaseGcAbort(
      'probe-failed',
      `probe exited ${status}, expected one of ${allowedStatuses.join(',')}: ${command}`
    )
  }
  return { stdout: stdout.slice(0, match.index), status }
}

export function maintenanceLockPath(releaseRoot: string): string {
  return join(dirname(releaseRoot), MAINTENANCE_LOCK_DIRNAME)
}

/** Read-only, and deliberately cheap: `cmdServerStart` calls this on every start. */
export function readMaintenanceLock(
  releaseRoot: string = defaultReleaseRoot()
): { nonce: string; pid: number; startedAt: string } | undefined {
  try {
    const raw = readFileSync(join(maintenanceLockPath(releaseRoot), 'owner.json'), 'utf8')
    return JSON.parse(raw) as { nonce: string; pid: number; startedAt: string }
  } catch {
    return undefined
  }
}

export function acquireMaintenanceLock(releaseRoot: string = defaultReleaseRoot()): {
  nonce: string
  release: () => void
} {
  const lockDir = maintenanceLockPath(releaseRoot)
  try {
    mkdirSync(lockDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const held = readMaintenanceLock(releaseRoot)
    throw new ReleaseGcAbort(
      'maintenance-in-progress',
      `a sweep already holds ${lockDir}${held ? ` (pid ${held.pid}, since ${held.startedAt})` : ''}`
    )
  }
  const nonce = randomUUID()
  writeFileSync(
    join(lockDir, 'owner.json'),
    JSON.stringify({ nonce, pid: process.pid, startedAt: new Date().toISOString() })
  )
  return {
    nonce,
    release: () => {
      const held = readMaintenanceLock(releaseRoot)
      if (held && held.nonce !== nonce) {
        throw new ReleaseGcAbort(
          'maintenance-in-progress',
          `refusing to release a maintenance lock now owned by another process: ${lockDir}`
        )
      }
      rmSync(lockDir, { recursive: true, force: true })
    },
  }
}

function defaultListPids(): { pid: number; command: string; lstart: string }[] {
  const { stdout } = runProbe('ps -Axo pid=,lstart=,command=', [0])
  const records: { pid: number; command: string; lstart: string }[] = []
  for (const line of stdout.split('\n')) {
    // `lstart` is a fixed-width 24-char ctime string; splitting on whitespace
    // would shred it, and pid alone cannot distinguish a reused pid — which is
    // the defect that sank the original coherence join.
    const match = /^\s*(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line)
    if (match === null) continue
    records.push({
      pid: Number.parseInt(match[1] ?? '', 10),
      lstart: match[2] ?? '',
      command: match[3] ?? '',
    })
  }
  if (records.length === 0) throw new ReleaseGcAbort('probe-failed', 'ps returned no processes')
  return records
}

/**
 * Unrestricted and PRIVILEGED. Unrestricted because a pre-computed pid list
 * cannot contain a process forked after it was built; privileged because
 * unprivileged lsof omits ~36% of pids and the cwd/directory-fd class it hides
 * is inside the proof target.
 */
function defaultProbeOpenPaths(): {
  paths: string[]
  inspectedPids: number[]
  privileged: boolean
} {
  const marker = join('/tmp', `hrc-sweep-marker-${process.pid}-${Date.now()}`)
  writeFileSync(marker, '')
  const child = spawnSync('sh', ['-c', `exec 9<'${marker}'; sleep 30 & echo $!`], {
    encoding: 'utf8',
  })
  const markerPid = Number.parseInt((child.stdout ?? '').trim(), 10)
  try {
    // Exit 0 exactly. Status 1 is ambiguous between "some pid inaccessible" and
    // "internal error after partial output"; privilege removes the former, so
    // anything but 0 is a failed observation.
    const { stdout } = runProbe('sudo -n lsof -n -P -Fpn 2>/dev/null', [0])
    const paths: string[] = []
    const inspectedPids: number[] = []
    for (const line of stdout.split('\n')) {
      if (line.startsWith('p')) {
        const pid = Number.parseInt(line.slice(1), 10)
        if (Number.isFinite(pid)) inspectedPids.push(pid)
      } else if (line.startsWith('n')) {
        paths.push(line.slice(1))
      }
    }
    if (inspectedPids.length === 0) {
      throw new ReleaseGcAbort('probe-failed', 'privileged open-paths probe returned no records')
    }
    // Positive end-of-scan witness. Bounds early termination; it is corroboration,
    // not the completeness proof — the exact-zero status above is that.
    if (Number.isFinite(markerPid) && !inspectedPids.includes(markerPid)) {
      throw new ReleaseGcAbort(
        'probe-failed',
        `probe did not reach the marker process ${markerPid}; the scan ended early`
      )
    }
    return { paths, inspectedPids, privileged: true }
  } finally {
    if (Number.isFinite(markerPid)) spawnSync('kill', [String(markerPid)])
    rmSync(marker, { force: true })
  }
}

function defaultDiskFree(releaseRoot: string): () => string {
  return () => run('df', ['-h', releaseRoot]).stdout.trim().split('\n').slice(-1)[0] ?? ''
}

/** Anchored to ids that actually exist, at ANY path prefix. */
function matchIds(haystack: string, known: ReadonlySet<string>): string[] {
  const found: string[] = []
  for (const match of haystack.matchAll(/release-[0-9][0-9A-Za-z._-]*/g)) {
    const id = match[0]
    if (known.has(id)) found.push(id)
  }
  return found
}

function incarnationKey(records: { pid: number; lstart: string }[]): string {
  return records
    .map((r) => `${r.pid}@${r.lstart}`)
    .sort()
    .join('\n')
}

export function collectSweep(options: SweepOptions = {}): SweepReport {
  const releaseRoot = resolve(options.releaseRoot ?? defaultReleaseRoot())
  const quarantineDir = join(releaseRoot, QUARANTINE_DIRNAME)
  const deps = options.deps ?? {}
  const apply = options.apply === true

  const listQuarantined =
    deps.listQuarantined ??
    (() => {
      try {
        return readdirSync(quarantineDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        return []
      }
    })
  const statMode =
    deps.statMode ??
    ((path: string) => {
      const st = statSync(path)
      return { mode: st.mode & 0o777, uid: st.uid }
    })
  const listServerProcesses =
    deps.listServerProcesses ??
    (() =>
      defaultListPids()
        .filter((r) => /(^|\/)(bun|node)\b.*\bserver serve\b/.test(r.command))
        .map((r) => ({ pid: r.pid, command: r.command })))
  const isSocketLive = deps.isSocketLive ?? (() => false)
  const isInstallLockHeld =
    deps.isInstallLockHeld ??
    (() => {
      try {
        return statSync(join(dirname(releaseRoot), 'hrc-runtime-install.lock')).isDirectory()
      } catch {
        return false
      }
    })
  const readDiskFree = deps.readDiskFree ?? defaultDiskFree(releaseRoot)

  // ---- GATES. Everything here is observation only; nothing below mutates. ----

  if (isInstallLockHeld()) {
    throw new ReleaseGcAbort('install-in-progress', 'an install holds the release lock')
  }

  // Step 2 verification: the sweeping user owns no surviving daemon. This is a
  // structural fact (ps), never the exit status of a stop or bootout — those
  // report actuation, not outcome.
  const survivors = listServerProcesses()
  if (survivors.length > 0) {
    const first = survivors[0]
    throw new ReleaseGcAbort(
      'daemon-still-up',
      `pid ${first?.pid} is still running a daemon owned by this user: ${first?.command}`
    )
  }
  if (isSocketLive()) {
    throw new ReleaseGcAbort('daemon-still-up', 'the daemon socket still accepts connections')
  }

  // The principal argument (§4.1.1) has no support unless the root is owner-only.
  const rootMode = statMode(releaseRoot)
  if (rootMode.mode !== 0o700) {
    throw new ReleaseGcAbort(
      'root-permissive',
      `release root is mode ${rootMode.mode.toString(8)}, not 700 — a foreign uid can acquire a descriptor into it. Fix: chmod 700 ${releaseRoot}`
    )
  }

  const candidates = listQuarantined()
    .filter((name) => isReleaseId(name))
    .sort()
  const known = new Set(candidates)

  // ---- BRACKETED SCAN ----
  const listPids = deps.listPids ?? defaultListPids
  const probeOpenPaths = deps.probeOpenPaths ?? defaultProbeOpenPaths
  const attestation = deps.readAttestation?.()
  const maxAttempts = options.maxBracketAttempts ?? DEFAULT_BRACKET_ATTEMPTS

  let referenced = new Set<string>()
  let inspectedPids = 0
  let privileged = false
  let attempts = 0
  let coherent = false

  for (attempts = 1; attempts <= maxAttempts; attempts += 1) {
    const before = listPids()
    const pass1 = attestation
      ? {
          paths: attestation.paths,
          inspectedPids: attestation.inspectedPids,
          privileged: attestation.privileged,
        }
      : probeOpenPaths()
    const mid = listPids()
    const pass2 = attestation ? pass1 : probeOpenPaths()
    const after = listPids()

    if (!pass1.privileged || !pass2.privileged) {
      throw new ReleaseGcAbort(
        'probe-unprivileged',
        'no complete (privileged) open-paths observation is obtainable; the principal holding authority on this node must supply it'
      )
    }
    if (attestation) {
      if (attestation.nonce !== options.lockNonce) {
        throw new ReleaseGcAbort(
          'attestation-stale',
          'the attestation nonce does not match the maintenance lock this sweep holds'
        )
      }
      const missing = candidates.filter((id) => !attestation.releaseIds.includes(id))
      if (missing.length > 0) {
        throw new ReleaseGcAbort(
          'attestation-scope',
          `the attestation does not cover ${missing.length} candidate(s), first ${missing[0]}`
        )
      }
    }
    // Every pid the probe was expected to inspect must appear; an exit-0 probe
    // that skipped a live pid contradicts itself.
    const inspected = new Set(pass1.inspectedPids)
    const omitted = mid.filter((r) => !inspected.has(r.pid))
    if (!attestation && omitted.length > 0) {
      const first = omitted[0]
      throw new ReleaseGcAbort(
        'probe-incomplete',
        `privileged probe exited 0 but omitted live pid ${first?.pid}: ${first?.command}`
      )
    }

    const hits = new Set<string>()
    for (const record of [...before, ...mid, ...after]) {
      for (const id of matchIds(record.command, known)) hits.add(id)
    }
    for (const path of [...pass1.paths, ...pass2.paths]) {
      for (const id of matchIds(path, known)) hits.add(id)
    }

    inspectedPids = pass1.inspectedPids.length
    privileged = true
    referenced = hits

    // Churn check: no process may appear, exit, or reuse a pid across the bracket.
    if (incarnationKey(before) === incarnationKey(after)) {
      coherent = true
      break
    }
  }

  if (!coherent) {
    throw new ReleaseGcAbort(
      'scan-incoherent',
      `process churn defeated the bracketed scan after ${maxAttempts} attempts; nothing was deleted`
    )
  }

  if (referenced.size > 0) {
    const first = [...referenced].sort()[0]
    throw new ReleaseGcAbort(
      'not-quiescent',
      `${referenced.size} quarantined release(s) are still referenced, first ${first}`
    )
  }

  // ---- MUTATION. Past this line, and only past it, state changes. ----

  const listSubtreeDirs =
    deps.listSubtreeDirs ??
    ((releaseDir: string) => {
      const out: string[] = []
      const walk = (dir: string): void => {
        out.push(dir)
        let entries: Dirent[]
        try {
          entries = readdirSync(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) if (entry.isDirectory()) walk(join(dir, entry.name))
      }
      walk(releaseDir)
      return out
    })
  const chmod = deps.chmod ?? ((path: string, mode: number) => chmodSync(path, mode))
  const writeSentinel =
    deps.writeSentinel ??
    ((releaseDir: string) =>
      writeFileSync(join(releaseDir, SWEEP_SENTINEL), new Date().toISOString()))
  const remove =
    deps.remove ?? ((releaseDir: string) => rmSync(releaseDir, { recursive: true, force: true }))

  const before = readDiskFree()
  const results: SweptRelease[] = []
  let swept = 0
  let wouldSweep = 0
  let skipped = 0

  for (const releaseId of candidates) {
    if (!apply) {
      wouldSweep += 1
      results.push({ releaseId, disposition: 'would-sweep' })
      continue
    }
    // Re-assert step 2 before each candidate. The maintenance lock enforces L1,
    // but a daemon brought up by an out-of-tree binary would not honour it.
    const stillClear = listServerProcesses()
    if (stillClear.length > 0) {
      results.push({
        releaseId,
        disposition: 'skipped',
        reason: `daemon-resurrected: pid ${stillClear[0]?.pid}`,
      })
      skipped += 1
      for (const remaining of candidates.slice(candidates.indexOf(releaseId) + 1)) {
        results.push({ releaseId: remaining, disposition: 'skipped', reason: 'daemon-resurrected' })
        skipped += 1
      }
      break
    }
    const releaseDir = join(quarantineDir, releaseId)
    // Order is load-bearing: sentinel, then tighten, then unlink.
    writeSentinel(releaseDir)
    for (const dir of listSubtreeDirs(releaseDir)) chmod(dir, 0o700)
    remove(releaseDir)
    swept += 1
    results.push({ releaseId, disposition: 'swept' })
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    releaseRoot,
    quarantineDir,
    candidates,
    results,
    df: { before, after: readDiskFree() },
    probe: { passes: 2, attempts, inspectedPids, privileged },
    summary: { total: candidates.length, swept, wouldSweep, skipped },
  }
}

export function formatSweepReport(report: SweepReport): string {
  const lines = [
    `release gc sweep (${report.mode}) quarantine=${report.quarantineDir}`,
    `probe: privileged=${report.probe.privileged} passes=${report.probe.passes} attempts=${report.probe.attempts} inspected-pids=${report.probe.inspectedPids}`,
  ]
  for (const result of report.results) {
    lines.push(
      `[${result.disposition}] ${result.releaseId}${result.reason ? `: ${result.reason}` : ''}`
    )
  }
  lines.push(`df before: ${report.df.before}`)
  lines.push(`df after:  ${report.df.after}`)
  lines.push(
    `summary: total=${report.summary.total} swept=${report.summary.swept} would-sweep=${report.summary.wouldSweep} skipped=${report.summary.skipped}`
  )
  return `${lines.join('\n')}\n`
}

export function cmdAdminReleaseSweep(options: { apply?: boolean; json?: boolean }): SweepReport {
  const releaseRoot = defaultReleaseRoot()
  const lock = acquireMaintenanceLock(releaseRoot)
  try {
    const report = collectSweep({ apply: options.apply === true, lockNonce: lock.nonce })
    process.stdout.write(
      options.json === true ? `${JSON.stringify(report, null, 2)}\n` : formatSweepReport(report)
    )
    return report
  } finally {
    lock.release()
  }
}

/** Exported for `cmdServerStart`, which must refuse in BOTH of its branches. */
export function assertNoMaintenanceSweep(releaseRoot: string = defaultReleaseRoot()): void {
  const held = readMaintenanceLock(releaseRoot)
  if (held !== undefined) {
    throw new ReleaseGcAbort(
      'maintenance-in-progress',
      `a release sweep holds ${maintenanceLockPath(releaseRoot)} (pid ${held.pid}, since ${held.startedAt}); starting a daemon now would break its quiescence proof`
    )
  }
}
