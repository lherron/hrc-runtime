/**
 * T-08566 stage 2 — retained-evidence recovery (SPEC §3.4.1, §3.4.4, §4).
 *
 * Reads committed normalized envelopes of a dead worker through the exact
 * persisted owning release's `evidence-read` mode, validates each page whole,
 * and projects it through `BrokerEventMapper.applyRetained` under the
 * retained-evidence fence. It holds no ACK, opens no control or observer socket
 * and writes nothing under the ledger directory.
 *
 * Authority: a recovery attempt owns its runtime exclusively (see
 * runtime-exclusive-owner.ts). Only `terminated`/`failed` harness-broker
 * runtimes with an unreachable endpoint are eligible; everything else is refused
 * before any reader spawns or any cursor moves.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type {
  CaptureRecoverResponse,
  HrcLifecycleEvent,
  HrcRuntimeSnapshot,
  RetainedEvidenceOutcomeClass,
  RetainedEvidenceTrigger,
} from 'hrc-core'
import type { HrcDatabase, RetainedEvidenceOutcomeRecord } from 'hrc-store-sqlite'
import { type InvocationEventEnvelope, validateEventEnvelope } from 'spaces-harness-broker-protocol'

import {
  ExecutionReleaseRefusal,
  validateFrozenExecutionRelease,
} from '../agent-spaces-adapter/aspd-execution-release'
import { isExternalLifecycleOwner } from '../external-participant-lifecycle'
import { writeServerLog } from '../server-log'
import type { BrokerHealthState } from '../startup-reconcile/types'
import { persistedAspdExecutionRelease } from './controller/dispatch'
import { BrokerEventMapper } from './event-mapper'
import { acquireRetainedRecoveryOwnership } from './runtime-exclusive-owner'
import { parseBrokerRuntimeHostingState } from './runtime-hosting'

export const OFFLINE_EVIDENCE_SCHEMA = 'harness-broker.offline-evidence/v1'
export const OFFLINE_EVIDENCE_CAPABILITY = OFFLINE_EVIDENCE_SCHEMA
export const RETAINED_EVIDENCE_OUTCOME_SCHEMA = 'hrc.offline-evidence/v1'

export const OFFLINE_EVIDENCE_PAGE_LIMIT = 500
export const OFFLINE_EVIDENCE_PAGE_MAX_BYTES = 4 * 1024 * 1024
export const OFFLINE_EVIDENCE_STDOUT_SLACK_BYTES = 64 * 1024
export const OFFLINE_EVIDENCE_STDERR_MAX_BYTES = 64 * 1024
export const OFFLINE_EVIDENCE_READER_TIMEOUT_MS = 10_000
export const OFFLINE_EVIDENCE_SLICE_MAX_PAGES = 64
export const OFFLINE_EVIDENCE_SLICE_MAX_BYTES = 64 * 1024 * 1024
export const OFFLINE_EVIDENCE_SLICE_MAX_MS = 60_000
/** U3: automatic attempts before the outcome pauses for disposition. */
export const OFFLINE_EVIDENCE_RETRY_BUDGET = 5

const ELIGIBLE_STATUSES = new Set(['terminated', 'failed'])

const INCOMPLETE_OUTCOMES = new Set([
  'recovered_torn_tail',
  'ledger_corrupt',
  'ledger_conflicting_duplicate',
  'replay_below_floor',
  'release_unavailable',
  'reader_release_mismatch',
  'reader_contract_violation',
  'invalid_request',
  'offline_record_too_large',
  'offline_schema_unsupported',
  'offline_reader_unsupported',
  'ledger_index_unavailable',
  'ledger_path_unknown',
  'projection_halted',
])
const RETRYABLE_OUTCOMES = new Set([
  'reader_failed',
  'reader_timeout',
  'ledger_snapshot_unstable',
  'ledger_unavailable',
  'in_progress',
  'offline_read_attach_in_flight',
])
/** Retryable outcomes that do not consume the automatic retry budget. */
const BUDGET_FREE_OUTCOMES = new Set(['in_progress', 'offline_read_attach_in_flight'])

export function classifyRetainedOutcome(outcome: string): RetainedEvidenceOutcomeClass | 'paused' {
  if (outcome === 'recovered') return 'complete'
  if (outcome === 'operator_disposed') return 'disposed'
  if (outcome === 'offline_reader_unsupported_unbound_release') return 'unbound'
  if (outcome === 'paused_needs_disposition') return 'paused'
  if (RETRYABLE_OUTCOMES.has(outcome)) return 'retryable'
  if (INCOMPLETE_OUTCOMES.has(outcome)) return 'incomplete'
  return 'incomplete'
}

