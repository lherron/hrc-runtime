/** Implementation for the hrc monitor wait condition command. */
import { CliUsageError, parseDuration } from 'cli-kit'
import {
  HrcDomainError,
  type HrcMessageRecord,
  type HrcMonitorCondition,
  type HrcMonitorEvent,
  type HrcMonitorMessageState,
  type HrcMonitorRuntimeState,
  type HrcMonitorSessionState,
  type HrcMonitorState,
  type HrcRuntimeSnapshot,
  type HrcSelector,
  type HrcSessionRecord,
  type InspectRuntimeResponse,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import {
  type HrcDatabase,
  type HrcLifecycleMonitorFilters,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import { matchStringFlag } from '../monitor-args.js'
import { runMonitorUntilPlan } from './engine.js'
import { writeWaitFinalEvent, writeWaitUsageError } from './render/wait-output.js'
import {
  type MonitorSelectorSpec,
  parseMonitorSelectors,
  selectorSetLabel,
} from './selector-shape.js'
import { appendUntilValue, resolveMonitorUntilPlan } from './until-args.js'

type MonitorWaitOptions = {
  selectorRaws: string[]
  until?: string[] | undefined
  untilAny?: string[] | undefined
  untilAll?: string[] | undefined
  timeout?: string | undefined
  stallAfter?: string | undefined
  since?: string | undefined
  json: boolean
}

export class MonitorWaitExit extends Error {
  constructor(readonly code: number) {
    super(`monitor wait exit ${code}`)
    this.name = 'MonitorWaitExit'
  }
}

export async function cmdMonitorWait(args: string[]): Promise<void> {
  const options = parseWaitArgs(args)

  try {
    const exitCode = await runMonitorWait(options)
    throw new MonitorWaitExit(exitCode)
  } catch (error) {
    if (error instanceof CliUsageError) {
      writeWaitUsageError(error.message, options.json)
      throw new MonitorWaitExit(2)
    }
    if (error instanceof HrcDomainError) {
      writeWaitUsageError(error.message, options.json)
      throw new MonitorWaitExit(2)
    }
    throw error
  }
}

async function runMonitorWait(options: MonitorWaitOptions): Promise<number> {
  validateOptions(options)
  const timeoutMs = options.timeout ? parseDuration(options.timeout) : undefined
  const deadlineAt = timeoutMs === undefined ? undefined : Date.now() + timeoutMs

  let selectorSpecs: MonitorSelectorSpec[]
  try {
    selectorSpecs = parseMonitorSelectors(options.selectorRaws)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`invalid selector: ${message}`)
  }
  const plan = resolveMonitorUntilPlan(
    { until: options.until, untilAny: options.untilAny, untilAll: options.untilAll },
    selectorSpecs,
    { defaultWhenBlocking: true }
  )
  if (!plan) throw new CliUsageError('monitor wait requires a condition plan')
  const primaryCondition = plan.conditions[0]
  if (!primaryCondition) throw new CliUsageError('at least one monitor condition is required')
  if (options.since !== undefined) {
    throw new CliUsageError('--since is not supported by the explicit condition grammar')
  }
  const fixtureState = readFixtureState()
  let liveSource: LiveMonitorStateSource | undefined
  if (!fixtureState) {
    try {
      liveSource = await createLiveSourceBeforeDeadline(
        { selectorSpecs, condition: primaryCondition as HrcMonitorCondition },
        deadlineAt
      )
    } catch (error) {
      if (error instanceof MonitorWaitDeadlineError) {
        return writeEarlyTimeout(selectorSetLabel(selectorSpecs), primaryCondition, options.json)
      }
      throw error
    }
  }
  const initialState = fixtureState ?? liveSource?.initialState
  if (!initialState) throw new Error('monitor wait failed to build initial state')
  const result = await runMonitorUntilPlan(
    initialState,
    plan,
    selectorSpecs,
    {
      buildMonitorState: async (signal) =>
        fixtureState ?? liveSource?.buildMonitorState(signal) ?? initialState,
      stderr: process.stderr,
    },
    {
      ...(deadlineAt !== undefined ? { timeoutMs: remainingDeadlineMs(deadlineAt) } : {}),
      ...(options.stallAfter ? { stallAfterMs: parseDuration(options.stallAfter) } : {}),
    }
  )
  writeWaitFinalEvent(result.event, options.json)
  return result.exitCode
}

function parseWaitArgs(args: string[]): MonitorWaitOptions {
  const selectorRaws: string[] = []
  const untilFamilies: Partial<Record<'until' | 'until-any' | 'until-all', string[]>> = {}
  let timeout: string | undefined
  let stallAfter: string | undefined
  let since: string | undefined
  let json = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === undefined) continue

    if (arg === '--json') {
      json = true
      continue
    }
    const untilAnyMatch = matchStringFlag(arg, '--until-any', args, i)
    if (untilAnyMatch) {
      appendUntilValue(untilFamilies, 'until-any', untilAnyMatch.value)
      i = untilAnyMatch.next
      continue
    }
    const untilAllMatch = matchStringFlag(arg, '--until-all', args, i)
    if (untilAllMatch) {
      appendUntilValue(untilFamilies, 'until-all', untilAllMatch.value)
      i = untilAllMatch.next
      continue
    }
    const untilMatch = matchStringFlag(arg, '--until', args, i)
    if (untilMatch) {
      appendUntilValue(untilFamilies, 'until', untilMatch.value)
      i = untilMatch.next
      continue
    }
    const timeoutMatch = matchStringFlag(arg, '--timeout', args, i)
    if (timeoutMatch) {
      timeout = timeoutMatch.value
      i = timeoutMatch.next
      continue
    }
    const stallMatch = matchStringFlag(arg, '--stall-after', args, i)
    if (stallMatch) {
      stallAfter = stallMatch.value
      i = stallMatch.next
      continue
    }
    const sinceMatch = matchStringFlag(arg, '--since', args, i)
    if (sinceMatch) {
      since = sinceMatch.value
      i = sinceMatch.next
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    selectorRaws.push(arg)
  }

  return {
    selectorRaws,
    until: untilFamilies.until,
    untilAny: untilFamilies['until-any'],
    untilAll: untilFamilies['until-all'],
    timeout,
    stallAfter,
    since,
    json,
  }
}

