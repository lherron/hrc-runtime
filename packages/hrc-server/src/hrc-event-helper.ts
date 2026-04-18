import type { HrcEventCategory, HrcLifecycleEvent, HrcLifecycleTransport } from 'hrc-core'
import type { HrcDatabase, HrcLifecycleEventInput } from 'hrc-store-sqlite'

const KIND_CATEGORIES: Record<string, HrcEventCategory> = {
  'session.created': 'session',
  'session.resolved': 'session',
  'app-session.created': 'app_session',
  'app-session.removed': 'app_session',
  'app-session.literal-input': 'app_session',
  'target.literal-input': 'app_session',
  'runtime.created': 'runtime',
  'runtime.ensured': 'runtime',
  'runtime.interrupted': 'runtime',
  'runtime.terminated': 'runtime',
  'runtime.restarted': 'runtime',
  'runtime.dead': 'runtime',
  'runtime.stale': 'runtime',
  'runtime.adopted': 'runtime',
  'launch.wrapper_started': 'launch',
  'launch.child_started': 'launch',
  'launch.continuation_captured': 'launch',
  'launch.exited': 'launch',
  'launch.orphaned': 'launch',
  'launch.callback_rejected': 'launch',
  'turn.accepted': 'turn',
  'turn.started': 'turn',
  'turn.completed': 'turn',
  'inflight.accepted': 'inflight',
  'inflight.rejected': 'inflight',
  'surface.bound': 'surface',
  'surface.rebound': 'surface',
  'surface.unbound': 'surface',
  'bridge.delivered': 'bridge',
  'bridge.closed': 'bridge',
  'context.cleared': 'context',
}

export function categoryForEventKind(eventKind: string): HrcEventCategory {
  const category = KIND_CATEGORIES[eventKind]
  if (!category) {
    throw new Error(`unknown hrc event kind: ${eventKind}`)
  }
  return category
}

export type AppendHrcEventParams = {
  ts: string
  hostSessionId: string
  scopeRef: string
  laneRef: string
  generation: number
  runtimeId?: string | undefined
  runId?: string | undefined
  launchId?: string | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  transport?: HrcLifecycleTransport | undefined
  errorCode?: string | undefined
  replayed?: boolean | undefined
  payload?: unknown
}

export function appendHrcEvent(
  db: HrcDatabase,
  eventKind: string,
  params: AppendHrcEventParams
): HrcLifecycleEvent {
  const input: HrcLifecycleEventInput = {
    ts: params.ts,
    hostSessionId: params.hostSessionId,
    scopeRef: params.scopeRef,
    laneRef: params.laneRef,
    generation: params.generation,
    runtimeId: params.runtimeId,
    runId: params.runId,
    launchId: params.launchId,
    appId: params.appId,
    appSessionKey: params.appSessionKey,
    category: categoryForEventKind(eventKind),
    eventKind,
    transport: params.transport,
    errorCode: params.errorCode,
    replayed: params.replayed,
    payload: params.payload ?? {},
  }
  return db.hrcEvents.append(input)
}
