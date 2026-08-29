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
import { basename, dirname, join, resolve } from 'node:path'

import {
  QUARANTINE_DIRNAME,
  ReleaseGcAbort,
  defaultReleaseRoot,
  isReleaseId,
  matchReleaseIdsUnderRoot,
} from './release-gc.js'

export const MAINTENANCE_LOCK_DIRNAME = 'hrc-runtime-maintenance.lock'
export const SWEEP_SENTINEL = '.sweep-in-progress'
const PROBE_MAX_BUFFER = 256 * 1024 * 1024
const PROBE_SENTINEL = '__PROBE_COMPLETE'
/** Measured on max3: coherence is reached in 1-7 attempts; 10 is the fail-closed ceiling. */
const DEFAULT_BRACKET_ATTEMPTS = 10
/**
 * The exact argv this module spawns. Needed for identity, not just for issuing:
 * the completion sentinel lives in the `sh -c` wrapper's argv, so the `ps` and
 * `lsof` GRANDCHILDREN do not carry it and were counted as foreign churn —
 * measured as the dominant appeared/exited population on a live box.
 */
const PS_SNAPSHOT_ARGV = 'ps -Axo pid=,lstart=,command='
const LSOF_SCAN_ARGV = 'lsof -n -P -Fpn'
/** Pids of every helper this module has spawned in this process. */
const spawnedHelperPids = new Set<number>()

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
  /** Liveness re-check immediately after the scan; see `findLiveOmissions`. */
  checkAlive?: (pids: number[]) => number[]
  /** Targeted probe of pids that appeared mid-scan; see the coherence check. */
  probeSpecificPids?: (pids: number[]) => { paths: string[]; inspectedPids: number[] }
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
  if (typeof result.pid === 'number') spawnedHelperPids.add(result.pid)
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

