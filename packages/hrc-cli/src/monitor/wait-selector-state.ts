/** Selector-scoped live state readers for hrc monitor wait. */
import { parseScopeRef } from 'agent-scope'
import { CliUsageError, parseDuration } from 'cli-kit'
import {
  type HrcMessageRecord,
  type HrcMonitorCondition,
  type HrcMonitorRuntimeState,
  type HrcMonitorSessionState,
  type HrcMonitorState,
  type HrcRuntimeSnapshot,
  type HrcSelector,
  type HrcSessionRecord,
  type InspectRuntimeResponse,
  monitorSessionMatchKind,
} from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'
import {
  type HrcDatabase,
  type HrcLifecycleMonitorFilters,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type { MonitorSelectorSpec } from './selector-shape.js'
import {
  type MonitorRuntimeIdentitySource,
  type MonitorRuntimeSource,
  type SelectorState,
  escapeLike,
  normalizeLaneRef,
  normalizeRuntimeStatus,
  sessionRefFor,
  toMonitorMessage,
} from './wait-projection.js'

export const LIVE_MONITOR_EVENT_BATCH_LIMIT = 256

export function initialEventFromSeq(
  condition: HrcMonitorCondition,
  since: string | undefined,
  highWater: number,
  dbPath?: string | undefined
): number {
  void condition
  if (since === undefined) return Math.max(1, highWater)
  if (/^\d+$/.test(since)) {
    const seq = Number(since)
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new CliUsageError('--since sequence must be a positive safe integer')
    }
    return seq
  }

  const cutoff = new Date(Date.now() - parseDuration(since)).toISOString()
  if (dbPath === undefined) return Math.max(1, highWater)
  const db = openHrcDatabase(dbPath, { migrate: false })
  try {
    const row = db.sqlite
      .query<{ hrc_seq: number }, [string, number]>(
        `SELECT hrc_seq
           FROM hrc_events
          WHERE ts >= ? AND hrc_seq <= ?
          ORDER BY hrc_seq ASC
          LIMIT 1`
      )
      .get(cutoff, highWater)
    return row?.hrc_seq ?? highWater + 1
  } finally {
    db.close()
  }
}

export function readFilteredEvents(
  db: HrcDatabase,
  fromHrcSeq: number,
  throughHrcSeq: number,
  filters: readonly HrcLifecycleMonitorFilters[]
): ReturnType<HrcDatabase['hrcEvents']['listFromHrcSeqFiltered']> {
  const bySeq = new Map<
    number,
    ReturnType<HrcDatabase['hrcEvents']['listFromHrcSeqFiltered']>[number]
  >()
  for (const filter of filters) {
    for (const event of db.hrcEvents.listFromHrcSeqFiltered(fromHrcSeq, filter)) {
      if (event.hrcSeq <= throughHrcSeq) bySeq.set(event.hrcSeq, event)
    }
  }
  return [...bySeq.values()].sort((a, b) => a.hrcSeq - b.hrcSeq)
}

export function readFilteredEventBatch(
  db: HrcDatabase,
  fromHrcSeq: number,
  throughHrcSeq: number,
  filters: readonly HrcLifecycleMonitorFilters[]
): {
  events: ReturnType<HrcDatabase['hrcEvents']['listFromHrcSeqFiltered']>
  nextHrcSeq: number
} {
  const rowsByFilter = filters.map((filter) =>
    db.hrcEvents.listFromHrcSeqFiltered(fromHrcSeq, {
      ...filter,
      limit: LIVE_MONITOR_EVENT_BATCH_LIMIT,
    })
  )
  const safeThroughHrcSeq = rowsByFilter.reduce((safeThrough, rows) => {
    if (rows.length < LIVE_MONITOR_EVENT_BATCH_LIMIT) return safeThrough
    return Math.min(safeThrough, rows.at(-1)?.hrcSeq ?? safeThrough)
  }, throughHrcSeq)
  const bySeq = new Map<
    number,
    ReturnType<HrcDatabase['hrcEvents']['listFromHrcSeqFiltered']>[number]
  >()
  for (const rows of rowsByFilter) {
    for (const event of rows) {
      if (event.hrcSeq <= safeThroughHrcSeq) bySeq.set(event.hrcSeq, event)
    }
  }
  return {
    events: [...bySeq.values()].sort((a, b) => a.hrcSeq - b.hrcSeq),
    nextHrcSeq: safeThroughHrcSeq + 1,
  }
}

