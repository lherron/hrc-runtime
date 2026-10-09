/** T-08566 stage 2 — retained-evidence eligibility and read-and-project attempt (SPEC §3.4.1, §4). */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { HrcLifecycleEvent, HrcRuntimeSnapshot } from 'hrc-core'
import type { HrcDatabase, RetainedEvidenceOutcomeRecord } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import {
  ExecutionReleaseRefusal,
  validateFrozenExecutionRelease,
} from '../agent-spaces-adapter/aspd-execution-release'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle'
import { listProcessCommands } from '../process-commands'
import type { BrokerHealthState } from '../startup-reconcile/types'
import { persistedAspdExecutionRelease } from './controller/dispatch'
import { BrokerEventMapper } from './event-mapper'
import { leasedTmuxBrokerPaneLive } from './live-substrate'
import {
  ELIGIBLE_STATUSES,
  OFFLINE_EVIDENCE_CAPABILITY,
  OFFLINE_EVIDENCE_PAGE_LIMIT,
  OFFLINE_EVIDENCE_PAGE_MAX_BYTES,
  OFFLINE_EVIDENCE_READER_TIMEOUT_MS,
  OFFLINE_EVIDENCE_SCHEMA,
  OFFLINE_EVIDENCE_SLICE_MAX_BYTES,
  OFFLINE_EVIDENCE_SLICE_MAX_MS,
  OFFLINE_EVIDENCE_SLICE_MAX_PAGES,
  revivableHoldExpired,
} from './offline-evidence-outcomes'
import { callReader } from './offline-evidence-reader'
import {
  type ReleaseIdentity,
  type ValidPage,
  validateOfflineEvidencePage,
  validateOfflineEvidenceTypedError,
} from './offline-evidence-validate'
import { parseBrokerRuntimeHostingState } from './runtime-hosting'

export type OfflineEvidenceOptions = {
  readerTimeoutMs?: number | undefined
  sliceMaxPages?: number | undefined
  sliceMaxBytes?: number | undefined
  sliceMaxMs?: number | undefined
  retryBudget?: number | undefined
}

export type OfflineEvidenceDeps = {
  db: HrcDatabase
  now: () => string
  /** The server's per-runtime owner map (attach flights + retained recovery). */
  ownerMap: Map<string, Promise<unknown>>
  probeBrokerHealth: (socketPath: string) => Promise<BrokerHealthState>
  /** Invocation id held by an active controller client for this runtime, if any. */
  activeClientInvocationId: (runtimeId: string) => string | undefined
  /** Observation fan-out for committed retained rows (follow subscribers only). */
  notifyEvent: (event: HrcLifecycleEvent) => void
  options?: OfflineEvidenceOptions | undefined
  /** T-10632 death evidence for an expired revivable runtime; defaults to `ps`. */
  listProcessCommands?: (() => Promise<string[]>) | undefined
  /** T-10632: whether the T-07047 live-substrate door could still reattach this runtime. */
  probeLiveSubstrate?: ((runtime: HrcRuntimeSnapshot) => Promise<boolean>) | undefined
}

export type Refusal = {
  outcome: string
  reason: string
  recorded: false
}

export type AttemptResult = {
  outcome: string
  detail: Record<string, unknown>
  projectedThroughSeq: number
  currentSeq?: number | undefined
  spawned: boolean
}

// ── eligibility ───────────────────────────────────────────────────────────────

function socketPathOf(runtime: HrcRuntimeSnapshot): string | undefined {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  return hosting?.endpoint.kind === 'unix-jsonrpc-ndjson' ? hosting.endpoint.socketPath : undefined
}

/**
 * The persisted ledger path: normalized substrate, flat broker record, or the
 * `--event-ledger` argument of the persisted broker command. Never guessed.
 */
