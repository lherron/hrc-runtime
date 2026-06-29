import { Database } from 'bun:sqlite'

import {
  HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND,
  lifecycleKindForBrokerEvent,
  resolveDatabasePath,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { safeJsonParse } from './json.js'
import {
  type BrokerCaptureEvent,
  type BrokerInvocationCapture,
  CAPTURE_VERIFIER_SCHEMA,
  type CaptureProvider,
  type CaptureVerificationStore,
  type HrcLifecycleProjection,
  type InvocationCaptureSnapshot,
  type ListVerificationCandidatesInput,
  type ProviderTranscriptArtifact,
  type RawMirrorEvent,
  type VerificationCandidate,
} from './types.js'
import { lifecycleKey } from './verifier.js'

type CandidateRow = {
  invocation_id: string
  scope_ref: string
  lane_ref: string
  runtime_id: string
  run_id: string | null
  host_session_id: string
  generation: number
  runtime_provider: string | null
  broker_driver: string
  broker_protocol: string
  invocation_state: string
  created_at: string
  updated_at: string
  event_count: number
  first_seq: number | null
  last_seq: number | null
  first_event_at: string | null
  last_event_at: string | null
  raw_mirror_count: number
  lifecycle_projection_count: number
}

type InvocationRow = {
  invocation_id: string
  operation_id: string
  runtime_id: string
  run_id: string | null
  broker_driver: string
  broker_protocol: string
  invocation_state: string
  current_harness_generation: number | null
  current_turn_attempt: number | null
  created_at: string
  updated_at: string
}

type EventRow = {
  invocation_id: string
  seq: number
  time: string
  type: string
  run_id: string | null
  runtime_id: string
  harness_generation: number | null
  turn_attempt: number | null
  broker_event_json: string
  hrc_event_seq: number | null
  projection_status: string
  projection_error: string | null
  created_at: string
}

type RawRow = {
  seq: number
  source: string
  event_kind: string
  event_json: string
}

type LifecycleRow = {
  hrc_seq: number
  event_kind: string
  payload_json: string
}

type ArtifactRow = {
  artifact_id: string
  operation_id: string
  content_hash: string
  artifact_json: string | null
  artifact_path: string | null
  created_at: string
}

export function createSqliteCaptureVerificationStore(db: HrcDatabase): CaptureVerificationStore {
  return createStoreFromDatabase(db.sqlite)
}

export function openSqliteCaptureVerificationStore(dbPath = resolveDatabasePath()): {
  store: CaptureVerificationStore
  close(): void
} {
  const db = new Database(dbPath, { readonly: true, create: false })
  return {
    store: createStoreFromDatabase(db),
    close() {
      db.close()
    },
  }
}

function createStoreFromDatabase(db: Database): CaptureVerificationStore {
  return {
    async listVerificationCandidates(input) {
      return listCandidates(db, input)
    },
    async loadInvocationCapture(input) {
      return loadSnapshot(db, input.invocationId)
    },
  }
}

function listCandidates(
  db: Database,
  input: ListVerificationCandidatesInput
): VerificationCandidate[] {
  const where = ['r.scope_ref = ?']
  const args: Array<string | number> = [input.scopeRef]
  if (input.since !== undefined) {
    where.push('bi.updated_at >= ?')
    args.push(input.since)
  }
  if (input.until !== undefined) {
    where.push('bi.updated_at <= ?')
    args.push(input.until)
  }
  const limit = input.limit ?? 50
  args.push(limit)

  const rows = db
    .query<CandidateRow, Array<string | number>>(
      `
        SELECT
          bi.invocation_id,
          r.scope_ref,
          r.lane_ref,
          bi.runtime_id,
          bi.run_id,
          r.host_session_id,
          r.generation,
          r.provider AS runtime_provider,
          bi.broker_driver,
          bi.broker_protocol,
          bi.invocation_state,
          bi.created_at,
          bi.updated_at,
          COUNT(bie.seq) AS event_count,
          MIN(bie.seq) AS first_seq,
          MAX(bie.seq) AS last_seq,
          MIN(bie.time) AS first_event_at,
          MAX(bie.time) AS last_event_at,
          COUNT(raw.seq) AS raw_mirror_count,
          (
            SELECT COUNT(*)
            FROM hrc_events he
            WHERE he.runtime_id = bi.runtime_id
              AND (bi.run_id IS NULL OR he.run_id = bi.run_id)
              AND he.generation = r.generation
          ) AS lifecycle_projection_count
        FROM broker_invocations bi
        JOIN runtimes r ON r.runtime_id = bi.runtime_id
        LEFT JOIN broker_invocation_events bie ON bie.invocation_id = bi.invocation_id
        LEFT JOIN events raw ON raw.seq = bie.hrc_event_seq AND raw.source = 'broker'
        WHERE ${where.join(' AND ')}
        GROUP BY bi.invocation_id
        ORDER BY bi.updated_at DESC, bi.created_at DESC
        LIMIT ?
      `
    )
    .all(...args)

  return rows.map((row) => ({
    schema: CAPTURE_VERIFIER_SCHEMA,
    invocationId: row.invocation_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    runtimeId: row.runtime_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    hostSessionId: row.host_session_id,
    generation: row.generation,
    provider: providerFromRow(row.runtime_provider, row.broker_driver),
    driver: row.broker_driver,
    brokerDriver: row.broker_driver,
    brokerProtocol: row.broker_protocol,
    state: row.invocation_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    eventCount: row.event_count,
    ...(row.first_seq !== null ? { firstSeq: row.first_seq } : {}),
    ...(row.last_seq !== null ? { lastSeq: row.last_seq } : {}),
    ...(row.first_event_at !== null ? { firstEventAt: row.first_event_at } : {}),
    ...(row.last_event_at !== null ? { lastEventAt: row.last_event_at } : {}),
    rawMirrorCount: row.raw_mirror_count,
    lifecycleProjectionCount: row.lifecycle_projection_count,
  }))
}

function loadSnapshot(db: Database, invocationId: string): InvocationCaptureSnapshot | undefined {
  const invocation = loadInvocation(db, invocationId)
  if (invocation === undefined) return undefined
  const brokerEvents = listBrokerEvents(db, invocationId)
  const rawMirrors: Record<number, RawMirrorEvent | undefined> = {}
  const lifecycleProjections: Record<string, HrcLifecycleProjection[]> = {}
  const transcriptArtifact = loadProviderTranscriptArtifact(db, invocation.operationId)

  for (const event of brokerEvents) {
    if (event.hrcEventSeq !== undefined) {
      rawMirrors[event.hrcEventSeq] = getRawMirror(db, event.hrcEventSeq)
    }
    const lifecycleKind = lifecycleKindForBrokerEvent(event.type)
    if (lifecycleKind !== undefined) {
      lifecycleProjections[lifecycleKey(event, lifecycleKind)] = findLifecycle(db, {
        runtimeId: event.runtimeId,
        runId: event.runId,
        generation: event.harnessGeneration,
        eventKind: lifecycleKind,
      })
    }
  }

  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    invocation,
    brokerEvents,
    rawMirrors,
    lifecycleProjections,
    ...(transcriptArtifact !== undefined ? { transcriptArtifact } : {}),
  }
}