export function selectorEventFilters(
  specs: readonly MonitorSelectorSpec[],
  selected: SelectorState
): HrcLifecycleMonitorFilters[] {
  if (specs.length === 0) return [{}]
  return specs.flatMap((spec): HrcLifecycleMonitorFilters[] => {
    if (spec.kind === 'task') return [{ exactTaskIds: [spec.taskId] }]
    if (spec.kind === 'scope-prefix') return [{ scopeRefPrefixes: [spec.prefix] }]

    const selector = spec.selector
    if (selector.kind === 'runtime') return [{ runtimeId: selector.runtimeId }]
    if (selector.kind === 'host' || selector.kind === 'concrete') {
      return [{ hostSessionId: selector.hostSessionId }]
    }
    if (
      (selector.kind === 'target' || selector.kind === 'scope') &&
      parseScopeRef(selector.scopeRef).roleName === undefined
    ) {
      const matches = selected.sessions.filter(
        (candidate) => monitorSessionMatchKind(candidate, selector) !== null
      )
      return matches.length > 0
        ? matches.map((candidate) => ({ hostSessionId: candidate.hostSessionId }))
        : [{ runtimeId: '__hrc_monitor_unresolved__' }]
    }
    if (selector.kind === 'scope') return [{ scopeRef: selector.scopeRef }]
    if (selector.kind === 'message' || selector.kind === 'message-seq') {
      const message = selected.messages?.find((candidate) =>
        selector.kind === 'message'
          ? candidate.messageId === selector.messageId
          : candidate.messageSeq === selector.messageSeq
      )
      if (message?.runtimeId) return [{ runtimeId: message.runtimeId }]
      if (message?.runId) return [{ runId: message.runId }]
      if (message?.hostSessionId) return [{ hostSessionId: message.hostSessionId }]
    }
    const session = selected.sessions.find((candidate) =>
      selector.kind === 'stable' || selector.kind === 'target' || selector.kind === 'session'
        ? candidate.sessionRef === selector.sessionRef
        : false
    )
    return [
      session
        ? { hostSessionId: session.hostSessionId }
        : { runtimeId: '__hrc_monitor_unresolved__' },
    ]
  })
}

export async function readSelectorSetState(
  specs: readonly MonitorSelectorSpec[],
  client: HrcClient,
  db: HrcDatabase
): Promise<SelectorState> {
  const selected = emptySelectorState()
  for (const spec of specs) {
    if (spec.kind !== 'exact') continue
    mergeSelectorState(selected, await readExactSelectorState(spec.selector, client, db))
  }

  const scopedHostIds = readScopedSelectorHostIds(specs, db)
  for (const hostSessionId of scopedHostIds) {
    const session = db.sessions.getByHostSessionId(hostSessionId)
    if (!session) continue
    mergeSelectorState(
      selected,
      stateFromSession(session, db.runtimes.getLatestByHostSessionId(hostSessionId))
    )
  }
  return selected
}

export function readScopedSelectorHostIds(
  specs: readonly MonitorSelectorSpec[],
  db: HrcDatabase
): string[] {
  const predicates: string[] = []
  const values: string[] = []
  for (const spec of specs) {
    if (spec.kind === 'scope-prefix') {
      predicates.push("scope_ref LIKE ? ESCAPE '\\'")
      values.push(`${escapeLike(spec.prefix)}%`)
    } else if (spec.kind === 'task') {
      predicates.push(
        '(sessions.scope_ref,sessions.lane_ref) IN (SELECT c.scope_ref,c.lane_ref FROM continuities c WHERE c.task_id=?)'
      )
      values.push(spec.taskId)
    }
  }
  if (predicates.length === 0) return []
  const rows = db.sqlite
    .query<{ host_session_id: string }, string[]>(
      `SELECT host_session_id FROM sessions WHERE ${predicates.join(' OR ')} ORDER BY host_session_id`
    )
    .all(...values)
  return rows.map((row) => row.host_session_id)
}