/** §4.2: whether an outcome keeps a bound runtime's ledger directory held. */
export function outcomeHoldsEvidence(outcome: string | undefined): boolean {
  if (outcome === undefined) return true
  const outcomeClass = classifyRetainedOutcome(outcome)
  return outcomeClass === 'incomplete' || outcomeClass === 'retryable' || outcomeClass === 'paused'
}

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
}

type Refusal = {
  outcome: string
  reason: string
  recorded: false
}

type AttemptResult = {
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

async function eligibilityRefusal(
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
  if (!ELIGIBLE_STATUSES.has(runtime.status)) {
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
  return undefined
}

// ── reader process ────────────────────────────────────────────────────────────

type ReaderCall =
  | { kind: 'ok'; response: Record<string, unknown>; stdoutBytes: number }
  | { kind: 'typed'; response: Record<string, unknown>; stdoutBytes: number }
  | { kind: 'failed'; outcome: string; detail: Record<string, unknown>; stdoutBytes: number }

function minimalReaderEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** In-flight reader process groups, so server stop can reap them (no orphans). */
const activeReaderGroups = new Set<number>()

function killReaderGroup(pid: number | undefined): void {
  if (pid === undefined) return
  try {
    // The reader leads its own process group; kill the group so helper
    // grandchildren (shell wrappers, interpreters) cannot outlive it.
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
}

/** Kill every in-flight offline reader (graceful server stop). */
export function killActiveOfflineReaders(): number {
  const pids = [...activeReaderGroups]
  for (const pid of pids) killReaderGroup(pid)
  activeReaderGroups.clear()
  return pids.length
}

async function callReader(
  executable: string,
  ledgerPath: string,
  request: Record<string, unknown>,
  maxBytes: number,
  timeoutMs: number
): Promise<ReaderCall> {
  const indexPath = join(dirname(ledgerPath), 'ledger-index.db')
  const stdoutCap = maxBytes + OFFLINE_EVIDENCE_STDOUT_SLACK_BYTES
  return await new Promise<ReaderCall>((resolve) => {
    let settled = false
    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderr = ''
    const child = spawn(
      executable,
      ['evidence-read', '--event-ledger', ledgerPath, '--index', indexPath],
      { env: minimalReaderEnv(), stdio: ['pipe', 'pipe', 'pipe'], detached: true }
    )
    if (child.pid !== undefined) activeReaderGroups.add(child.pid)
    const finish = (result: ReaderCall) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (child.pid !== undefined) activeReaderGroups.delete(child.pid)
      resolve(result)
    }
    const kill = () => killReaderGroup(child.pid)
    const timer = setTimeout(() => {
      kill()
      finish({
        kind: 'failed',
        outcome: 'reader_timeout',
        detail: { timeoutMs, stderr: stderr.slice(0, 2048) },
        stdoutBytes,
      })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > stdoutCap) {
        kill()
        finish({
          kind: 'failed',
          outcome: 'reader_contract_violation',
          detail: { violation: 'stdout_overflow', stdoutCap, stdoutBytes },
          stdoutBytes,
        })
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < OFFLINE_EVIDENCE_STDERR_MAX_BYTES) stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      finish({
        kind: 'failed',
        outcome: 'reader_failed',
        detail: { error: error.message },
        stdoutBytes,
      })
    })
    child.on('close', (code) => {
      if (settled) return
      const text = Buffer.concat(stdout).toString('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (code === 0 || code === 2) {
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          finish({
            kind: 'failed',
            outcome: 'reader_contract_violation',
            detail: { violation: 'unparseable_response', exitCode: code },
            stdoutBytes,
          })
          return
        }
        finish({
          kind: code === 0 ? 'ok' : 'typed',
          response: parsed as Record<string, unknown>,
          stdoutBytes,
        })
        return
      }
      finish({
        kind: 'failed',
        outcome: 'reader_failed',
        detail: { exitCode: code, stderr: stderr.slice(0, 2048) },
        stdoutBytes,
      })
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(JSON.stringify(request))
  })
}

// ── page validation ───────────────────────────────────────────────────────────
//
// Whole-response validation of the owning release's `evidence-read` output for
// `eventsSince` (harness-broker.offline-evidence/v1, as emitted by
// harness-broker `offline-evidence.ts` writeResponse/writeFailure). Both arms are
// validated completely before any mapper call; anything outside the producer's
// wire shape is `reader_contract_violation`, never an outcome it names.

type ReleaseIdentity = { releaseId: string; sourceCommit: string; builtAt: string }

/** Typed error codes the producer emits on the `eventsSince` path. */
const EVENTS_SINCE_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_request',
  'offline_schema_unsupported',
  'ledger_unavailable',
  'ledger_index_unavailable',
  'ledger_corrupt',
  'ledger_conflicting_duplicate',
  'ledger_snapshot_unstable',
  'offline_record_too_large',
  'replay_below_floor',
])