function validateOptions(options: MonitorWaitOptions): void {
  if (options.selectorRaws.length === 0) {
    throw new CliUsageError('missing required argument: <selector>')
  }
}

function readFixtureState(): HrcMonitorState | undefined {
  const raw = process.env['HRC_MONITOR_FIXTURE_STATE_JSON']
  if (raw === undefined || raw.trim().length === 0) {
    return undefined
  }
  try {
    return JSON.parse(raw) as HrcMonitorState
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new CliUsageError(`HRC_MONITOR_FIXTURE_STATE_JSON is invalid JSON: ${message}`)
  }
}

export type LiveMonitorSourceRequest = {
  selectorSpecs: readonly MonitorSelectorSpec[]
  condition: HrcMonitorCondition
  since?: string | undefined
}

export type LiveMonitorStateSource = {
  initialState: HrcMonitorState
  buildMonitorState(signal?: AbortSignal | undefined): Promise<HrcMonitorState>
}

type SelectorState = Pick<HrcMonitorState, 'sessions' | 'runtimes' | 'messages'>

type MonitorRuntimeSource = {
  runtimeId: string
  hostSessionId: string
  scopeRef?: string | undefined
  laneRef?: string | undefined
  status: string
  statusChangedAt?: string | undefined
  transport: string
  activeRunId?: string | null | undefined
}

type MonitorRuntimeIdentitySource = MonitorRuntimeSource & {
  scopeRef: string
  laneRef: string
  generation: number
}