export function defaultListPids(): { pid: number; command: string; lstart: string }[] {
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
export function defaultProbeOpenPaths(): {
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

/**
 * Targeted follow-up for pids that appeared while the main scan was running.
 * Restricting to a pid list is unsound for ENUMERATING holders (a fork escapes
 * a pre-computed list) but sound for INTERROGATING a specific known process,
 * which is all this asks.
 */
export function defaultProbeSpecificPids(pids: number[]): {
  paths: string[]
  inspectedPids: number[]
} {
  if (pids.length === 0) return { paths: [], inspectedPids: [] }
  // Exit 1 is normal here: lsof reports it when a listed pid has already gone.
  const { stdout } = runProbe(`sudo -n lsof -n -P -Fpn -p ${pids.join(',')} 2>/dev/null`, [0, 1])
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
  return { paths, inspectedPids }
}

/** `ps -p` re-check. A pid absent here has exited, which the spec calls GONE. */
export function defaultCheckAlive(pids: number[]): number[] {
  if (pids.length === 0) return []
  const { stdout } = run('ps', ['-o', 'pid=,state=', '-p', pids.join(',')])
  const alive: number[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\S+)/.exec(line)
    if (match === null) continue
    // A zombie is inert by definition; the spec accepts DEFUNCT as satisfied.
    if ((match[2] ?? '').startsWith('Z')) continue
    alive.push(Number.parseInt(match[1] ?? '', 10))
  }
  return alive
}

function defaultDiskFree(releaseRoot: string): () => string {
  return () => run('df', ['-h', releaseRoot]).stdout.trim().split('\n').slice(-1)[0] ?? ''
}

/** Anchored to ids that actually exist, at ANY path prefix. */
/**
 * Root-anchored, for the same reason phase 1 is: on a shared node a bare id
 * match is evidence about whoever happens to own that path, not about the
 * caller. Both shapes are covered because the root prefix is common to them —
 * `<root>/release-X` (argv keeps the PRE-quarantine path) and
 * `<root>/.gc-quarantine/release-X`.
 */
function matchIds(haystack: string, known: ReadonlySet<string>, releaseRoot: string): string[] {
  return matchReleaseIdsUnderRoot(haystack, known, releaseRoot)
}

/**
 * `server serve` is a SHARED verb on this fleet — taskboard, acp, hrc and hrc-dev
 * all use it — so the daemon gate must discriminate on the BINARY, not the verb.
 * Measured on max3 and mini; a naive `bun .* server serve` match refused the very
 * first live dry-run on `taskboard server serve`, which no unit test saw.
 *
 * Deliberately inclusive in the safe direction: `hrc-dev` runs from a separate
 * export and cannot mint into this release root, but it is counted anyway, since
 * over-refusing costs an operator one more stop while under-refusing costs the
 * proof. The second clause catches worktree and dev builds whose basename is
 * `hrc.js` or anything else under `hrc-cli/bin/`.
 */
export function isHrcDaemonArgv(record: { pid: number; command: string }): {
  pid: number
  command: string
} | null {
  // Tokenise and anchor on the EXECUTABLE POSITION. A substring match hits any
  // process whose command line merely CONTAINS the text — measured live: the
  // operator's own zsh, running a heredoc that quoted "hrc-dev server serve",
  // was reported as a surviving daemon. Same self-inflicted-hit class the
  // release-id matcher already anchors against; the daemon matcher did not.
  const tokens = record.command.trim().split(/\s+/)
  if (tokens.length < 3) return null
  // argv[0] may be the interpreter (`bun /path/to/hrc server serve`).
  const first = basename(tokens[0] ?? '')
  const execIndex = first === 'bun' || first === 'node' ? 1 : 0
  const execPath = tokens[execIndex] ?? ''
  const exec = basename(execPath)
  const isHrcBinary =
    exec === 'hrc' || exec === 'hrc.js' || exec === 'hrc-dev' || /\/hrc-cli\/bin\//.test(execPath)
  if (!isHrcBinary) return null
  // `server serve` must be the actual verb pair, immediately after the binary.
  if (tokens[execIndex + 1] !== 'server' || tokens[execIndex + 2] !== 'serve') return null
  return { pid: record.pid, command: record.command }
}

/**
 * The sweep's own probe helpers appear in its own `ps` snapshot and then exit —
 * they are the most reliably transient processes on the box. They are excluded
 * by IDENTITY, not by luck: every helper this module spawns carries either the
 * completion sentinel or the marker filename in its argv, and both strings are
 * unique to this process.
 */
export function isSweepHelperArgv(command: string, selfMarker: string): boolean {
  const trimmed = command.trim()
  return (
    command.includes(PROBE_SENTINEL) ||
    command.includes(selfMarker) ||
    // The grandchildren: `sh -c` carries the sentinel, its `ps`/`lsof` child does
    // not. Match the exact argv this module issues.
    trimmed === PS_SNAPSHOT_ARGV ||
    trimmed.startsWith(LSOF_SCAN_ARGV) ||
    trimmed.startsWith(`sudo -n ${LSOF_SCAN_ARGV}`)
  )
}

/** Identity of this sweep's processes: recorded spawn pids plus argv shape. */
export function isSweepOwnProcess(
  record: { pid: number; command: string },
  selfPids: ReadonlySet<number>,
  selfMarker: string
): boolean {
  return (
    selfPids.has(record.pid) ||
    spawnedHelperPids.has(record.pid) ||
    isSweepHelperArgv(record.command, selfMarker)
  )
}

/**
 * A pid present in the pre-scan snapshot but absent from lsof coverage is NOT
 * an omission if it simply EXITED — the spec's residue rule is "defunct or
 * gone". Measured on a live max3 window: four consecutive dry-runs refused on
 * transient pids (mdworker_shared, and the probe's own `sh -c ps` helper),
 * which made the gate unsatisfiable on any real macOS box.
 *
 * So liveness is RE-ESTABLISHED after the scan rather than assumed from the
 * earlier snapshot. Only a pid still alive then is a genuine omission.
 */
export function findLiveOmissions(
  snapshot: { pid: number; command: string }[],
  inspectedPids: Iterable<number>,
  stillAlive: Iterable<number>,
  selfPids: Iterable<number>,
  selfMarker: string
): { pid: number; command: string }[] {
  const inspected = new Set(inspectedPids)
  const alive = new Set(stillAlive)
  const self = new Set(selfPids)
  return snapshot.filter(
    (r) =>
      !inspected.has(r.pid) &&
      alive.has(r.pid) &&
      !self.has(r.pid) &&
      !isSweepHelperArgv(r.command, selfMarker)
  )
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
        .map(isHrcDaemonArgv)
        .filter((r): r is { pid: number; command: string } => r !== null))
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

  // Identity of this sweep's own processes. `selfMarker` is unique to this run
  // and appears in every helper argv this module spawns.
  const selfMarker = `hrc-sweep-marker-${process.pid}-`
  const selfPids = new Set<number>([process.pid, process.ppid])
  const checkAlive = deps.checkAlive ?? defaultCheckAlive
  const probeSpecificPids = deps.probeSpecificPids ?? defaultProbeSpecificPids

  let referenced = new Set<string>()
  let inspectedPids = 0
  let privileged = false
  let attempts = 0
  let coherent = false
  let lastIncoherence = 'unknown'

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
    // Residue is "defunct or gone" per spec. A pid in `mid` that lsof did not
    // cover may simply have EXITED; re-establish liveness rather than inferring
    // it from the earlier snapshot, and exclude our own helpers by identity.
    if (!attestation) {
      // Drawn from the PRE-scan snapshot, not the post-scan one. A process that
      // started while lsof was enumerating was never available for it to
      // inspect, so it is not an omission — it is churn, and the bracket's
      // incarnation check below is what owns that case. Measured live: sampling
      // `mid` reported a CoreSimulator process that began mid-scan as a live
      // omission, which is the fork-after-snapshot error in a new place.
      const suspects = before.filter(
        (r) => !pass1.inspectedPids.includes(r.pid) && !selfPids.has(r.pid)
      )
      const stillAlive = suspects.length > 0 ? checkAlive(suspects.map((r) => r.pid)) : []
      const omitted = findLiveOmissions(
        suspects,
        pass1.inspectedPids,
        stillAlive,
        selfPids,
        selfMarker
      )
      if (omitted.length > 0) {
        const first = omitted[0]
        throw new ReleaseGcAbort(
          'probe-incomplete',
          `privileged probe exited 0 but omitted live pid ${first?.pid}: ${first?.command}`
        )
      }
    }

    const hits = new Set<string>()
    for (const record of [...before, ...mid, ...after]) {
      for (const id of matchIds(record.command, known, releaseRoot)) hits.add(id)
    }
    for (const path of [...pass1.paths, ...pass2.paths]) {
      for (const id of matchIds(path, known, releaseRoot)) hits.add(id)
    }

    inspectedPids = pass1.inspectedPids.length
    privileged = true

    // Coherence check. Unrelated churn is NOT a violation — demanding an
    // identical incarnation set never settles on a live Mac (measured: Spotlight
    // alone spawns ~8 mdworker_shared per 45s, and a whole-box lsof takes ~60s).
    // The check exists to catch a REFERENCE moving by fork inheritance or pid
    // reuse, so only two shapes break it:
    //   (a) a pid that APPEARED and was never inspected — it could hold a
    //       reference nothing observed;
    // A pid that appeared and inspects clean, or was inspected clean and then
    // exited, cannot carry a reference (§7 absorbing-state).
    //
    // An EXITED-while-uninspected pid is deliberately NOT a violation, ruled
    // 2026-08-29 after it measured unsatisfiable 4/4 under ordinary churn. The
    // reason it is redundant rather than merely inconvenient: a reference only
    // matters if a LIVE process can resolve it when the scan ends. If P exited
    // uninspected holding one, it reached some Q by fork or SCM_RIGHTS, and
    // every Q is already covered — inspected (a hit refuses `not-quiescent`),
    // appeared-uninspected (the follow-up below), present-uninspected-and-alive
    // (the `probe-incomplete` check above), or itself exited, which ends the
    // chain with no live holder. There is no fourth case. The single thing the
    // dropped rule narrowed is Q-inspected-clean-then-handed-the-descriptor,
    // which is the SCM_RIGHTS timing escape already ratified as accepted
    // residual (C-17003, §1.1/§4.5) — so removing it widens nothing.
    const inspectedBoth = new Set([...pass1.inspectedPids, ...pass2.inspectedPids])
    const beforeKeys = new Set(before.map((r) => `${r.pid}@${r.lstart}`))
    // Keyed on pid@lstart, so a REUSED pid correctly reads as one exit plus one
    // appearance rather than as an unchanged process.
    const foreign = (r: { pid: number; command: string }): boolean =>
      !isSweepOwnProcess(r, selfPids, selfMarker)
    const appeared = after.filter((r) => !beforeKeys.has(`${r.pid}@${r.lstart}`) && foreign(r))

    const appearedUninspected = appeared.filter((r) => !inspectedBoth.has(r.pid))

    // A pid that appeared after the scan began was never available for the main
    // enumeration to see. Ask about it directly rather than discarding the whole
    // bracket: a targeted probe is sound HERE because the question is "does this
    // specific process hold a reference", not "enumerate every holder".
    let unresolved: { pid: number; command: string }[] = []
    if (appearedUninspected.length > 0) {
      const followUp = probeSpecificPids(appearedUninspected.map((r) => r.pid))
      for (const path of followUp.paths) {
        for (const id of matchIds(path, known, releaseRoot)) hits.add(id)
      }
      const nowCovered = new Set(followUp.inspectedPids)
      const stillHere = new Set(checkAlive(appearedUninspected.map((r) => r.pid)))
      // Uninspectable AND still alive is unresolved; already gone is inert.
      unresolved = appearedUninspected.filter((r) => !nowCovered.has(r.pid) && stillHere.has(r.pid))
    }

    referenced = hits

    if (unresolved.length === 0) {
      coherent = true
      break
    }
    lastIncoherence = `pid ${unresolved[0]?.pid} appeared during the scan and could not be inspected: ${unresolved[0]?.command}`
  }

  if (!coherent) {
    throw new ReleaseGcAbort(
      'scan-incoherent',
      `the bracketed scan could not be made coherent in ${maxAttempts} attempts; nothing was deleted. Last: ${lastIncoherence}`
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

/**
 * Read-only inventory of what a successful sweep would reclaim. Printed
 * alongside a dry-run refusal so an operator planning a window can see the
 * prize and the blockers in one place. It makes NO safety claim and touches
 * nothing; the gate's verdict is the refusal, not this.
 */
function quarantineInventory(releaseRoot: string): string {
  const quarantineDir = join(releaseRoot, QUARANTINE_DIRNAME)
  let ids: string[] = []
  try {
    ids = readdirSync(quarantineDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isReleaseId(e.name))
      .map((e) => e.name)
  } catch {
    return `inventory: ${quarantineDir} is not readable or does not exist\n`
  }
  const du = run('du', ['-sh', quarantineDir]).stdout.trim().split(/\s+/)[0] ?? 'unknown'
  const oldest = ids.slice().sort()[0] ?? '(none)'
  return [
    'inventory (read-only, NOT a safety verdict):',
    `  candidates:  ${ids.length}`,
    `  reclaimable: ${du}`,
    `  oldest:      ${oldest}`,
    `  df now:      ${defaultDiskFree(releaseRoot)()}`,
    '',
  ].join('\n')
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
  } catch (error) {
    // A dry-run exists to tell an operator what stands between them and the
    // reclaim. Surfacing the blocker WITH the inventory is the whole point; on
    // --apply the refusal stands alone and nothing is softened.
    if (options.apply !== true && error instanceof ReleaseGcAbort) {
      process.stdout.write(quarantineInventory(releaseRoot))
      process.stdout.write(`blocked by ${error.reason}: ${error.message}\n`)
    }
    throw error
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