export async function readExactSelectorState(
  selector: HrcSelector,
  client: HrcClient,
  db: HrcDatabase
): Promise<SelectorState> {
  switch (selector.kind) {
    case 'stable':
    case 'session': {
      const resolved = await client.resolveSession({
        sessionRef: selector.sessionRef,
        create: false,
      })
      if (!resolved.found) return emptySelectorState()
      return stateFromSession(
        resolved.session,
        db.runtimes.getLatestByHostSessionId(resolved.hostSessionId)
      )
    }
    case 'target':
    case 'scope': {
      if (parseScopeRef(selector.scopeRef).roleName === undefined) {
        return readRoleTreeSelectorState(selector, db)
      }
      const sessionRef =
        selector.kind === 'scope' ? sessionRefFor(selector.scopeRef, 'main') : selector.sessionRef
      const resolved = await client.resolveSession({ sessionRef, create: false })
      if (!resolved.found) return emptySelectorState()
      return stateFromSession(
        resolved.session,
        db.runtimes.getLatestByHostSessionId(resolved.hostSessionId)
      )
    }
    case 'concrete':
    case 'host': {
      const session = db.sessions.getByHostSessionId(selector.hostSessionId)
      return session
        ? stateFromSession(session, db.runtimes.getLatestByHostSessionId(session.hostSessionId))
        : emptySelectorState()
    }
    case 'runtime': {
      const runtime = await client.inspectRuntime({ runtimeId: selector.runtimeId })
      return stateFromInspectedRuntime(runtime, db)
    }
    case 'message':
    case 'message-seq': {
      const message =
        selector.kind === 'message'
          ? db.messages.getById(selector.messageId)
          : db.messages.getBySeq(selector.messageSeq)
      return message ? await stateFromMessage(message, client, db) : emptySelectorState()
    }
  }
}

export function readRoleTreeSelectorState(
  selector: Extract<HrcSelector, { kind: 'target' | 'scope' }>,
  db: HrcDatabase
): SelectorState {
  const rows = db.sqlite
    .query<{ host_session_id: string }, [string, string]>(
      "SELECT host_session_id FROM sessions WHERE scope_ref = ? OR scope_ref LIKE ? ESCAPE '\\' ORDER BY host_session_id"
    )
    .all(selector.scopeRef, `${escapeLike(selector.scopeRef)}:role:%`)
  const selected = emptySelectorState()
  for (const row of rows) {
    const session = db.sessions.getByHostSessionId(row.host_session_id)
    if (!session) continue
    const runtime = db.runtimes.getLatestByHostSessionId(session.hostSessionId)
    const monitorSession = toMonitorSessionState(session, runtime)
    if (!monitorSessionMatchKind(monitorSession, selector)) continue
    mergeSelectorState(selected, {
      sessions: [monitorSession],
      runtimes: runtime ? [toMonitorRuntimeState(runtime)] : [],
      messages: [],
    })
  }
  return selected
}

export function emptySelectorState(): SelectorState {
  return { sessions: [], runtimes: [], messages: [] }
}

export function stateFromSession(
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot | InspectRuntimeResponse | undefined | null
): SelectorState {
  return {
    sessions: [toMonitorSessionState(session, runtime)],
    runtimes: runtime ? [toMonitorRuntimeState(runtime)] : [],
    messages: [],
  }
}

export function stateFromInspectedRuntime(
  runtime: InspectRuntimeResponse,
  db: HrcDatabase
): SelectorState {
  const session = db.sessions.getByHostSessionId(runtime.hostSessionId)
  return {
    sessions: [
      session ? toMonitorSessionState(session, runtime) : toMonitorSessionFromRuntime(runtime),
    ],
    runtimes: [toMonitorRuntimeState(runtime)],
    messages: [],
  }
}