class MonitorWaitDeadlineError extends Error {}

async function createLiveSourceBeforeDeadline(
  request: LiveMonitorSourceRequest,
  deadlineAt?: number | undefined
): Promise<LiveMonitorStateSource> {
  const controller = new AbortController()
  const sourcePromise = createLiveMonitorStateSource(request, controller.signal)
  if (deadlineAt === undefined) return sourcePromise

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      sourcePromise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new MonitorWaitDeadlineError('monitor wait initial read exceeded timeout'))
        }, remainingDeadlineMs(deadlineAt))
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function remainingDeadlineMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - Date.now())
}

function writeEarlyTimeout(
  selectorLabel: string,
  condition: HrcMonitorCondition,
  json: boolean
): number {
  writeWaitFinalEvent(
    {
      event: 'monitor.completed',
      selector: selectorLabel,
      condition,
      result: 'timeout',
      exitCode: 1,
      replayed: false,
      ts: new Date().toISOString(),
    },
    json
  )
  return 1
}

export async function createLiveMonitorStateSource(
  request: LiveMonitorSourceRequest,
  signal?: AbortSignal | undefined
): Promise<LiveMonitorStateSource> {
  signal?.throwIfAborted()
  const socketPath = discoverSocket()
  const client = new HrcClient(socketPath)
  const status = await client.getStatus({ includeSessions: false })
  signal?.throwIfAborted()

  const db = openHrcDatabase(status.dbPath)
  let state: HrcMonitorState
  let filters: HrcLifecycleMonitorFilters[]
  let targetMessages: HrcMonitorMessageState[]
  let nextHrcSeq: number
  let nextMessageSeq: number
  try {
    signal?.throwIfAborted()
    const eventGlobalHighWaterSeq = db.hrcEvents.maxHrcSeq()
    const messageGlobalHighWaterSeq = db.messages.maxMessageSeq()
    const selected = await readSelectorSetState(request.selectorSpecs, client, db)
    signal?.throwIfAborted()
    filters = selectorEventFilters(request.selectorSpecs, selected)
    const fromHrcSeq = initialEventFromSeq(
      request.condition,
      request.since,
      eventGlobalHighWaterSeq
    )
    const rawEvents = readFilteredEvents(db, fromHrcSeq, eventGlobalHighWaterSeq, filters)
    applyLifecycleProjection(selected, rawEvents)
    targetMessages = [...(selected.messages ?? [])]
    const responseMessages = readCorrelatedResponses(
      db,
      targetMessages,
      0,
      messageGlobalHighWaterSeq
    )
    mergeMessageStates(selected, responseMessages)
    const events = [
      ...rawEvents.map(toMonitorEvent),
      ...responseMessages.map(toMessageResponseEvent),
    ].sort((a, b) => a.seq - b.seq)
    signal?.throwIfAborted()

    state = {
      daemon: {
        status: 'healthy',
        socketPath: status.socketPath,
        startedAt: status.startedAt,
        uptime: status.uptime,
        apiVersion: status.apiVersion,
      },
      socket: {
        path: status.socketPath,
        responsive: true,
      },
      sessions: selected.sessions,
      runtimes: selected.runtimes,
      messages: selected.messages,
      events,
      eventGlobalHighWaterSeq,
      sessionGlobalCount: status.sessionCount,
      runtimeGlobalCount: status.runtimeCount,
    }
    nextHrcSeq = eventGlobalHighWaterSeq + 1
    nextMessageSeq = messageGlobalHighWaterSeq + 1
  } finally {
    db.close()
  }

  let pendingRefresh = Promise.resolve(state)
  const refresh = async (refreshSignal?: AbortSignal | undefined): Promise<HrcMonitorState> => {
    refreshSignal?.throwIfAborted()
    const refreshDb = openHrcDatabase(status.dbPath)
    try {
      const eventGlobalHighWaterSeq = refreshDb.hrcEvents.maxHrcSeq()
      const messageGlobalHighWaterSeq = refreshDb.messages.maxMessageSeq()
      const rawEvents = readFilteredEvents(refreshDb, nextHrcSeq, eventGlobalHighWaterSeq, filters)
      const responseMessages = readCorrelatedResponses(
        refreshDb,
        targetMessages,
        nextMessageSeq - 1,
        messageGlobalHighWaterSeq
      )
      refreshSignal?.throwIfAborted()

      mergeEventIdentities(state, rawEvents, refreshDb)
      applyLifecycleProjection(state, rawEvents)
      mergeMessageStates(state, responseMessages)
      state.events.push(
        ...rawEvents.map(toMonitorEvent),
        ...responseMessages.map(toMessageResponseEvent)
      )
      state.events.sort((a, b) => a.seq - b.seq)
      state.eventGlobalHighWaterSeq = eventGlobalHighWaterSeq
      nextHrcSeq = eventGlobalHighWaterSeq + 1
      nextMessageSeq = messageGlobalHighWaterSeq + 1
      return state
    } finally {
      refreshDb.close()
    }
  }

  return {
    initialState: state,
    buildMonitorState(refreshSignal) {
      pendingRefresh = pendingRefresh.then(() => refresh(refreshSignal))
      return pendingRefresh
    },
  }
}