function sameRelease(value: unknown, expected: ReleaseIdentity): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    record['releaseId'] === expected.releaseId &&
    record['sourceCommit'] === expected.sourceCommit &&
    record['builtAt'] === expected.builtAt
  )
}

function isSafeSeq(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Closed member check: every key is known and every required key is present. */
function closedMembers(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): string | undefined {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return `missing:${key}`
  }
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) return `unknown:${key}`
  }
  return undefined
}

function fileIdentityViolation(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'not_object'
  const members = closedMembers(value, ['ino', 'size', 'mtimeMs'])
  if (members !== undefined) return members
  for (const key of ['ino', 'size', 'mtimeMs']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) return `${key}_not_number`
  }
  return undefined
}

function snapshotViolation(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'snapshot:not_object'
  const members = closedMembers(value, ['ledger', 'index'])
  if (members !== undefined) return `snapshot:${members}`
  const ledger = fileIdentityViolation(value['ledger'])
  if (ledger !== undefined) return `snapshot.ledger:${ledger}`
  const index = value['index']
  if (!isPlainRecord(index)) return 'snapshot.index:not_object'
  const indexMembers = closedMembers(index, ['db'], ['wal'])
  if (indexMembers !== undefined) return `snapshot.index:${indexMembers}`
  const db = fileIdentityViolation(index['db'])
  if (db !== undefined) return `snapshot.index.db:${db}`
  if (index['wal'] !== undefined) {
    const wal = fileIdentityViolation(index['wal'])
    if (wal !== undefined) return `snapshot.index.wal:${wal}`
  }
  return undefined
}

function integrityViolation(value: unknown): string | undefined {
  if (!isPlainRecord(value)) return 'integrity:not_object'
  if (value['status'] === 'intact') {
    const members = closedMembers(value, ['status', 'byteLength'])
    if (members !== undefined) return `integrity:${members}`
    if (!isSafeSeq(value['byteLength'])) return 'integrity.byteLength'
    return undefined
  }
  if (value['status'] === 'torn_tail') {
    const members = closedMembers(
      value,
      ['status', 'byteLength', 'lastIntactByteOffset', 'trailingBytes'],
      ['lastIntact']
    )
    if (members !== undefined) return `integrity:${members}`
    for (const key of ['byteLength', 'lastIntactByteOffset', 'trailingBytes']) {
      if (!isSafeSeq(value[key])) return `integrity.${key}`
    }
    const lastIntact = value['lastIntact']
    if (lastIntact !== undefined) {
      if (!isPlainRecord(lastIntact)) return 'integrity.lastIntact:not_object'
      const intactMembers = closedMembers(lastIntact, ['invocationId', 'seq'])
      if (intactMembers !== undefined) return `integrity.lastIntact:${intactMembers}`
      if (typeof lastIntact['invocationId'] !== 'string' || lastIntact['invocationId'] === '') {
        return 'integrity.lastIntact.invocationId'
      }
      if (!isSafeSeq(lastIntact['seq']) || lastIntact['seq'] === 0)
        return 'integrity.lastIntact.seq'
    }
    return undefined
  }
  return 'integrity.status'
}

export type ValidPage = {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq: number
  hasMore: boolean
  nextAfterSeq: number
  snapshot: Record<string, unknown>
  integrity: Record<string, unknown>
}

export type PageVerdict =
  | { ok: true; page: ValidPage }
  | { ok: false; outcome: string; detail: Record<string, unknown> }

function contractViolation(
  why: string,
  extra: Record<string, unknown> = {}
): PageVerdict & {
  ok: false
} {
  return { ok: false, outcome: 'reader_contract_violation', detail: { violation: why, ...extra } }
}