export async function stateFromMessage(
  message: HrcMessageRecord,
  client: HrcClient,
  db: HrcDatabase
): Promise<SelectorState> {
  const runtime = message.execution.runtimeId
    ? await client.inspectRuntime({ runtimeId: message.execution.runtimeId })
    : message.execution.hostSessionId
      ? db.runtimes.getLatestByHostSessionId(message.execution.hostSessionId)
      : null
  const session = message.execution.hostSessionId
    ? db.sessions.getByHostSessionId(message.execution.hostSessionId)
    : null

  if (runtime) {
    return {
      sessions: [
        session ? toMonitorSessionState(session, runtime) : toMonitorSessionFromRuntime(runtime),
      ],
      runtimes: [toMonitorRuntimeState(runtime)],
      messages: [toMonitorMessage(message)],
    }
  }
  if (message.execution.sessionRef) {
    const resolved = await client.resolveSession({
      sessionRef: message.execution.sessionRef,
      create: false,
    })
    if (resolved.found) {
      return {
        ...stateFromSession(
          resolved.session,
          db.runtimes.getLatestByHostSessionId(resolved.hostSessionId)
        ),
        messages: [toMonitorMessage(message)],
      }
    }
  }
  return { sessions: [], runtimes: [], messages: [toMonitorMessage(message)] }
}

export function toMonitorSessionState(
  session: HrcSessionRecord,
  runtime?: Pick<MonitorRuntimeSource, 'runtimeId' | 'activeRunId'> | null | undefined
): HrcMonitorSessionState {
  return {
    sessionRef: sessionRefFor(session.scopeRef, session.laneRef),
    scopeRef: session.scopeRef,
    identity: session.identity,
    laneRef: normalizeLaneRef(session.laneRef),
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(runtime?.runtimeId ? { runtimeId: runtime.runtimeId } : {}),
    status: session.status,
    activeTurnId: runtime?.activeRunId ?? null,
  }
}

export function toMonitorSessionFromRuntime(
  runtime: MonitorRuntimeIdentitySource
): HrcMonitorSessionState {
  return {
    sessionRef: sessionRefFor(runtime.scopeRef, runtime.laneRef),
    scopeRef: runtime.scopeRef,
    identity: runtime.identity,
    laneRef: normalizeLaneRef(runtime.laneRef),
    hostSessionId: runtime.hostSessionId,
    generation: runtime.generation,
    runtimeId: runtime.runtimeId,
    status: 'active',
    activeTurnId: runtime.activeRunId,
  }
}

export function toMonitorRuntimeState(runtime: MonitorRuntimeSource): HrcMonitorRuntimeState {
  return {
    runtimeId: runtime.runtimeId,
    identity: runtime.identity,
    hostSessionId: runtime.hostSessionId,
    ...(runtime.scopeRef !== undefined ? { scopeRef: runtime.scopeRef } : {}),
    ...(runtime.laneRef !== undefined ? { laneRef: runtime.laneRef } : {}),
    status: normalizeRuntimeStatus(runtime.status, runtime.activeRunId),
    statusChangedAt: runtime.statusChangedAt ?? 'unknown',
    transport: runtime.transport,
    activeTurnId: runtime.activeRunId ?? null,
  }
}

export function mergeSelectorState(target: SelectorState, source: SelectorState): void {
  mergeByKey(target.sessions, source.sessions, (entry) => entry.hostSessionId)
  mergeByKey(target.runtimes, source.runtimes, (entry) => entry.runtimeId)
  mergeByKey(target.messages ?? [], source.messages ?? [], (entry) => entry.messageId)
}

export function mergeByKey<T>(
  target: T[],
  source: readonly T[],
  keyFor: (entry: T) => string
): void {
  const keys = new Set(target.map(keyFor))
  for (const entry of source) {
    const key = keyFor(entry)
    if (keys.has(key)) continue
    keys.add(key)
    target.push(entry)
  }
}

export function mergeEventIdentities(
  state: HrcMonitorState,
  events: readonly ReturnType<HrcDatabase['hrcEvents']['listFromHrcSeqFiltered']>[number][],
  db: HrcDatabase
): void {
  for (const event of events) {
    if (state.sessions.some((session) => session.hostSessionId === event.hostSessionId)) continue
    const session = db.sessions.getByHostSessionId(event.hostSessionId)
    if (!session) continue
    mergeSelectorState(
      state,
      stateFromSession(session, db.runtimes.getLatestByHostSessionId(event.hostSessionId))
    )
  }
}
