import { afterEach } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type {
  CaptureObservationType,
  CaptureVerificationStore,
  ParsedProviderTranscript,
} from '../index.js'
import { CAPTURE_VERIFIER_SCHEMA, lifecycleKey } from '../index.js'

export const SCOPE_REF = 'agent:cody:project:hrc-runtime:task:T-04861'
export const HOST_SESSION_ID = 'hsid_verify'
export const RUNTIME_ID = 'rt_verify'
export const OPERATION_ID = 'op_verify'
export const INVOCATION_ID = 'inv_verify'
export const RUN_ID = 'run_verify'

export type Fixture = Awaited<ReturnType<typeof makeFixture>>

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    await rm(fixture.dir, { recursive: true, force: true })
  }
})

export async function makeFixture(): Promise<{
  dir: string
  dbPath: string
  db: ReturnType<typeof openHrcDatabase>
}> {
  const dir = await mkdtemp(join(tmpdir(), 'hrc-capture-verifier-'))
  const dbPath = join(dir, 'state.sqlite')
  const db = openHrcDatabase(dbPath)
  fixtures.push({ dir, dbPath, db })
  const now = ts()

  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'busy',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    activeOperationId: OPERATION_ID,
    createdAt: now,
    updatedAt: now,
  })
  db.runs.insert({
    runId: RUN_ID,
    hostSessionId: HOST_SESSION_ID,
    runtimeId: RUNTIME_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    status: 'started',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
    operationId: OPERATION_ID,
    invocationId: INVOCATION_ID,
  })
  db.brokerInvocations.insert({
    invocationId: INVOCATION_ID,
    operationId: OPERATION_ID,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'codex-app-server',
    invocationState: 'turn_active',
    capabilitiesJson: '{}',
    specHash: 'sha256:spec',
    startRequestHash: 'sha256:req',
    selectedProfileHash: 'sha256:profile',
    currentHarnessGeneration: 1,
    currentTurnAttempt: 1,
    createdAt: now,
    updatedAt: now,
  })
  return { dir, dbPath, db }
}

export function seedBrokerEvent(
  fixture: Fixture,
  seq: number,
  type: string,
  payload: unknown,
  options: {
    projectionStatus?: 'pending' | 'applied' | 'failed'
    mirrorPayload?: unknown
    skipMirror?: boolean
  } = {}
): void {
  let hrcEventSeq: number | undefined
  if (!options.skipMirror) {
    const mirror = fixture.db.events.append({
      ts: ts(seq),
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE_REF,
      laneRef: 'main',
      generation: 1,
      runId: RUN_ID,
      runtimeId: RUNTIME_ID,
      source: 'broker',
      eventKind: `broker.${type}`,
      eventJson: {
        invocationId: INVOCATION_ID,
        seq,
        type,
        time: ts(seq),
        payload: options.mirrorPayload ?? payload,
      },
    })
    hrcEventSeq = mirror.seq
  }
  fixture.db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    harnessGeneration: 1,
    turnAttempt: 1,
    payload,
    ...(hrcEventSeq !== undefined ? { hrcEventSeq } : {}),
    projectionStatus: options.projectionStatus ?? 'applied',
  })
}

export function seedLifecycle(fixture: Fixture, eventKind: string, payload: unknown): void {
  fixture.db.hrcEvents.append({
    ts: ts(20),
    hostSessionId: HOST_SESSION_ID,
    scopeRef: SCOPE_REF,
    laneRef: 'main',
    generation: 1,
    runtimeId: RUNTIME_ID,
    runId: RUN_ID,
    category: 'turn',
    eventKind,
    transport: 'headless',
    payload,
  })
}

export function fakeStore(events: ReturnType<typeof brokerEvent>[]): CaptureVerificationStore {
  return {
    async listVerificationCandidates() {
      return []
    },
    async loadInvocationCapture() {
      const rawMirrors: Record<number, ReturnType<typeof rawMirror> | undefined> = {}
      const lifecycleProjections: Record<
        string,
        Array<{ hrcSeq: number; eventKind: string; payload: unknown }>
      > = {}
      for (const event of events) {
        if (event.hrcEventSeq !== undefined && !event.__omitRawMirror) {
          rawMirrors[event.hrcEventSeq] = rawMirror(event)
        }
        const lifecycleKind =
          event.type === 'user.message'
            ? 'turn.user_prompt'
            : event.type === 'turn.completed'
              ? 'turn.completed'
              : undefined
        if (lifecycleKind !== undefined) {
          lifecycleProjections[lifecycleKey(event, lifecycleKind)] = [
            { hrcSeq: 100 + event.seq, eventKind: lifecycleKind, payload: {} },
          ]
        }
      }
      return {
        schema: CAPTURE_VERIFIER_SCHEMA,
        invocation: {
          invocationId: INVOCATION_ID,
          operationId: OPERATION_ID,
          runtimeId: RUNTIME_ID,
          runId: RUN_ID,
          brokerDriver: 'codex-app-server',
          brokerProtocol: 'harness-broker/0.2',
          state: 'turn_active',
          currentHarnessGeneration: 1,
          currentTurnAttempt: 1,
          createdAt: ts(),
          updatedAt: ts(),
        },
        brokerEvents: events,
        rawMirrors,
        lifecycleProjections,
      }
    },
  }
}

