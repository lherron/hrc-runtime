import type {
  HrcMessageRecord,
  HrcMonitorEvent,
  HrcMonitorMessageState,
  HrcMonitorState,
} from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'
import {} from './selector-shape.js'
import { mergeByKey } from './wait-selector-state.js'

export type SelectorState = Pick<HrcMonitorState, 'sessions' | 'runtimes' | 'messages'>

export type MonitorRuntimeSource = {
  runtimeId: string
  hostSessionId: string
  scopeRef?: string | undefined
  laneRef?: string | undefined
  status: string
  statusChangedAt?: string | undefined
  transport: string
  activeRunId?: string | null | undefined
}

export type MonitorRuntimeIdentitySource = MonitorRuntimeSource & {
  scopeRef: string
  laneRef: string
  generation: number
}

export function applyLifecycleProjection(
  state: Pick<HrcMonitorState, 'sessions' | 'runtimes'>,
  events: readonly ReturnType<HrcDatabase['hrcEvents']['listFromHrcSeqFiltered']>[number][]
): void {
  for (const event of events) {
    // T-08566 X5: retained-origin rows never move projected runtime/turn state.
    if (event.evidenceOrigin !== undefined) continue
    const runtime =
      (event.runtimeId
        ? state.runtimes.find((candidate) => candidate.runtimeId === event.runtimeId)
        : undefined) ??
      state.runtimes.find((candidate) => candidate.hostSessionId === event.hostSessionId)
    const session = state.sessions.find(
      (candidate) => candidate.hostSessionId === event.hostSessionId
    )

    if (event.eventKind === 'turn.started') {
      if (runtime) {
        if (runtime.status !== 'busy') runtime.statusChangedAt = event.ts
        runtime.activeTurnId = event.runId ?? null
        runtime.status = 'busy'
      }
      if (session) session.activeTurnId = event.runId ?? null
      continue
    }
    if (
      event.eventKind === 'turn.completed' ||
      event.eventKind === 'turn.finished' ||
      event.eventKind === 'turn.failed'
    ) {
      if (runtime && (!event.runId || runtime.activeTurnId === event.runId)) {
        if (runtime.status !== 'idle') runtime.statusChangedAt = event.ts
        runtime.activeTurnId = null
        runtime.status = 'idle'
      }
      if (session && (!event.runId || session.activeTurnId === event.runId)) {
        session.activeTurnId = null
      }
      continue
    }
    if (event.eventKind === 'runtime.ready') {
      if (runtime) {
        if (runtime.status !== 'idle') runtime.statusChangedAt = event.ts
        runtime.status = 'idle'
      }
      continue
    }
    if (
      event.eventKind === 'runtime.dead' ||
      event.eventKind === 'runtime.crashed' ||
      event.eventKind === 'runtime.terminated'
    ) {
      if (runtime) {
        const status = event.eventKind === 'runtime.crashed' ? 'crashed' : 'dead'
        if (runtime.status !== status) runtime.statusChangedAt = event.ts
        runtime.status = status
      }
    }
  }
}

export function readCorrelatedResponses(
  db: HrcDatabase,
  messages: readonly HrcMonitorMessageState[],
  afterSeq: number,
  throughSeq: number
): HrcMessageRecord[] {
  const byId = new Map<string, HrcMessageRecord>()
  for (const message of messages) {
    for (const response of db.messages.listCorrelatedResponses(
      message.messageId,
      message.rootMessageId ?? message.messageId,
      afterSeq
    )) {
      if (response.messageSeq <= throughSeq) byId.set(response.messageId, response)
    }
  }
  return [...byId.values()].sort((a, b) => a.messageSeq - b.messageSeq)
}

export function mergeMessageStates(
  state: Pick<HrcMonitorState, 'messages'>,
  messages: readonly HrcMessageRecord[]
): void {
  if (!state.messages) state.messages = []
  const target = state.messages
  mergeByKey(target, messages.map(toMonitorMessage), (entry) => entry.messageId)
}