function loadProviderTranscriptArtifact(
  db: Database,
  operationId: string
): ProviderTranscriptArtifact | undefined {
  const row = db
    .query<ArtifactRow, [string, string]>(
      `
        SELECT artifact_id, operation_id, content_hash, artifact_json, artifact_path, created_at
        FROM runtime_artifacts
        WHERE operation_id = ?
          AND artifact_kind = ?
          AND storage_kind = 'file-path'
          AND artifact_path IS NOT NULL
        ORDER BY created_at DESC, artifact_id DESC
        LIMIT 1
      `
    )
    .get(operationId, HRC_PROVIDER_TRANSCRIPT_ARTIFACT_KIND)
  if (!row || row.artifact_path === null) return undefined
  return {
    artifactId: row.artifact_id,
    operationId: row.operation_id,
    path: row.artifact_path,
    storedHash: row.content_hash,
    hashStatus: 'unchecked',
    createdAt: row.created_at,
    ...(row.artifact_json !== null ? { artifactJson: row.artifact_json } : {}),
  }
}

function loadInvocation(db: Database, invocationId: string): BrokerInvocationCapture | undefined {
  const row = db
    .query<InvocationRow, [string]>(
      `
        SELECT
          invocation_id,
          operation_id,
          runtime_id,
          run_id,
          broker_driver,
          broker_protocol,
          invocation_state,
          current_harness_generation,
          current_turn_attempt,
          created_at,
          updated_at
        FROM broker_invocations
        WHERE invocation_id = ?
      `
    )
    .get(invocationId)
  if (!row) return undefined
  return {
    invocationId: row.invocation_id,
    operationId: row.operation_id,
    runtimeId: row.runtime_id,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    brokerDriver: row.broker_driver,
    brokerProtocol: row.broker_protocol,
    state: row.invocation_state,
    ...(row.current_harness_generation !== null
      ? { currentHarnessGeneration: row.current_harness_generation }
      : {}),
    ...(row.current_turn_attempt !== null ? { currentTurnAttempt: row.current_turn_attempt } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function listBrokerEvents(db: Database, invocationId: string): BrokerCaptureEvent[] {
  const rows = db
    .query<EventRow, [string]>(
      `
        SELECT
          invocation_id,
          seq,
          time,
          type,
          run_id,
          runtime_id,
          harness_generation,
          turn_attempt,
          broker_event_json,
          hrc_event_seq,
          projection_status,
          projection_error,
          created_at
        FROM broker_invocation_events
        WHERE invocation_id = ?
        ORDER BY seq ASC
      `
    )
    .all(invocationId)
  return rows.map((row) => ({
    invocationId: row.invocation_id,
    seq: row.seq,
    time: row.time,
    type: row.type,
    ...(row.run_id !== null ? { runId: row.run_id } : {}),
    runtimeId: row.runtime_id,
    ...(row.harness_generation !== null ? { harnessGeneration: row.harness_generation } : {}),
    ...(row.turn_attempt !== null ? { turnAttempt: row.turn_attempt } : {}),
    payload: safeJsonParse(row.broker_event_json),
    payloadJsonText: row.broker_event_json,
    ...(row.hrc_event_seq !== null ? { hrcEventSeq: row.hrc_event_seq } : {}),
    projectionStatus: row.projection_status,
    ...(row.projection_error !== null ? { projectionError: row.projection_error } : {}),
    createdAt: row.created_at,
  }))
}

function getRawMirror(db: Database, seq: number): RawMirrorEvent | undefined {
  const row = db
    .query<RawRow, [number]>('SELECT seq, source, event_kind, event_json FROM events WHERE seq = ?')
    .get(seq)
  if (!row) return undefined
  return {
    seq: row.seq,
    source: row.source,
    eventKind: row.event_kind,
    eventJson: safeJsonParse(row.event_json),
    eventJsonText: row.event_json,
  }
}

function findLifecycle(
  db: Database,
  input: {
    runtimeId: string
    runId?: string | undefined
    generation?: number | undefined
    eventKind: string
  }
): HrcLifecycleProjection[] {
  const predicates = ['runtime_id = ?', 'event_kind = ?']
  const args: Array<string | number> = [input.runtimeId, input.eventKind]
  if (input.runId !== undefined) {
    predicates.push('run_id = ?')
    args.push(input.runId)
  }
  if (input.generation !== undefined) {
    predicates.push('generation = ?')
    args.push(input.generation)
  }
  const rows = db
    .query<LifecycleRow, Array<string | number>>(
      `
        SELECT hrc_seq, event_kind, payload_json
        FROM hrc_events
        WHERE ${predicates.join(' AND ')}
        ORDER BY hrc_seq ASC
      `
    )
    .all(...args)
  return rows.map((row) => ({
    hrcSeq: row.hrc_seq,
    eventKind: row.event_kind,
    payload: safeJsonParse(row.payload_json),
  }))
}

function providerFromRow(provider: string | null, brokerDriver: string): CaptureProvider {
  if (provider === 'openai' || brokerDriver.includes('codex')) return 'codex'
  if (provider === 'anthropic' || brokerDriver.includes('claude')) return 'claude-code'
  return 'unknown'
}
