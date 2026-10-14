import type { HrcLifecycleEvent, HrcReportedModelIdentity } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'

import { appendHrcEvent } from '../../hrc-event-helper'
import { isReportedModelIdentity } from '../../reported-model'
import { type ProjectionContext, isRecord } from './helpers'

export const CONTEXT_READING_STATE_KEY = 'contextReading'

type RuntimeContextReading = {
  turnId: string
  usedTokens: number
  windowTokens?: number | undefined
  model?: HrcReportedModelIdentity | undefined
  observedAt: string
}

/**
 * Derive the completed-turn reading solely from the durable usage ledger.
 * Callers supply only current, live projection context; retained and stale
 * evidence never reaches this writer.
 */
export function projectCompletedTurnContextReading(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext,
  now: string
): HrcLifecycleEvent | undefined {
  if (envelope.type !== 'turn.completed') return undefined
  const turnId = terminalTurnId(envelope)
  if (turnId === undefined) return undefined

  const sample = db.brokerInvocationEvents.findLatestUsageWithContextBefore(
    String(envelope.invocationId),
    envelope.seq
  )
  if (sample === null) return undefined
  const reading = parseReading(sample.brokerEventJson, turnId, sample.time ?? now)
  if (reading === undefined) return undefined

  const runtime = db.runtimes.getByRuntimeId(ctx.runtimeId)
  if (runtime === null || runtime.generation !== ctx.generation) return undefined

  return persistContextReading(db, reading, ctx, now)
}

/**
 * Claude's statusline can publish its final reading just after the terminal
 * envelope. Project that reading from its own durable envelope, but only when
 * the invocation is between turns; a reading during the next turn remains
 * durable evidence for that turn's terminal projection.
 */
export function projectPostTurnContextReading(
  db: HrcDatabase,
  envelope: InvocationEventEnvelope,
  ctx: ProjectionContext,
  now: string
): HrcLifecycleEvent | undefined {
  if (envelope.type !== 'usage.updated') return undefined

  const invocation = db.brokerInvocations.getByInvocationId(envelope.invocationId)
  if (invocation === null || invocationHasActiveTurn(invocation.invocationState)) return undefined

  const turnId =
    typeof envelope.turnId === 'string'
      ? envelope.turnId
      : lastCompletedTurnId(db, String(envelope.invocationId), envelope.seq)
  if (turnId === undefined) return undefined

  const reading = parseReading(
    JSON.stringify(envelope.payload ?? null),
    turnId,
    envelope.time ?? now
  )
  if (reading === undefined) return undefined

  const runtime = db.runtimes.getByRuntimeId(ctx.runtimeId)
  if (runtime === null || runtime.generation !== ctx.generation) return undefined

  return persistContextReading(db, reading, ctx, now)
}

function persistContextReading(
  db: HrcDatabase,
  reading: RuntimeContextReading,
  ctx: ProjectionContext,
  now: string
): HrcLifecycleEvent {
  const runtime = db.runtimes.getByRuntimeId(ctx.runtimeId)
  if (runtime === null) {
    throw new Error(`runtime disappeared while persisting context reading: ${ctx.runtimeId}`)
  }

  db.runtimes.update(ctx.runtimeId, {
    runtimeStateJson: {
      ...(runtime.runtimeStateJson ?? {}),
      [CONTEXT_READING_STATE_KEY]: reading,
    },
    updatedAt: now,
  })

  return appendHrcEvent(db, 'runtime.context.updated', {
    ts: now,
    hostSessionId: ctx.hostSessionId,
    scopeRef: ctx.scopeRef,
    laneRef: ctx.laneRef,
    generation: ctx.generation,
    runtimeId: ctx.runtimeId,
    ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
    transport: ctx.transport,
    payload: {
      turnId: reading.turnId,
      usedTokens: reading.usedTokens,
      ...(reading.windowTokens !== undefined ? { windowTokens: reading.windowTokens } : {}),
      ...(reading.model !== undefined ? { model: reading.model } : {}),
    },
  })
}

function invocationHasActiveTurn(invocationState: string): boolean {
  return invocationState === 'turn_active' || invocationState === 'awaiting_input'
}

function lastCompletedTurnId(
  db: HrcDatabase,
  invocationId: string,
  beforeSeq: number
): string | undefined {
  const completed = db.brokerInvocationEvents
    .listByInvocationIdAndTypes({
      invocationId,
      types: ['turn.completed'],
      throughSeq: beforeSeq - 1,
    })
    .at(-1)
  if (completed === undefined) return undefined

  return (
    turnIdFromPersistedEnvelope(completed.brokerEnvelopeJson) ??
    turnIdFromPayload(completed.brokerEventJson)
  )
}

function turnIdFromPersistedEnvelope(brokerEnvelopeJson: string | undefined): string | undefined {
  if (brokerEnvelopeJson === undefined) return undefined
  try {
    const envelope = JSON.parse(brokerEnvelopeJson)
    return isRecord(envelope) && typeof envelope['turnId'] === 'string'
      ? envelope['turnId']
      : undefined
  } catch {
    return undefined
  }
}

function turnIdFromPayload(brokerEventJson: string): string | undefined {
  try {
    const payload = JSON.parse(brokerEventJson)
    return isRecord(payload) && typeof payload['turnId'] === 'string'
      ? payload['turnId']
      : undefined
  } catch {
    return undefined
  }
}

function terminalTurnId(envelope: InvocationEventEnvelope): string | undefined {
  if (typeof envelope.turnId === 'string') return envelope.turnId
  const rawPayload: unknown = envelope.payload
  const payload = isRecord(rawPayload) ? rawPayload : undefined
  return typeof payload?.['turnId'] === 'string' ? payload['turnId'] : undefined
}

function parseReading(
  brokerEventJson: string,
  turnId: string,
  observedAt: string
): RuntimeContextReading | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(brokerEventJson)
  } catch {
    return undefined
  }
  if (!isRecord(payload) || !isRecord(payload['context'])) return undefined
  const context = payload['context']
  if (!isNonNegativeInteger(context['usedTokens'])) return undefined
  if (context['windowTokens'] !== undefined && !isPositiveInteger(context['windowTokens'])) {
    return undefined
  }
  const model = isReportedModelIdentity(payload['model']) ? payload['model'] : undefined
  return {
    turnId,
    usedTokens: context['usedTokens'],
    ...(context['windowTokens'] !== undefined ? { windowTokens: context['windowTokens'] } : {}),
    ...(model !== undefined ? { model } : {}),
    observedAt,
  }
}

/** Read only a validated persisted value; malformed historical JSON is absent. */
export function readRuntimeContextReading(
  runtimeStateJson: Record<string, unknown> | undefined
): RuntimeContextReading | null {
  const value = runtimeStateJson?.[CONTEXT_READING_STATE_KEY]
  if (!isRecord(value)) return null
  if (typeof value['turnId'] !== 'string' || value['turnId'].trim().length === 0) return null
  if (!isNonNegativeInteger(value['usedTokens'])) return null
  if (typeof value['observedAt'] !== 'string' || value['observedAt'].trim().length === 0)
    return null
  if (value['windowTokens'] !== undefined && !isPositiveInteger(value['windowTokens'])) return null
  if (value['model'] !== undefined && !isReportedModelIdentity(value['model'])) return null
  return {
    turnId: value['turnId'],
    usedTokens: value['usedTokens'],
    ...(value['windowTokens'] !== undefined ? { windowTokens: value['windowTokens'] } : {}),
    ...(value['model'] !== undefined ? { model: value['model'] } : {}),
    observedAt: value['observedAt'],
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