export function brokerEvent(
  seq: number,
  type: string,
  payload: unknown,
  options: {
    projectionStatus?: string
    mirrorPayload?: unknown
    skipMirror?: boolean
    omitRawMirror?: boolean
    rawSource?: string
    rawEventKind?: string
    rawInvocationId?: string
    rawBrokerSeq?: number
    rawBrokerType?: string
    rawEventJson?: unknown
    rawPayloadMissing?: boolean
    runtimeId?: string
    runId?: string
    harnessGeneration?: number
    turnAttempt?: number
  } = {}
) {
  return {
    invocationId: INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    runId: options.runId ?? RUN_ID,
    runtimeId: options.runtimeId ?? RUNTIME_ID,
    harnessGeneration: options.harnessGeneration ?? 1,
    turnAttempt: options.turnAttempt ?? 1,
    payload,
    payloadJsonText: JSON.stringify(payload),
    ...(options.skipMirror ? {} : { hrcEventSeq: seq + 10 }),
    projectionStatus: options.projectionStatus ?? 'applied',
    createdAt: ts(seq),
    __mirrorPayload: options.mirrorPayload,
    __omitRawMirror: options.omitRawMirror,
    __rawSource: options.rawSource,
    __rawEventKind: options.rawEventKind,
    __rawInvocationId: options.rawInvocationId,
    __rawBrokerSeq: options.rawBrokerSeq,
    __rawBrokerType: options.rawBrokerType,
    __rawEventJson: options.rawEventJson,
    __rawPayloadMissing: options.rawPayloadMissing,
  }
}

export function rawMirror(event: ReturnType<typeof brokerEvent>) {
  if (event.__rawEventJson !== undefined) {
    return {
      seq: event.hrcEventSeq ?? 0,
      source: event.__rawSource ?? 'broker',
      eventKind: event.__rawEventKind ?? `broker.${event.type}`,
      eventJson: event.__rawEventJson,
      eventJsonText: '{}',
    }
  }
  const eventJson: Record<string, unknown> = {
    invocationId: event.__rawInvocationId ?? event.invocationId,
    seq: event.__rawBrokerSeq ?? event.seq,
    type: event.__rawBrokerType ?? event.type,
    time: event.time,
  }
  if (!event.__rawPayloadMissing) {
    eventJson['payload'] = event.__mirrorPayload ?? event.payload
  }
  return {
    seq: event.hrcEventSeq ?? 0,
    source: event.__rawSource ?? 'broker',
    eventKind: event.__rawEventKind ?? `broker.${event.type}`,
    eventJson,
    eventJsonText: '{}',
  }
}

export function transcriptFixture(
  observations: ParsedProviderTranscript['observations']
): ParsedProviderTranscript {
  return {
    schema: CAPTURE_VERIFIER_SCHEMA,
    path: 'fixture.jsonl',
    provider: 'codex',
    warnings: [],
    lineCount: observations.length,
    totalLines: observations.length,
    parsedRecords: observations.length,
    invalidJsonRecords: 0,
    applicableObservations: observations.length,
    ignoredRecords: 0,
    unsupportedRecords: 0,
    unknownRecords: 0,
    warningCount: 0,
    observationsByType: observationCounts(observations),
    observations,
  }
}

export function observationCounts(
  observations: ParsedProviderTranscript['observations']
): Record<CaptureObservationType, number> {
  const counts: Record<CaptureObservationType, number> = {
    'user.message': 0,
    'assistant.message.completed': 0,
    'tool.call.started': 0,
    'tool.call.completed': 0,
    'tool.call.failed': 0,
  }
  for (const observation of observations) {
    counts[observation.type] += 1
  }
  return counts
}

export async function writeCodexTranscript(
  dir: string,
  filename: string,
  messages: string[]
): Promise<string> {
  const lines = messages.map((text) =>
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text }],
      },
    })
  )
  const path = join(dir, filename)
  await writeFile(path, lines.join('\n'))
  return path
}

export function sha256FileBytes(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

export function ts(offsetSeconds = 0): string {
  return new Date(Date.UTC(2026, 5, 16, 12, 0, offsetSeconds)).toISOString()
}
