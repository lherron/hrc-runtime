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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}