export function sessionRefFor(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${normalizeLaneRef(laneRef)}`
}

export function normalizeLaneRef(laneRef: string): string {
  const laneId = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  return laneId === 'default' ? 'main' : laneId
}

export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

export function toMonitorEvent(event: {
  hrcSeq: number
  ts: string
  eventKind: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  errorCode?: string | undefined
  payload: unknown
  replayed: boolean
  evidenceOrigin?: 'retained' | undefined
}): HrcMonitorEvent {
  const payload = isRecord(event.payload) ? event.payload : {}
  const monitorEvent = monitorEventName(event.eventKind)
  return {
    seq: event.hrcSeq,
    ts: event.ts,
    event: monitorEvent,
    sessionRef: `${event.scopeRef}/lane:${event.laneRef}`,
    scopeRef: event.scopeRef,
    laneRef: event.laneRef,
    hostSessionId: event.hostSessionId,
    generation: event.generation,
    ...(event.runtimeId ? { runtimeId: event.runtimeId } : {}),
    ...(event.runId ? { turnId: event.runId, runId: event.runId } : {}),
    ...(event.replayed ? { replayed: true } : {}),
    ...(event.evidenceOrigin !== undefined ? { evidenceOrigin: event.evidenceOrigin } : {}),
    ...monitorResultFields(monitorEvent, event.errorCode, payload),
  }
}

export function toMessageResponseEvent(message: {
  messageSeq: number
  messageId: string
  createdAt: string
  replyToMessageId?: string | undefined
  rootMessageId: string
  execution: {
    sessionRef?: string | undefined
    hostSessionId?: string | undefined
    generation?: number | undefined
    runtimeId?: string | undefined
    runId?: string | undefined
  }
}): HrcMonitorEvent {
  const sessionRef = message.execution.sessionRef
  const [scopeRef, lanePart] = sessionRef?.split('/lane:') ?? []
  return {
    seq: message.messageSeq,
    ts: message.createdAt,
    event: 'message.response',
    sessionRef,
    scopeRef: scopeRef ?? '',
    laneRef: lanePart ?? 'main',
    hostSessionId: message.execution.hostSessionId ?? '',
    generation: message.execution.generation ?? 0,
    ...(message.execution.runtimeId ? { runtimeId: message.execution.runtimeId } : {}),
    ...(message.execution.runId ? { turnId: message.execution.runId } : {}),
    messageId: message.messageId,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    rootMessageId: message.rootMessageId,
    messageSeq: message.messageSeq,
    result: 'response',
  }
}

export function toMonitorMessage(message: {
  messageSeq: number
  messageId: string
  replyToMessageId?: string | undefined
  rootMessageId: string
  execution: {
    sessionRef?: string | undefined
    hostSessionId?: string | undefined
    runtimeId?: string | undefined
    runId?: string | undefined
  }
}): HrcMonitorMessageState {
  return {
    messageId: message.messageId,
    messageSeq: message.messageSeq,
    ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
    rootMessageId: message.rootMessageId,
    ...(message.execution.sessionRef ? { sessionRef: message.execution.sessionRef } : {}),
    ...(message.execution.hostSessionId ? { hostSessionId: message.execution.hostSessionId } : {}),
    ...(message.execution.runtimeId ? { runtimeId: message.execution.runtimeId } : {}),
    ...(message.execution.runId ? { runId: message.execution.runId } : {}),
  }
}

export function monitorEventName(eventKind: string): string {
  switch (eventKind) {
    case 'turn.completed':
      return 'turn.finished'
    case 'runtime.ready':
      return 'runtime.idle'
    case 'runtime.terminated':
      return 'runtime.dead'
    default:
      return eventKind
  }
}

export function monitorResultFields(
  eventName: string,
  errorCode: string | undefined,
  payload: Record<string, unknown>
): Record<string, unknown> {
  if (eventName === 'turn.finished') {
    const success = payload['success']
    if (success === false || errorCode !== undefined) {
      return { result: 'turn_failed', failureKind: 'runtime' }
    }
    return { result: 'turn_succeeded' }
  }
  if (eventName === 'runtime.dead' || eventName === 'runtime.crashed') {
    return {
      result: eventName === 'runtime.crashed' ? 'runtime_crashed' : 'runtime_dead',
      failureKind: 'runtime',
    }
  }
  return {}
}

export function normalizeRuntimeStatus(
  status: string,
  activeRunId: string | null | undefined
): string {
  if (status === 'ready') return 'idle'
  if (activeRunId != null) return 'busy'
  return status
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