function initialEventFromSeq(
  condition: HrcMonitorCondition,
  since: string | undefined,
  highWater: number
): number {
  void condition
  void since
  return Math.max(1, highWater)
}

function readFilteredEvents(
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

function selectorEventFilters(
  specs: readonly MonitorSelectorSpec[],
  selected: SelectorState
): HrcLifecycleMonitorFilters[] {
  return specs.map((spec) => {
    if (spec.kind === 'task') return { taskIds: [spec.taskId] }
    if (spec.kind === 'scope-prefix') return { scopeRefPrefixes: [spec.prefix] }

    const selector = spec.selector
    if (selector.kind === 'runtime') return { runtimeId: selector.runtimeId }
    if (selector.kind === 'host' || selector.kind === 'concrete') {
      return { hostSessionId: selector.hostSessionId }
    }
    if (selector.kind === 'scope') return { scopeRef: selector.scopeRef }
    if (selector.kind === 'message' || selector.kind === 'message-seq') {
      const message = selected.messages?.find((candidate) =>
        selector.kind === 'message'
          ? candidate.messageId === selector.messageId
          : candidate.messageSeq === selector.messageSeq
      )
      if (message?.runtimeId) return { runtimeId: message.runtimeId }
      if (message?.runId) return { runId: message.runId }
      if (message?.hostSessionId) return { hostSessionId: message.hostSessionId }
    }
    const session = selected.sessions.find((candidate) =>
      selector.kind === 'stable' || selector.kind === 'target' || selector.kind === 'session'
        ? candidate.sessionRef === selector.sessionRef
        : false
    )
    return session
      ? { hostSessionId: session.hostSessionId }
      : { runtimeId: '__hrc_monitor_unresolved__' }
  })
}

async function readSelectorSetState(
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

function readScopedSelectorHostIds(
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
      predicates.push("(scope_ref LIKE ? ESCAPE '\\' OR scope_ref LIKE ? ESCAPE '\\')")
      const segment = escapeLike(`:task:${spec.taskId}`)
      values.push(`%${segment}:%`, `%${segment}`)
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

async function readExactSelectorState(
  selector: HrcSelector,
  client: HrcClient,
  db: HrcDatabase
): Promise<SelectorState> {
  switch (selector.kind) {
    case 'stable':
    case 'target':
    case 'session':
    case 'scope': {
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

function emptySelectorState(): SelectorState {
  return { sessions: [], runtimes: [], messages: [] }
}

function stateFromSession(
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot | InspectRuntimeResponse | undefined | null
): SelectorState {
  return {
    sessions: [toMonitorSessionState(session, runtime)],
    runtimes: runtime ? [toMonitorRuntimeState(runtime)] : [],
    messages: [],
  }
}

function stateFromInspectedRuntime(
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

async function stateFromMessage(
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

function toMonitorSessionState(
  session: HrcSessionRecord,
  runtime?: Pick<MonitorRuntimeSource, 'runtimeId' | 'activeRunId'> | null | undefined
): HrcMonitorSessionState {
  return {
    sessionRef: sessionRefFor(session.scopeRef, session.laneRef),
    scopeRef: session.scopeRef,
    laneRef: normalizeLaneRef(session.laneRef),
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(runtime?.runtimeId ? { runtimeId: runtime.runtimeId } : {}),
    status: session.status,
    activeTurnId: runtime?.activeRunId ?? null,
  }
}

function toMonitorSessionFromRuntime(
  runtime: MonitorRuntimeIdentitySource
): HrcMonitorSessionState {
  return {
    sessionRef: sessionRefFor(runtime.scopeRef, runtime.laneRef),
    scopeRef: runtime.scopeRef,
    laneRef: normalizeLaneRef(runtime.laneRef),
    hostSessionId: runtime.hostSessionId,
    generation: runtime.generation,
    runtimeId: runtime.runtimeId,
    status: 'active',
    activeTurnId: runtime.activeRunId,
  }
}

function toMonitorRuntimeState(runtime: MonitorRuntimeSource): HrcMonitorRuntimeState {
  return {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    ...(runtime.scopeRef !== undefined ? { scopeRef: runtime.scopeRef } : {}),
    ...(runtime.laneRef !== undefined ? { laneRef: runtime.laneRef } : {}),
    status: normalizeRuntimeStatus(runtime.status, runtime.activeRunId),
    statusChangedAt: runtime.statusChangedAt ?? 'unknown',
    transport: runtime.transport,
    activeTurnId: runtime.activeRunId ?? null,
  }
}

function mergeSelectorState(target: SelectorState, source: SelectorState): void {
  mergeByKey(target.sessions, source.sessions, (entry) => entry.hostSessionId)
  mergeByKey(target.runtimes, source.runtimes, (entry) => entry.runtimeId)
  mergeByKey(target.messages ?? [], source.messages ?? [], (entry) => entry.messageId)
}

function mergeByKey<T>(target: T[], source: readonly T[], keyFor: (entry: T) => string): void {
  const keys = new Set(target.map(keyFor))
  for (const entry of source) {
    const key = keyFor(entry)
    if (keys.has(key)) continue
    keys.add(key)
    target.push(entry)
  }
}

function mergeEventIdentities(
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

function applyLifecycleProjection(
  state: Pick<HrcMonitorState, 'sessions' | 'runtimes'>,
  events: readonly ReturnType<HrcDatabase['hrcEvents']['listFromHrcSeqFiltered']>[number][]
): void {
  for (const event of events) {
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

function readCorrelatedResponses(
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

function mergeMessageStates(
  state: Pick<HrcMonitorState, 'messages'>,
  messages: readonly HrcMessageRecord[]
): void {
  if (!state.messages) state.messages = []
  const target = state.messages
  mergeByKey(target, messages.map(toMonitorMessage), (entry) => entry.messageId)
}

function sessionRefFor(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${normalizeLaneRef(laneRef)}`
}

function normalizeLaneRef(laneRef: string): string {
  const laneId = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  return laneId === 'default' ? 'main' : laneId
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function toMonitorEvent(event: {
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
    ...monitorResultFields(monitorEvent, event.errorCode, payload),
  }
}

function toMessageResponseEvent(message: {
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

function toMonitorMessage(message: {
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

function monitorEventName(eventKind: string): string {
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

function monitorResultFields(
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

function normalizeRuntimeStatus(status: string, activeRunId: string | null | undefined): string {
  if (status === 'ready') return 'idle'
  if (activeRunId != null) return 'busy'
  return status
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