export function persistedEventLedgerPath(runtime: HrcRuntimeSnapshot): string | undefined {
  const hosting = parseBrokerRuntimeHostingState(runtime)
  if (hosting?.substrate.kind === 'leased-tmux' && hosting.substrate.eventLedgerPath) {
    return hosting.substrate.eventLedgerPath
  }
  const broker = runtime.runtimeStateJson?.['broker']
  if (typeof broker !== 'object' || broker === null) return undefined
  const record = broker as Record<string, unknown>
  if (typeof record['eventLedgerPath'] === 'string' && record['eventLedgerPath'].length > 0) {
    return record['eventLedgerPath']
  }
  const command = record['brokerCommand']
  if (typeof command === 'string') {
    // Persisted commands are shell-quoted per argument for release workers
    // (`'--event-ledger' '/…/events.ndjson'`) and unquoted for checkout brokers.
    const match = /(?:^|\s)['"]?--event-ledger['"]?\s+(?:'([^']+)'|"([^"]+)"|(\S+))/.exec(command)
    const path = match?.[1] ?? match?.[2] ?? match?.[3]
    if (path !== undefined && path.length > 0) return path
  }
  return undefined
}

export async function eligibilityRefusal(
  deps: OfflineEvidenceDeps,
  runtime: HrcRuntimeSnapshot,
  invocationId: string
): Promise<Refusal | undefined> {
  if (runtime.controllerKind !== 'harness-broker') {
    return { outcome: 'offline_read_not_harness_broker', reason: 'controller', recorded: false }
  }
  if (isExternalLifecycleOwner(runtime)) {
    return { outcome: 'offline_read_external_lifecycle', reason: 'external', recorded: false }
  }
  const expiredRevivable =
    !ELIGIBLE_STATUSES.has(runtime.status) && revivableHoldExpired(runtime, Date.now())
  if (!ELIGIBLE_STATUSES.has(runtime.status) && !expiredRevivable) {
    return { outcome: 'offline_read_runtime_revivable', reason: runtime.status, recorded: false }
  }
  if (deps.activeClientInvocationId(runtime.runtimeId) === invocationId) {
    return { outcome: 'offline_read_worker_live', reason: 'active_client', recorded: false }
  }
  const socketPath = socketPathOf(runtime)
  if (socketPath !== undefined && existsSync(socketPath)) {
    const health = await deps.probeBrokerHealth(socketPath)
    if (health !== 'unreachable') {
      return { outcome: 'offline_read_worker_live', reason: health, recorded: false }
    }
  }
  if (expiredRevivable) return await workerGoneRefusal(deps, runtime, socketPath)
  return undefined
}

/**
 * T-10632 (daedalus F1): an unreachable socket is not a dead worker — the health
 * probe maps a slow broker to `unreachable` too. A revivable runtime admitted
 * only by hold expiry needs positive evidence that no door can revive it: every
 * revival ends in `broker.hello` on the endpoint inside the ledger directory,
 * served only by a broker whose argv names that directory, socket and runtime
 * id; and the T-07047 live-substrate door must be closed. Refusals are never
 * recorded, so a broker that later dies is admitted on a later pass.
 */
async function workerGoneRefusal(
  deps: OfflineEvidenceDeps,
  runtime: HrcRuntimeSnapshot,
  socketPath: string | undefined
): Promise<Refusal | undefined> {
  let commands: string[]
  try {
    commands = await (deps.listProcessCommands ?? listProcessCommands)()
  } catch {
    return {
      outcome: 'offline_read_worker_live',
      reason: 'process_table_unavailable',
      recorded: false,
    }
  }
  const ledgerPath = persistedEventLedgerPath(runtime)
  const markers = [
    ...(ledgerPath !== undefined ? [`${dirname(ledgerPath)}/`] : []),
    ...(socketPath !== undefined ? [socketPath] : []),
  ]
  const runtimeIdArg = new RegExp(
    `--runtime-id[= ]['"]?${escapeRegExp(runtime.runtimeId)}(?![\\w-])`
  )
  if (
    commands.some(
      (command) => markers.some((marker) => command.includes(marker)) || runtimeIdArg.test(command)
    )
  ) {
    return { outcome: 'offline_read_worker_live', reason: 'process_table', recorded: false }
  }
  const substrate = parseBrokerRuntimeHostingState(runtime)?.substrate
  if (substrate?.kind === 'leased-tmux') {
    // A probe error mirrors the door, which treats it as "cannot reattach".
    const probe = deps.probeLiveSubstrate ?? (async () => leasedTmuxBrokerPaneLive(substrate))
    const live = await probe(runtime).catch(() => false)
    if (live) {
      return { outcome: 'offline_read_worker_live', reason: 'substrate_live', recorded: false }
    }
  }
  return undefined
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
// ── attempt ───────────────────────────────────────────────────────────────────

export function releaseCapabilityDeclared(releaseRoot: string): boolean | undefined {
  try {
    const manifest = JSON.parse(readFileSync(join(releaseRoot, 'release.json'), 'utf8')) as {
      capabilities?: unknown
    }
    return (
      Array.isArray(manifest.capabilities) &&
      manifest.capabilities.includes(OFFLINE_EVIDENCE_CAPABILITY)
    )
  } catch {
    return undefined
  }
}

export async function readAndProject(
  deps: OfflineEvidenceDeps,
  runtime: HrcRuntimeSnapshot,
  invocationId: string,
  prior: RetainedEvidenceOutcomeRecord | null
): Promise<AttemptResult> {
  const db = deps.db
  const options = deps.options ?? {}
  const invocation = db.brokerInvocations.getByInvocationId(invocationId)
  const startCursor = invocation?.lastProjectedSeq ?? 0
  const base = { projectedThroughSeq: startCursor, spawned: false }

  const release = persistedAspdExecutionRelease(runtime)
  if (release === undefined) {
    return { ...base, outcome: 'offline_reader_unsupported_unbound_release', detail: {} }
  }
  let executable: string
  try {
    executable = validateFrozenExecutionRelease(release).executable
  } catch (error) {
    return {
      ...base,
      outcome: 'release_unavailable',
      detail: {
        releaseId: release.releaseId,
        ...(error instanceof ExecutionReleaseRefusal
          ? { refusal: error.code, refusalDetail: error.detail }
          : { error: error instanceof Error ? error.message : String(error) }),
      },
    }
  }
  const declared = releaseCapabilityDeclared(release.releaseRoot)
  if (declared === undefined) {
    return { ...base, outcome: 'release_unavailable', detail: { releaseId: release.releaseId } }
  }
  if (!declared) {
    return {
      ...base,
      outcome: 'offline_reader_unsupported',
      detail: { releaseId: release.releaseId, capability: OFFLINE_EVIDENCE_CAPABILITY },
    }
  }
  const ledgerPath = persistedEventLedgerPath(runtime)
  if (ledgerPath === undefined) {
    return { ...base, outcome: 'ledger_path_unknown', detail: { releaseId: release.releaseId } }
  }

  const expected: ReleaseIdentity = {
    releaseId: release.releaseId,
    sourceCommit: release.sourceCommit,
    builtAt: release.builtAt,
  }
  const readerTimeoutMs = options.readerTimeoutMs ?? OFFLINE_EVIDENCE_READER_TIMEOUT_MS
  const sliceMaxPages = options.sliceMaxPages ?? OFFLINE_EVIDENCE_SLICE_MAX_PAGES
  const sliceMaxBytes = options.sliceMaxBytes ?? OFFLINE_EVIDENCE_SLICE_MAX_BYTES
  const sliceMaxMs = options.sliceMaxMs ?? OFFLINE_EVIDENCE_SLICE_MAX_MS
  const mapper = new BrokerEventMapper({ db, now: deps.now })

  // A resumed slice must observe the snapshot and currentSeq the previous slice saw.
  const resumeFence =
    prior?.outcome === 'in_progress'
      ? { snapshot: prior.detail['snapshot'], currentSeq: prior.detail['currentSeq'] }
      : undefined

  const startedAt = Date.now()
  let afterSeq = startCursor
  let pages = 0
  let bytes = 0
  let spawned = false
  let firstPage: { snapshot: unknown; currentSeq: number } | undefined = resumeFence
    ? {
        snapshot: resumeFence.snapshot,
        currentSeq: typeof resumeFence.currentSeq === 'number' ? resumeFence.currentSeq : -1,
      }
    : undefined
  let lastPage: ValidPage | undefined

  const detailWith = (extra: Record<string, unknown>) => ({
    releaseId: release.releaseId,
    requestedAfterSeq: startCursor,
    ...extra,
  })

  for (;;) {
    const request = {
      schema: OFFLINE_EVIDENCE_SCHEMA,
      operation: 'eventsSince',
      invocationId,
      afterSeq,
      limit: OFFLINE_EVIDENCE_PAGE_LIMIT,
      maxBytes: OFFLINE_EVIDENCE_PAGE_MAX_BYTES,
    }
    spawned = true
    const call = await callReader(
      executable,
      ledgerPath,
      request,
      OFFLINE_EVIDENCE_PAGE_MAX_BYTES,
      readerTimeoutMs
    )
    pages += 1
    bytes += call.stdoutBytes
    const projectedThroughSeq =
      db.brokerInvocations.getByInvocationId(invocationId)?.lastProjectedSeq ?? afterSeq
    if (call.kind === 'failed') {
      return {
        outcome: call.outcome,
        detail: detailWith(call.detail),
        projectedThroughSeq,
        spawned,
      }
    }
    if (call.kind === 'typed') {
      const typed = validateOfflineEvidenceTypedError(call.response, expected)
      if (!typed.ok) {
        return {
          outcome: typed.outcome,
          detail: detailWith(typed.detail),
          projectedThroughSeq,
          spawned,
        }
      }
      return {
        outcome: typed.code,
        detail: detailWith({ errorCode: typed.code, errorData: typed.error }),
        projectedThroughSeq,
        spawned,
      }
    }
    const verdict = validateOfflineEvidencePage(call.response, expected, invocationId, afterSeq)
    if (!verdict.ok) {
      return {
        outcome: verdict.outcome,
        detail: detailWith(verdict.detail),
        projectedThroughSeq,
        spawned,
      }
    }
    const page = verdict.page
    if (firstPage === undefined) {
      firstPage = { snapshot: page.snapshot, currentSeq: page.currentSeq }
    } else if (
      firstPage.currentSeq !== page.currentSeq ||
      JSON.stringify(firstPage.snapshot) !== JSON.stringify(page.snapshot)
    ) {
      return {
        outcome: 'ledger_snapshot_unstable',
        detail: detailWith({
          currentSeq: page.currentSeq,
          expectedCurrentSeq: firstPage.currentSeq,
          snapshot: page.snapshot,
          expectedSnapshot: firstPage.snapshot,
        }),
        projectedThroughSeq,
        currentSeq: page.currentSeq,
        spawned,
      }
    }

    // Whole page validated: project it in order.
    for (const envelope of page.events) {
      try {
        const result = mapper.applyRetained(envelope)
        if (result.ignoredDelta) continue
        if (!result.idempotent) recordInvocationHistory(db, runtime.runtimeId, envelope, deps.now())
        for (const event of result.lifecycleEvents) deps.notifyEvent(event)
      } catch (error) {
        return {
          outcome: 'projection_halted',
          detail: detailWith({
            seq: envelope.seq,
            type: envelope.type,
            error: error instanceof Error ? error.message : String(error),
          }),
          projectedThroughSeq:
            db.brokerInvocations.getByInvocationId(invocationId)?.lastProjectedSeq ?? afterSeq,
          currentSeq: page.currentSeq,
          spawned,
        }
      }
    }
    mapper.flushIgnoredDeltas(invocationId, true)
    lastPage = page
    afterSeq = page.nextAfterSeq
    const cursor =
      db.brokerInvocations.getByInvocationId(invocationId)?.lastProjectedSeq ?? afterSeq

    if (!page.hasMore) {
      const common = {
        currentSeq: page.currentSeq,
        retentionFloorSeq: page.retentionFloorSeq,
        integrity: page.integrity,
        snapshot: page.snapshot,
        pages,
      }
      const torn =
        typeof page.integrity === 'object' &&
        page.integrity !== null &&
        (page.integrity as { status?: unknown }).status === 'torn_tail'
      if (cursor !== page.currentSeq) {
        return {
          outcome: 'reader_contract_violation',
          detail: detailWith({
            violation: 'incomplete_final_page',
            projectedThroughSeq: cursor,
            ...common,
          }),
          projectedThroughSeq: cursor,
          currentSeq: page.currentSeq,
          spawned,
        }
      }
      return {
        outcome: torn ? 'recovered_torn_tail' : 'recovered',
        detail: detailWith({ projectedThroughSeq: cursor, ...common }),
        projectedThroughSeq: cursor,
        currentSeq: page.currentSeq,
        spawned,
      }
    }
    if (pages >= sliceMaxPages || bytes >= sliceMaxBytes || Date.now() - startedAt >= sliceMaxMs) {
      return {
        outcome: 'in_progress',
        detail: detailWith({
          projectedThroughSeq: cursor,
          currentSeq: lastPage.currentSeq,
          snapshot: lastPage.snapshot,
          pages,
          stdoutBytes: bytes,
        }),
        projectedThroughSeq: cursor,
        currentSeq: lastPage.currentSeq,
        spawned,
      }
    }
  }
}

/** Invocation-level history kept by the fence: `lastEventSeq` and `finalSummary`. */
export function recordInvocationHistory(
  db: HrcDatabase,
  runtimeId: string,
  envelope: InvocationEventEnvelope,
  now: string
): void {
  const invocation = db.brokerInvocations.getByInvocationId(String(envelope.invocationId))
  db.brokerInvocations.update(envelope.invocationId, {
    lastEventSeq: Math.max(invocation?.lastEventSeq ?? 0, envelope.seq),
    updatedAt: now,
  })
  if (envelope.type === 'invocation.summary') {
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (runtime) {
      db.runtimes.update(runtimeId, {
        runtimeStateJson: { ...(runtime.runtimeStateJson ?? {}), finalSummary: envelope.payload },
        updatedAt: runtime.updatedAt,
      })
    }
  }
}