/** Success arm (reader exit 0). */
export function validateOfflineEvidencePage(
  response: Record<string, unknown>,
  expected: ReleaseIdentity,
  invocationId: string,
  afterSeq: number
): PageVerdict {
  const violation = contractViolation
  if (response['schema'] !== OFFLINE_EVIDENCE_SCHEMA) return violation('schema')
  if (!sameRelease(response['release'], expected)) {
    return {
      ok: false,
      outcome: 'reader_release_mismatch',
      detail: { expected, embedded: response['release'] ?? null },
    }
  }
  if (response['ok'] !== true)
    return violation('ok_not_true_on_success_exit', { ok: response['ok'] ?? null })
  if (response['operation'] !== 'eventsSince') {
    return violation('operation', { operation: response['operation'] ?? null })
  }
  const topMembers = closedMembers(response, [
    'schema',
    'ok',
    'operation',
    'release',
    'result',
    'hasMore',
    'nextAfterSeq',
    'snapshot',
    'integrity',
  ])
  if (topMembers !== undefined) return violation('response_members', { members: topMembers })
  const releaseMembers = closedMembers(response['release'] as Record<string, unknown>, [
    'releaseId',
    'sourceCommit',
    'builtAt',
  ])
  if (releaseMembers !== undefined) return violation('release_members', { members: releaseMembers })
  const result = response['result']
  if (!isPlainRecord(result)) return violation('result')
  const resultMembers = closedMembers(
    result,
    ['events', 'currentSeq', 'retentionFloorSeq'],
    ['liveStreamAttached']
  )
  if (resultMembers !== undefined) return violation('result_members', { members: resultMembers })
  if (
    result['liveStreamAttached'] !== undefined &&
    typeof result['liveStreamAttached'] !== 'boolean'
  ) {
    return violation('result.liveStreamAttached')
  }
  const currentSeq = result['currentSeq']
  const retentionFloorSeq = result['retentionFloorSeq']
  const nextAfterSeq = response['nextAfterSeq']
  const hasMore = response['hasMore']
  const events = result['events']
  if (
    !isSafeSeq(currentSeq) ||
    !isSafeSeq(retentionFloorSeq) ||
    !isSafeSeq(nextAfterSeq) ||
    typeof hasMore !== 'boolean'
  ) {
    return violation('page_fields')
  }
  if (!Array.isArray(events)) return violation('events')
  const snapshotProblem = snapshotViolation(response['snapshot'])
  if (snapshotProblem !== undefined) return violation('snapshot', { problem: snapshotProblem })
  const integrityProblem = integrityViolation(response['integrity'])
  if (integrityProblem !== undefined) return violation('integrity', { problem: integrityProblem })
  // Producer: currentSeq = max(last row seq, retentionFloorSeq).
  if (currentSeq < retentionFloorSeq) {
    return violation('current_seq_below_floor', { currentSeq, retentionFloorSeq })
  }
  // Astra EN-13678: HRC's committed prefix is not in the answered ledger. An HRC
  // admission classification, not a producer contract claim.
  if (afterSeq > currentSeq) {
    return {
      ok: false,
      outcome: 'reader_contract_violation',
      detail: {
        violation: 'cursor_above_current_seq',
        requestedAfterSeq: afterSeq,
        currentSeq,
        nextAfterSeq,
      },
    }
  }
  // Producer: a cursor below the floor answers replay_below_floor, never a page.
  if (afterSeq < retentionFloorSeq) {
    return violation('page_below_floor', { afterSeq, retentionFloorSeq })
  }
  const validated: InvocationEventEnvelope[] = []
  let expectedSeq = afterSeq + 1
  for (const raw of events) {
    let envelope: InvocationEventEnvelope
    try {
      envelope = validateEventEnvelope(raw)
    } catch (error) {
      return violation('invalid_envelope', {
        seq: expectedSeq,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (String(envelope.invocationId) !== invocationId) {
      return violation('foreign_invocation', { seq: envelope.seq })
    }
    if (envelope.seq !== expectedSeq) {
      return violation('non_contiguous_seq', { expectedSeq, seq: envelope.seq })
    }
    if (envelope.seq > currentSeq) {
      return violation('event_beyond_current_seq', { seq: envelope.seq, currentSeq })
    }
    validated.push(envelope)
    expectedSeq += 1
  }
  // Producer: hasMore is true only after at least one event was selected and a
  // later candidate remains, so the page advances and stops short of currentSeq.
  if (
    hasMore &&
    (validated.length === 0 || nextAfterSeq <= afterSeq || nextAfterSeq >= currentSeq)
  ) {
    return violation('non_progressing_page', {
      afterSeq,
      nextAfterSeq,
      currentSeq,
      events: validated.length,
    })
  }
  const lastSeq = validated.at(-1)?.seq ?? afterSeq
  if (nextAfterSeq !== lastSeq) {
    return violation('next_after_seq_mismatch', { afterSeq, nextAfterSeq, lastSeq })
  }
  // Producer: with no later candidate the page ends at the last row, and
  // currentSeq = max(last row, floor) with floor <= afterSeq, so the final page
  // cursor equals currentSeq (cursor-above is classified above).
  if (!hasMore && nextAfterSeq !== currentSeq) {
    return violation('final_page_cursor_mismatch', { afterSeq, nextAfterSeq, currentSeq })
  }
  return {
    ok: true,
    page: {
      events: validated,
      currentSeq,
      retentionFloorSeq,
      hasMore,
      nextAfterSeq,
      snapshot: response['snapshot'] as Record<string, unknown>,
      integrity: response['integrity'] as Record<string, unknown>,
    },
  }
}

export type TypedErrorVerdict =
  | { ok: true; code: string; error: Record<string, unknown> }
  | { ok: false; outcome: string; detail: Record<string, unknown> }

/** Typed-error arm (reader exit 2). */
export function validateOfflineEvidenceTypedError(
  response: Record<string, unknown>,
  expected: ReleaseIdentity
): TypedErrorVerdict {
  const violation = contractViolation
  if (response['schema'] !== OFFLINE_EVIDENCE_SCHEMA) return violation('schema')
  if (response['release'] !== undefined && !sameRelease(response['release'], expected)) {
    return {
      ok: false,
      outcome: 'reader_release_mismatch',
      detail: { expected, embedded: response['release'] },
    }
  }
  if (response['ok'] !== false) {
    return violation('ok_not_false_on_typed_exit', { ok: response['ok'] ?? null })
  }
  const members = closedMembers(response, ['schema', 'ok', 'error'], ['operation', 'release'])
  if (members !== undefined) return violation('response_members', { members })
  // HRC only ever requests eventsSince; the producer echoes the request operation.
  if (response['operation'] !== undefined && response['operation'] !== 'eventsSince') {
    return violation('operation', { operation: response['operation'] })
  }
  if (response['release'] !== undefined) {
    const releaseMembers = closedMembers(response['release'] as Record<string, unknown>, [
      'releaseId',
      'sourceCommit',
      'builtAt',
    ])
    if (releaseMembers !== undefined) {
      return violation('release_members', { members: releaseMembers })
    }
  }
  const error = response['error']
  if (!isPlainRecord(error)) return violation('typed_error_without_code')
  const errorMembers = closedMembers(error, ['code', 'message'], ['data'])
  if (errorMembers !== undefined) return violation('error_members', { members: errorMembers })
  if (typeof error['code'] !== 'string') return violation('typed_error_without_code')
  if (!EVENTS_SINCE_ERROR_CODES.has(error['code'])) {
    return violation('typed_error_code_unsupported', { errorCode: error['code'] })
  }
  if (typeof error['message'] !== 'string') return violation('error.message')
  if (error['data'] !== undefined && !isPlainRecord(error['data'])) return violation('error.data')
  return { ok: true, code: error['code'], error }
}

// ── attempt ───────────────────────────────────────────────────────────────────

function releaseCapabilityDeclared(releaseRoot: string): boolean | undefined {
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

async function readAndProject(
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
function recordInvocationHistory(
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

// ── public entry ─────────────────────────────────────────────────────────────

export type RecoverRetainedEvidenceInput = {
  runtimeId: string
  trigger: RetainedEvidenceTrigger
  dryRun?: boolean | undefined
}

function targetInvocationId(db: HrcDatabase, runtime: HrcRuntimeSnapshot): string | undefined {
  const invocations = db.brokerInvocations.listByRuntimeId(runtime.runtimeId)
  if (runtime.activeInvocationId !== undefined) {
    const active = invocations.find((entry) => entry.invocationId === runtime.activeInvocationId)
    if (active) return active.invocationId
  }
  return invocations.at(-1)?.invocationId
}

function responseFor(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  invocationId: string | undefined,
  trigger: RetainedEvidenceTrigger,
  fields: {
    outcome: string
    recorded: boolean
    attempts: number
    spawned: boolean
    projectedThroughSeq: number
    currentSeq?: number | undefined
    detail: Record<string, unknown>
    bound: boolean
    dryRun?: boolean | undefined
    eligibility?: CaptureRecoverResponse['eligibility']
    capability?: CaptureRecoverResponse['capability']
  }
): CaptureRecoverResponse {
  const outcomeClass = classifyRetainedOutcome(fields.outcome)
  return {
    runtimeId: runtime.runtimeId,
    ...(invocationId !== undefined ? { invocationId } : {}),
    trigger,
    ...(fields.dryRun ? { dryRun: true } : {}),
    spawned: fields.spawned,
    outcome: fields.outcome,
    ...(outcomeClass !== 'paused' ? { class: outcomeClass } : { class: 'incomplete' as const }),
    complete: outcomeClass === 'complete',
    // §4.2 (H1 rev 3): `held` is the directory-hold predicate on the runtime row
    // as it stands after the attempt, never the attempt outcome's class.
    held: currentHold(db, runtime.runtimeId),
    attempts: fields.attempts,
    recorded: fields.recorded,
    projectedThroughSeq: fields.projectedThroughSeq,
    ...(fields.currentSeq !== undefined ? { currentSeq: fields.currentSeq } : {}),
    ...(fields.eligibility ? { eligibility: fields.eligibility } : {}),
    ...(fields.capability ? { capability: fields.capability } : {}),
    detail: fields.detail,
  }
}

function recordOutcome(
  deps: OfflineEvidenceDeps,
  runtime: HrcRuntimeSnapshot,
  invocationId: string,
  trigger: RetainedEvidenceTrigger,
  outcome: string,
  attempts: number,
  detail: Record<string, unknown>
): RetainedEvidenceOutcomeRecord {
  const outcomeClass = classifyRetainedOutcome(outcome)
  const record = deps.db.retainedEvidenceOutcomes.append({
    runtimeId: runtime.runtimeId,
    invocationId,
    recordedAt: deps.now(),
    outcome,
    outcomeClass: outcomeClass === 'paused' ? 'retryable' : outcomeClass,
    trigger,
    attempts,
    detail: {
      schema: RETAINED_EVIDENCE_OUTCOME_SCHEMA,
      outcome,
      class: outcomeClass,
      trigger,
      attempts,
      readAt: deps.now(),
      ...detail,
    },
  })
  writeServerLog('INFO', 'retained_evidence.outcome', {
    runtimeId: runtime.runtimeId,
    invocationId,
    outcome,
    class: outcomeClass,
    trigger,
    attempts,
  })
  return record
}

/**
 * One retained-evidence recovery attempt (or dry run) for a runtime's current
 * invocation. Refusals that must not become audit rows (worker live, revivable,
 * not a broker runtime) are returned unrecorded.
 */
export async function recoverRetainedEvidence(
  deps: OfflineEvidenceDeps,
  input: RecoverRetainedEvidenceInput
): Promise<CaptureRecoverResponse | undefined> {
  const db = deps.db
  const runtime = db.runtimes.getByRuntimeId(input.runtimeId)
  if (!runtime) return undefined
  const invocationId = targetInvocationId(db, runtime)
  const bound = persistedAspdExecutionRelease(runtime) !== undefined
  const prior = invocationId
    ? db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocationId)
    : null
  const priorAttempts = prior?.attempts ?? 0
  const projectedNow = invocationId
    ? (db.brokerInvocations.getByInvocationId(invocationId)?.lastProjectedSeq ?? 0)
    : 0

  if (invocationId === undefined) {
    return responseFor(db, runtime, undefined, input.trigger, {
      outcome: 'offline_read_no_invocation',
      recorded: false,
      attempts: 0,
      spawned: false,
      projectedThroughSeq: 0,
      detail: {},
      bound,
    })
  }

  if (input.dryRun) {
    const refusal = await eligibilityRefusal(deps, runtime, invocationId)
    const release = persistedAspdExecutionRelease(runtime)
    const declared = release ? releaseCapabilityDeclared(release.releaseRoot) : undefined
    return responseFor(db, runtime, invocationId, input.trigger, {
      outcome: prior?.outcome ?? 'not_attempted',
      recorded: false,
      attempts: priorAttempts,
      spawned: false,
      projectedThroughSeq: projectedNow,
      detail: prior?.detail ?? {},
      bound,
      dryRun: true,
      eligibility: refusal ? { eligible: false, reason: refusal.outcome } : { eligible: true },
      capability: {
        declared: declared === true,
        ...(release ? { releaseId: release.releaseId } : {}),
      },
    })
  }

  const ownership = acquireRetainedRecoveryOwnership(deps.ownerMap, runtime.runtimeId)
  if (!ownership.acquired) {
    const outcome = 'offline_read_attach_in_flight'
    if (ownership.heldBy === 'attach') {
      recordOutcome(deps, runtime, invocationId, input.trigger, outcome, priorAttempts, {
        heldBy: 'attach',
        requestedAfterSeq: projectedNow,
      })
    }
    return responseFor(db, runtime, invocationId, input.trigger, {
      outcome,
      recorded: ownership.heldBy === 'attach',
      attempts: priorAttempts,
      spawned: false,
      projectedThroughSeq: projectedNow,
      detail: { heldBy: ownership.heldBy },
      bound,
    })
  }

  try {
    // Re-read inside ownership: eligibility is never judged on a stale row.
    const owned = db.runtimes.getByRuntimeId(runtime.runtimeId) ?? runtime
    const refusal = await eligibilityRefusal(deps, owned, invocationId)
    if (refusal) {
      writeServerLog('INFO', 'retained_evidence.refused', {
        runtimeId: owned.runtimeId,
        invocationId,
        outcome: refusal.outcome,
        reason: refusal.reason,
        trigger: input.trigger,
      })
      return responseFor(db, owned, invocationId, input.trigger, {
        outcome: refusal.outcome,
        recorded: false,
        attempts: priorAttempts,
        spawned: false,
        projectedThroughSeq: projectedNow,
        detail: { reason: refusal.reason },
        bound,
      })
    }

    const budget = deps.options?.retryBudget ?? OFFLINE_EVIDENCE_RETRY_BUDGET
    if (input.trigger !== 'operator' && prior !== null) {
      const priorClass = classifyRetainedOutcome(prior.outcome)
      if (priorClass === 'complete' || priorClass === 'disposed' || priorClass === 'paused') {
        return responseFor(db, owned, invocationId, input.trigger, {
          outcome: prior.outcome,
          recorded: false,
          attempts: priorAttempts,
          spawned: false,
          projectedThroughSeq: projectedNow,
          detail: prior.detail,
          bound,
        })
      }
      if (priorClass === 'retryable' && priorAttempts >= budget) {
        const paused = recordOutcome(
          deps,
          owned,
          invocationId,
          input.trigger,
          'paused_needs_disposition',
          priorAttempts,
          { priorOutcome: prior.outcome, requestedAfterSeq: projectedNow }
        )
        return responseFor(db, owned, invocationId, input.trigger, {
          outcome: paused.outcome,
          recorded: true,
          attempts: priorAttempts,
          spawned: false,
          projectedThroughSeq: projectedNow,
          detail: paused.detail,
          bound,
        })
      }
    }

    const attempt = await readAndProject(deps, owned, invocationId, prior)
    const attempts = BUDGET_FREE_OUTCOMES.has(attempt.outcome) ? priorAttempts : priorAttempts + 1
    recordOutcome(deps, owned, invocationId, input.trigger, attempt.outcome, attempts, {
      ...attempt.detail,
      projectedThroughSeq: attempt.projectedThroughSeq,
      ...(attempt.currentSeq !== undefined ? { currentSeq: attempt.currentSeq } : {}),
    })
    return responseFor(db, owned, invocationId, input.trigger, {
      outcome: attempt.outcome,
      recorded: true,
      attempts,
      spawned: attempt.spawned,
      projectedThroughSeq: attempt.projectedThroughSeq,
      ...(attempt.currentSeq !== undefined ? { currentSeq: attempt.currentSeq } : {}),
      detail: attempt.detail,
      bound,
    })
  } finally {
    ownership.release()
  }
}

// ── retention hold (SPEC §4.2) ───────────────────────────────────────────────

const REVIVABLE_STATUSES = new Set(['crashed', 'dead', 'stale', 'detached'])

export type RetainedEvidenceHold = {
  held: boolean
  /** Why: `revivable` status, or the latest outcome (`not_attempted` when none). */
  reason?: string | undefined
  ledgerPath?: string | undefined
}

/**
 * Whether a bound harness-broker runtime's ledger directory is held. The hold
 * ends only on `recovered` or `operator_disposed`; a retry budget never releases
 * evidence. Unbound runtimes get no new hold (U16).
 */
function currentHold(db: HrcDatabase, runtimeId: string): boolean {
  const current = db.runtimes.getByRuntimeId(runtimeId)
  return current ? retainedEvidenceHold(db, current).held : false
}

export function retainedEvidenceHold(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot
): RetainedEvidenceHold {
  if (runtime.controllerKind !== 'harness-broker') return { held: false }
  if (persistedAspdExecutionRelease(runtime) === undefined) return { held: false }
  const ledgerPath = persistedEventLedgerPath(runtime)
  if (ledgerPath === undefined) return { held: false }
  if (REVIVABLE_STATUSES.has(runtime.status)) {
    return { held: true, reason: 'revivable', ledgerPath }
  }
  // §4.2 (H1 rev 3): the outcome clause applies in every status. A live, adopted
  // or stopped runtime stays held until each invocation is recovered or disposed;
  // the hold never gates live replay (the retained-projection fence does).
  for (const invocation of db.brokerInvocations.listByRuntimeId(runtime.runtimeId)) {
    const latest = db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocation.invocationId)
    if (latest === null) return { held: true, reason: 'not_attempted', ledgerPath }
    if (outcomeHoldsEvidence(latest.outcome))
      return { held: true, reason: latest.outcome, ledgerPath }
  }
  return { held: false, ledgerPath }
}

/**
 * Before the sweep may remove an unbound terminal runtime's ledger directory,
 * record why its evidence is unrecoverable by design (U16, D3/D7 ordering).
 * Returns the recorded (or already present) outcome, or undefined when the
 * runtime is not an unbound terminal harness-broker runtime.
 */
export function recordUnboundBeforeSweep(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  now: string
): string | undefined {
  if (runtime.controllerKind !== 'harness-broker') return undefined
  if (!ELIGIBLE_STATUSES.has(runtime.status)) return undefined
  if (persistedAspdExecutionRelease(runtime) !== undefined) return undefined
  const outcome = 'offline_reader_unsupported_unbound_release'
  for (const invocation of db.brokerInvocations.listByRuntimeId(runtime.runtimeId)) {
    if (db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocation.invocationId) !== null) {
      continue
    }
    db.retainedEvidenceOutcomes.append({
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      recordedAt: now,
      outcome,
      outcomeClass: 'unbound',
      trigger: 'startup',
      attempts: 0,
      detail: {
        schema: RETAINED_EVIDENCE_OUTCOME_SCHEMA,
        outcome,
        class: 'unbound',
        trigger: 'startup',
      },
    })
    writeServerLog('INFO', 'retained_evidence.outcome', {
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      outcome,
      class: 'unbound',
      trigger: 'startup',
      attempts: 0,
    })
  }
  return outcome
}

/**
 * Operator disposition (SPEC §4.2): append `operator_disposed` for every held
 * invocation. The caller then applies the ordinary prune in the same transaction.
 */
export function recordOperatorDisposition(
  db: HrcDatabase,
  runtime: HrcRuntimeSnapshot,
  input: { by: string; reason: string; at: string }
): number {
  let recorded = 0
  for (const invocation of db.brokerInvocations.listByRuntimeId(runtime.runtimeId)) {
    const latest = db.retainedEvidenceOutcomes.latest(runtime.runtimeId, invocation.invocationId)
    if (latest !== null && !outcomeHoldsEvidence(latest.outcome)) continue
    const outcome = 'operator_disposed'
    db.retainedEvidenceOutcomes.append({
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      recordedAt: input.at,
      outcome,
      outcomeClass: 'disposed',
      trigger: 'operator',
      attempts: latest?.attempts ?? 0,
      detail: {
        schema: RETAINED_EVIDENCE_OUTCOME_SCHEMA,
        outcome,
        class: 'disposed',
        trigger: 'operator',
        disposition: {
          by: input.by,
          reason: input.reason,
          at: input.at,
          priorOutcome: latest?.outcome ?? 'not_attempted',
        },
      },
    })
    writeServerLog('INFO', 'retained_evidence.outcome', {
      runtimeId: runtime.runtimeId,
      invocationId: invocation.invocationId,
      outcome,
      class: 'disposed',
      trigger: 'operator',
      priorOutcome: latest?.outcome ?? 'not_attempted',
    })
    recorded += 1
  }
  return recorded
}

// ── automatic triggers (SPEC §3.4.3) ────────────────────────────────────────

export const RETAINED_EVIDENCE_PASS_LIMIT = 20
export const RETAINED_EVIDENCE_TERMINAL_DELAY_MS = 1_000

/** Bound terminal runtimes whose evidence is not yet attempted or retryable. */
export function retainedEvidencePassCandidates(
  db: HrcDatabase,
  limit: number
): { runtimeIds: string[]; eligible: number; unboundTerminal: number } {
  const runtimeIds: string[] = []
  let eligible = 0
  let unboundTerminal = 0
  for (const runtime of db.runtimes.listAll()) {
    if (runtime.controllerKind !== 'harness-broker' || !ELIGIBLE_STATUSES.has(runtime.status)) {
      continue
    }
    if (persistedAspdExecutionRelease(runtime) === undefined) {
      unboundTerminal += 1
      continue
    }
    const hold = retainedEvidenceHold(db, runtime)
    if (!hold.held || hold.ledgerPath === undefined) continue
    const retryable =
      hold.reason === 'not_attempted' ||
      (hold.reason !== undefined && classifyRetainedOutcome(hold.reason) === 'retryable')
    if (!retryable || !existsSync(dirname(hold.ledgerPath))) continue
    eligible += 1
    if (runtimeIds.length < limit) runtimeIds.push(runtime.runtimeId)
  }
  return { runtimeIds, eligible, unboundTerminal }
}
