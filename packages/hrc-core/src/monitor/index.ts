import { type LaneRef, formatScopeHandle, formatSessionHandle, parseScopeRef } from 'agent-scope'

import { HrcErrorCode, createHrcError } from '../errors.js'
import { type HrcSelector, formatSelector, splitSessionRef } from '../selectors.js'

/**
 * Maximum number of trailing matching events replayed to a non-follow snapshot
 * read when no explicit `fromSeq` cursor is supplied.
 */
const DEFAULT_REPLAY_TAIL = 100

export type HrcMonitorSessionState = {
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  status: string
  activeTurnId?: string | null | undefined
}

export type HrcMonitorRuntimeState = {
  runtimeId: string
  hostSessionId: string
  scopeRef?: string | undefined
  laneRef?: string | undefined
  status: string
  statusChangedAt?: string | undefined
  transport: string
  activeTurnId?: string | null | undefined
}

export type HrcMonitorMessageState = {
  messageId: string
  messageSeq: number
  replyToMessageId?: string | undefined
  rootMessageId?: string | undefined
  sessionRef?: string | undefined
  hostSessionId?: string | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
}

export type HrcMonitorEvent = {
  seq: number
  ts?: string | undefined
  event: string
  sessionRef?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  runtimeId?: string | undefined
  runId?: string | undefined
  turnId?: string | undefined
  messageId?: string | undefined
  replyToMessageId?: string | undefined
  rootMessageId?: string | undefined
  messageSeq?: number | undefined
  [key: string]: unknown
}

export type HrcMonitorState = {
  daemon?: Record<string, unknown> | undefined
  socket?: Record<string, unknown> | undefined
  tmux?: Record<string, unknown> | undefined
  sessions: HrcMonitorSessionState[]
  runtimes: HrcMonitorRuntimeState[]
  messages?: HrcMonitorMessageState[] | undefined
  events: HrcMonitorEvent[]
  /**
   * Global event high-water override (T-04232). When set, supersedes
   * `max(events[].seq)` for snapshot/resolution `eventHighWaterSeq`. Required so
   * that a server-side filtered `events[]` subset does not collapse the cursor
   * high-water to the last *matching* event — selector and cursor/high-water
   * semantics must stay global, not filtered (daedalus invariant).
   */
  eventGlobalHighWaterSeq?: number | undefined
  /** Total durable sessions when `sessions` is a selector-bounded subset. */
  sessionGlobalCount?: number | undefined
  /** Total durable runtimes when `runtimes` is a selector-bounded subset. */
  runtimeGlobalCount?: number | undefined
}

export type HrcMonitorResolvedSelector = {
  kind: HrcSelector['kind']
  canonical: string
}

export type HrcMonitorResolution = {
  selector: HrcMonitorResolvedSelector
  sessionRef: string
  scopeRef: string
  laneRef: string
  hostSessionId: string
  generation: number
  runtimeId: string
  activeTurnId: string | null
  eventHighWaterSeq: number
}

export type HrcMonitorResolutionResult =
  | HrcMonitorResolution
  | (ReturnType<typeof createHrcError> & { ok: false })

export type HrcMonitorMatchedRuntime = {
  matchKind: 'exact' | 'role-child'
  roleName?: string | undefined
  scopeHandle: string
  sessionHandle: string
  scopeRef: string
  sessionRef: string
  hostSessionId: string
  runtimeId: string
  status: string
  generation: number
  laneRef: string
  activeTurnId?: string | null | undefined
}

export type HrcMonitorSnapshot = {
  kind: 'monitor.snapshot'
  selector?: HrcMonitorResolvedSelector | undefined
  eventHighWaterSeq: number
  daemon?: Record<string, unknown> | undefined
  socket?: Record<string, unknown> | undefined
  tmux?: Record<string, unknown> | undefined
  counts: {
    sessions: number
    runtimes: number
  }
  session?: HrcMonitorSessionState | undefined
  runtime?: HrcMonitorRuntimeState | undefined
  resolution?: HrcMonitorResolutionResult | undefined
  matches?: HrcMonitorMatchedRuntime[] | undefined
}

export type HrcMonitorWatchRequest = {
  selector?: HrcSelector | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  replayTail?: number | undefined
  includeCorrelatedMessageResponses?: boolean | undefined
  signal?: AbortSignal | undefined
}

export type HrcMonitorCaptureOptions = {
  afterSnapshot?: (() => void) | undefined
}

export type HrcMonitorCapture = HrcMonitorResolution & {
  streamCursorSeq: number
}

type ResolvedParts = {
  session: HrcMonitorSessionState
  runtime: HrcMonitorRuntimeState
}

export function createMonitorReader(state: HrcMonitorState): {
  resolve: (selector: HrcSelector) => HrcMonitorResolutionResult
  snapshot: (selector?: HrcSelector | undefined) => HrcMonitorSnapshot
  watch: (
    request: HrcMonitorWatchRequest
  ) => AsyncIterable<HrcMonitorEvent | Record<string, unknown>>
  captureStart: (
    selector: HrcSelector,
    options?: HrcMonitorCaptureOptions | undefined
  ) => Promise<HrcMonitorCapture | HrcMonitorResolutionResult>
} {
  return {
    resolve(selector) {
      return resolveSelector(state, selector)
    },
    snapshot(selector) {
      return snapshotState(state, selector)
    },
    watch(request) {
      return watchEvents(state, request)
    },
    async captureStart(selector, options) {
      const capture = resolveCaptureSelector(state, selector)
      options?.afterSnapshot?.()

      if (!isResolution(capture)) {
        return capture
      }

      const streamCursorSeq = Math.max(1, capture.eventHighWaterSeq)
      const captured: HrcMonitorCapture = {
        ...capture,
        // Inclusive replay from the captured high-water is the monotonic cursor
        // contract: events appended after snapshot and before follow attach have
        // seq > eventHighWaterSeq and therefore cannot be skipped.
        streamCursorSeq,
      }
      return protectStreamCursor(captured, streamCursorSeq)
    },
  }
}

function resolveSelector(
  state: HrcMonitorState,
  selector: HrcSelector
): HrcMonitorResolutionResult {
  return resolveSelectorWithParts(state, selector).resolution
}

function resolveSelectorWithParts(
  state: HrcMonitorState,
  selector: HrcSelector
): { resolution: HrcMonitorResolutionResult; parts: ResolvedParts | null } {
  const parts = resolveParts(state, selector)
  if (!parts) {
    return { resolution: notFound(selector), parts: null }
  }

  return {
    resolution: resolutionFromParts(state, selector, parts),
    parts,
  }
}

function resolutionFromParts(
  state: HrcMonitorState,
  selector: HrcSelector,
  parts: ResolvedParts
): HrcMonitorResolution {
  const { session, runtime } = parts
  return {
    selector: selectorView(selector),
    sessionRef: session.sessionRef,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    activeTurnId: session.activeTurnId ?? runtime.activeTurnId ?? null,
    eventHighWaterSeq: resolveHighWater(state),
  }
}

function resolveCaptureSelector(
  state: HrcMonitorState,
  selector: HrcSelector
): HrcMonitorResolutionResult {
  if (!isRoleTreeAwareSelector(selector)) {
    return resolveSelector(state, selector)
  }

  const matches = roleTreeParts(state, selector)
  if (matches.length === 0) {
    return notFound(selector)
  }
  if (matches.length > 1) {
    return ambiguousRoleTreeSelector(selector, matches)
  }

  const match = matches[0]
  if (!match) return notFound(selector)
  return resolutionFromParts(state, selector, match.parts)
}

function resolveParts(state: HrcMonitorState, selector: HrcSelector): ResolvedParts | null {
  switch (selector.kind) {
    case 'stable':
    case 'session':
      return partsFromSession(state, latestSessionBySessionRef(state, selector.sessionRef))
    case 'target':
    case 'scope':
      return roleTreeParts(state, selector)[0]?.parts ?? null
    case 'concrete':
    case 'host':
      return partsFromSession(
        state,
        state.sessions.find((session) => session.hostSessionId === selector.hostSessionId)
      )
    case 'runtime': {
      const runtime = state.runtimes.find((candidate) => candidate.runtimeId === selector.runtimeId)
      return runtime ? partsFromRuntime(state, runtime) : null
    }
    case 'message': {
      const message = state.messages?.find(
        (candidate) => candidate.messageId === selector.messageId
      )
      return message ? partsFromMessage(state, message) : null
    }
    case 'message-seq': {
      const message = state.messages?.find(
        (candidate) => candidate.messageSeq === selector.messageSeq
      )
      return message ? partsFromMessage(state, message) : null
    }
  }
}

type RoleTreeParts = {
  matchKind: 'exact' | 'role-child'
  roleName?: string | undefined
  parts: ResolvedParts
}

function roleTreeParts(
  state: HrcMonitorState,
  selector: Extract<HrcSelector, { kind: 'target' | 'scope' }>
): RoleTreeParts[] {
  const candidates: RoleTreeParts[] = []
  for (const session of state.sessions) {
    const matchKind = monitorSessionMatchKind(session, selector)
    if (!matchKind) continue
    const parts = partsFromSession(state, session)
    if (!parts) continue
    candidates.push({
      matchKind,
      roleName: safeRoleName(session.scopeRef),
      parts,
    })
  }

  return candidates.sort(compareRoleTreeParts)
}

function compareRoleTreeParts(left: RoleTreeParts, right: RoleTreeParts): number {
  if (left.matchKind !== right.matchKind) {
    return left.matchKind === 'exact' ? -1 : 1
  }

  const leftActive = left.parts.session.status === 'active'
  const rightActive = right.parts.session.status === 'active'
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1
  }

  const generation = right.parts.session.generation - left.parts.session.generation
  if (generation !== 0) return generation

  const leftLabel = left.roleName ?? left.parts.session.scopeRef
  const rightLabel = right.roleName ?? right.parts.session.scopeRef
  const label = leftLabel.localeCompare(rightLabel)
  if (label !== 0) return label

  return left.parts.runtime.runtimeId.localeCompare(right.parts.runtime.runtimeId)
}

function toMatchedRuntime(candidate: RoleTreeParts): HrcMonitorMatchedRuntime {
  const { session, runtime } = candidate.parts
  return {
    matchKind: candidate.matchKind,
    ...(candidate.roleName !== undefined ? { roleName: candidate.roleName } : {}),
    scopeHandle: formatScopeHandle(parseScopeRef(session.scopeRef)),
    sessionHandle: formatSessionHandle({
      scopeRef: session.scopeRef,
      laneRef: laneRefForHandle(session.laneRef),
    }),
    scopeRef: session.scopeRef,
    sessionRef: session.sessionRef,
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    status: runtime.status,
    generation: session.generation,
    laneRef: normalizeLaneId(session.laneRef),
    activeTurnId: session.activeTurnId ?? runtime.activeTurnId ?? null,
  }
}

function laneRefForHandle(laneRef: string): LaneRef {
  const laneId = normalizeLaneId(laneRef)
  return laneId === 'main' ? 'main' : `lane:${laneId}`
}

function ambiguousRoleTreeSelector(
  selector: Extract<HrcSelector, { kind: 'target' | 'scope' }>,
  matches: RoleTreeParts[]
): ReturnType<typeof createHrcError> & { ok: false } {
  const alternatives = matches.map((candidate) => {
    const match = toMatchedRuntime(candidate)
    return {
      roleHandle: match.sessionHandle,
      sessionSelector: `session:${match.sessionRef}`,
      runtimeSelector: `runtime:${match.runtimeId}`,
      scopeRef: match.scopeRef,
      sessionRef: match.sessionRef,
      runtimeId: match.runtimeId,
    }
  })
  return {
    ok: false,
    ...createHrcError(
      HrcErrorCode.INVALID_SELECTOR,
      `ambiguous monitor selector "${formatSelector(selector)}": matched ${matches.length} runtimes; use an exact slash-role handle, session:<sessionRef>, or runtime:<runtimeId>`,
      {
        selectorKind: selector.kind,
        selector: formatSelector(selector),
        alternatives,
      }
    ),
  }
}

export function monitorSessionMatchKind(
  session: Pick<HrcMonitorSessionState, 'scopeRef' | 'sessionRef' | 'laneRef'>,
  selector: HrcSelector
): 'exact' | 'role-child' | null {
  if (selector.kind === 'target') {
    if (sessionRefsEqual(session.sessionRef, selector.sessionRef)) return 'exact'
    if (!isImmediateRoleChildScopeRef(selector.scopeRef, session.scopeRef)) return null
    return laneIdsEqual(session.laneRef, splitSessionRef(selector.sessionRef).laneRef)
      ? 'role-child'
      : null
  }
  if (selector.kind === 'scope') {
    if (session.scopeRef === selector.scopeRef) return 'exact'
    return isImmediateRoleChildScopeRef(selector.scopeRef, session.scopeRef) ? 'role-child' : null
  }
  return null
}

export function isImmediateRoleChildScopeRef(
  baseScopeRef: string,
  candidateScopeRef: string
): boolean {
  try {
    const base = parseScopeRef(baseScopeRef)
    const candidate = parseScopeRef(candidateScopeRef)
    return (
      base.roleName === undefined &&
      candidate.roleName !== undefined &&
      base.agentId === candidate.agentId &&
      base.projectId === candidate.projectId &&
      base.taskId === candidate.taskId
    )
  } catch {
    return false
  }
}

function isRoleTreeAwareSelector(
  selector: HrcSelector
): selector is Extract<HrcSelector, { kind: 'target' | 'scope' }> {
  if (selector.kind !== 'target' && selector.kind !== 'scope') return false
  return safeRoleName(selector.scopeRef) === undefined
}

function sessionRefsEqual(left: string, right: string): boolean {
  try {
    const leftParts = splitSessionRef(left)
    const rightParts = splitSessionRef(right)
    return (
      leftParts.scopeRef === rightParts.scopeRef &&
      laneIdsEqual(leftParts.laneRef, rightParts.laneRef)
    )
  } catch {
    return left === right
  }
}

function laneIdsEqual(left: string, right: string): boolean {
  return normalizeLaneId(left) === normalizeLaneId(right)
}

function normalizeLaneId(laneRef: string): string {
  const laneId = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  return laneId === 'default' ? 'main' : laneId
}

function safeRoleName(scopeRef: string): string | undefined {
  try {
    return parseScopeRef(scopeRef).roleName
  } catch {
    return undefined
  }
}

function partsFromSession(
  state: HrcMonitorState,
  session: HrcMonitorSessionState | undefined
): ResolvedParts | null {
  if (!session) {
    return null
  }

  const runtime = resolveRuntimeFor(state, session.hostSessionId, session.runtimeId)

  return runtime ? { session, runtime } : null
}

function resolveRuntimeFor(
  state: HrcMonitorState,
  hostSessionId: string,
  preferredRuntimeId?: string | undefined
): HrcMonitorRuntimeState | undefined {
  return (
    (preferredRuntimeId
      ? state.runtimes.find((candidate) => candidate.runtimeId === preferredRuntimeId)
      : undefined) ??
    state.runtimes.filter((candidate) => candidate.hostSessionId === hostSessionId).at(-1)
  )
}

function partsFromRuntime(
  state: HrcMonitorState,
  runtime: HrcMonitorRuntimeState
): ResolvedParts | null {
  const session = state.sessions.find(
    (candidate) => candidate.hostSessionId === runtime.hostSessionId
  )
  return session ? { session, runtime } : null
}

function partsFromMessage(
  state: HrcMonitorState,
  message: HrcMonitorMessageState
): ResolvedParts | null {
  const session =
    (message.hostSessionId
      ? state.sessions.find((candidate) => candidate.hostSessionId === message.hostSessionId)
      : undefined) ??
    (message.sessionRef ? latestSessionBySessionRef(state, message.sessionRef) : undefined)

  if (!session) {
    return null
  }

  const runtime = resolveRuntimeFor(state, session.hostSessionId, message.runtimeId)

  return runtime ? { session, runtime } : null
}

function latestSessionBySessionRef(
  state: HrcMonitorState,
  sessionRef: string
): HrcMonitorSessionState | undefined {
  return selectLatestSession(state.sessions.filter((session) => session.sessionRef === sessionRef))
}

function selectLatestSession(
  sessions: HrcMonitorSessionState[]
): HrcMonitorSessionState | undefined {
  return sessions.reduce<HrcMonitorSessionState | undefined>((latest, candidate) => {
    if (!latest) {
      return candidate
    }

    const latestActive = latest.status === 'active'
    const candidateActive = candidate.status === 'active'
    if (latestActive !== candidateActive) {
      return candidateActive ? candidate : latest
    }

    return candidate.generation >= latest.generation ? candidate : latest
  }, undefined)
}

function snapshotState(
  state: HrcMonitorState,
  selector?: HrcSelector | undefined
): HrcMonitorSnapshot {
  const resolved = selector ? resolveSelectorWithParts(state, selector) : undefined
  const resolution = resolved?.resolution
  const parts = resolved && isResolution(resolved.resolution) ? resolved.parts : null
  const matches =
    selector?.kind === 'target' || selector?.kind === 'scope'
      ? roleTreeParts(state, selector).map(toMatchedRuntime)
      : undefined

  return {
    kind: 'monitor.snapshot',
    ...(selector ? { selector: selectorView(selector) } : {}),
    eventHighWaterSeq: resolveHighWater(state),
    ...(state.daemon ? { daemon: state.daemon } : {}),
    ...(state.socket ? { socket: state.socket } : {}),
    ...(state.tmux ? { tmux: state.tmux } : {}),
    counts: {
      sessions: state.sessionGlobalCount ?? state.sessions.length,
      runtimes: state.runtimeGlobalCount ?? state.runtimes.length,
    },
    ...(parts ? { session: parts.session, runtime: parts.runtime } : {}),
    ...(resolution ? { resolution } : {}),
    ...(matches ? { matches } : {}),
  }
}

async function* watchEvents(
  state: HrcMonitorState,
  request: HrcMonitorWatchRequest
): AsyncIterable<HrcMonitorEvent | Record<string, unknown>> {
  const selector = request.selector
  const follow = request.follow === true

  if (follow) {
    const snapshot = snapshotState(state, selector)
    yield {
      seq: snapshot.eventHighWaterSeq,
      event: 'monitor.snapshot',
      replayed: false,
      snapshot,
    }
  }

  const matching = state.events.filter((event) =>
    selector ? eventMatchesSelector(state, event, selector) : true
  )
  const fromSeq = request.fromSeq
  const replay =
    fromSeq !== undefined
      ? matching.filter(
          (event) =>
            event.seq >= fromSeq ||
            (request.includeCorrelatedMessageResponses === true && selector
              ? isCorrelatedMessageResponse(event, selector)
              : false)
        )
      : follow
        ? []
        : matching.slice(-(request.replayTail ?? DEFAULT_REPLAY_TAIL))

  for (const event of replay) {
    yield {
      ...event,
      replayed: true,
    }
  }
}

export function monitorEventMatchesSelector(
  state: HrcMonitorState,
  event: HrcMonitorEvent,
  selector: HrcSelector
): boolean {
  switch (selector.kind) {
    case 'stable':
    case 'session':
      return event.sessionRef === selector.sessionRef
    case 'target': {
      if (event.sessionRef && sessionRefsEqual(event.sessionRef, selector.sessionRef)) return true
      if (!event.scopeRef || !isImmediateRoleChildScopeRef(selector.scopeRef, event.scopeRef)) {
        return false
      }
      const selectorLane = splitSessionRef(selector.sessionRef).laneRef
      const eventLane =
        event.laneRef ?? (event.sessionRef ? splitSessionRef(event.sessionRef).laneRef : undefined)
      return eventLane !== undefined && laneIdsEqual(eventLane, selectorLane)
    }
    case 'scope':
      return (
        event.scopeRef === selector.scopeRef ||
        (event.scopeRef !== undefined &&
          isImmediateRoleChildScopeRef(selector.scopeRef, event.scopeRef))
      )
    case 'concrete':
    case 'host':
      return event.hostSessionId === selector.hostSessionId
    case 'runtime':
      return event.runtimeId === selector.runtimeId
    case 'message':
      return (
        event.messageId === selector.messageId ||
        messageEventMatches(state, event, selector.messageId)
      )
    case 'message-seq':
      return (
        event.messageSeq === selector.messageSeq ||
        messageSeqEventMatches(state, event, selector.messageSeq)
      )
  }
}

const eventMatchesSelector = monitorEventMatchesSelector

/**
 * Projected message-correlation fields read off an event, used by the shared
 * `selectorMatchesMessageResponse` predicate so the typed (`HrcMonitorEvent`)
 * and the defensively-coerced (`unknownString`) callers can share one rule.
 */
export type MessageResponseProjection = {
  messageId?: string | undefined
  replyToMessageId?: string | undefined
  rootMessageId?: string | undefined
  messageSeq?: number | undefined
}

/**
 * Single definition of the msg:/seq: correlation rule. Shared between the
 * monitor reader (typed access) and the condition engine (coerced access) so
 * the 3-field-OR / messageSeq-equality predicate cannot drift between modules.
 */
export function selectorMatchesMessageResponse(
  selector: HrcSelector,
  projection: MessageResponseProjection
): boolean {
  switch (selector.kind) {
    case 'message':
      return (
        projection.messageId === selector.messageId ||
        projection.replyToMessageId === selector.messageId ||
        projection.rootMessageId === selector.messageId
      )
    case 'message-seq':
      return projection.messageSeq === selector.messageSeq
    default:
      return false
  }
}

function isCorrelatedMessageResponse(event: HrcMonitorEvent, selector: HrcSelector): boolean {
  if (event.event !== 'message.response') {
    return false
  }

  return selectorMatchesMessageResponse(selector, {
    messageId: event.messageId,
    replyToMessageId: event.replyToMessageId,
    rootMessageId: event.rootMessageId,
    messageSeq: event.messageSeq,
  })
}

function messageEventMatches(
  state: HrcMonitorState,
  event: HrcMonitorEvent,
  messageId: string
): boolean {
  const message = state.messages?.find((candidate) => candidate.messageId === messageId)
  if (!message) {
    return false
  }
  if (event.replyToMessageId !== undefined) {
    return event.replyToMessageId === message.messageId
  }
  if (event.rootMessageId !== undefined) {
    return (
      event.rootMessageId === message.rootMessageId || event.rootMessageId === message.messageId
    )
  }
  if (event.messageId !== undefined) {
    return event.messageId === message.messageId
  }
  if (event.messageSeq !== undefined) {
    return event.messageSeq === message.messageSeq
  }

  return event.runtimeId === message.runtimeId || event.turnId === message.runId
}

function messageSeqEventMatches(
  state: HrcMonitorState,
  event: HrcMonitorEvent,
  messageSeq: number
): boolean {
  const message = state.messages?.find((candidate) => candidate.messageSeq === messageSeq)
  return message ? messageEventMatches(state, event, message.messageId) : false
}

function selectorView(selector: HrcSelector): HrcMonitorResolvedSelector {
  return {
    kind: selector.kind,
    canonical: formatSelector(selector),
  }
}

function highWaterSeq(events: HrcMonitorEvent[]): number {
  return events.reduce((max, event) => Math.max(max, event.seq), 0)
}

/**
 * Resolve the event high-water mark, honoring an explicit global override
 * (T-04232) when present so a filtered `events[]` subset does not collapse the
 * cursor to the last matching event.
 */
function resolveHighWater(state: HrcMonitorState): number {
  return state.eventGlobalHighWaterSeq ?? highWaterSeq(state.events)
}

/**
 * Negative discriminator for the `HrcMonitorResolutionResult` tagged union:
 * `true` when `result` is the `{ ok: false, error }` error arm. Lives with the
 * union so the `'ok' in result` check is defined exactly once; positive
 * narrowing to `HrcMonitorResolution`/`HrcMonitorCapture` stays per-caller.
 */
export function isResolutionError(
  result: HrcMonitorResolutionResult
): result is ReturnType<typeof createHrcError> & { ok: false } {
  return 'ok' in result && result.ok === false
}

function isResolution(result: HrcMonitorResolutionResult): result is HrcMonitorResolution {
  return !isResolutionError(result)
}

// Enforces a *silent* read-only contract on `streamCursorSeq`: reads return the
// captured cursor, while writes and re-`defineProperty` are swallowed WITHOUT
// throwing — even under strict mode. This silent-rejection semantics cannot be
// reproduced by `Object.defineProperty({ writable: false })`, which throws a
// TypeError on strict-mode assignment/redefine and reports a different property
// descriptor. The exact observable behavior is pinned by
// `__tests__/monitor-stream-cursor.char.test.ts` (T-04718 / F5); do not swap the
// mechanism without re-proving equivalence against that characterization test.
function protectStreamCursor(
  capture: HrcMonitorCapture,
  streamCursorSeq: number
): HrcMonitorCapture {
  return new Proxy(capture, {
    get(target, property, receiver) {
      if (property === 'streamCursorSeq') {
        return streamCursorSeq
      }
      return Reflect.get(target, property, receiver)
    },
    set(target, property, value, receiver) {
      if (property === 'streamCursorSeq') {
        return true
      }
      return Reflect.set(target, property, value, receiver)
    },
    defineProperty(target, property, descriptor) {
      if (property === 'streamCursorSeq') {
        return true
      }
      return Reflect.defineProperty(target, property, descriptor)
    },
  })
}

function notFound(selector: HrcSelector): ReturnType<typeof createHrcError> & { ok: false } {
  const detail = notFoundDetail(selector)
  return {
    ok: false,
    ...createHrcError(detail.code, `unknown ${detail.label} "${detail.id}"`, {
      selectorKind: selector.kind,
      [detail.field]: detail.id,
    }),
  }
}

function notFoundDetail(selector: HrcSelector): {
  code: HrcErrorCode
  label: string
  field: string
  id: string | number
} {
  switch (selector.kind) {
    case 'runtime':
      return {
        code: HrcErrorCode.UNKNOWN_RUNTIME,
        label: 'runtime',
        field: 'runtimeId',
        id: selector.runtimeId,
      }
    case 'host':
    case 'concrete':
      return {
        code: HrcErrorCode.UNKNOWN_HOST_SESSION,
        label: 'host session',
        field: 'hostSessionId',
        id: selector.hostSessionId,
      }
    case 'message':
      return {
        code: HrcErrorCode.UNKNOWN_SESSION,
        label: 'message',
        field: 'messageId',
        id: selector.messageId,
      }
    case 'message-seq':
      return {
        code: HrcErrorCode.UNKNOWN_SESSION,
        label: 'message sequence',
        field: 'messageSeq',
        id: selector.messageSeq,
      }
    case 'scope':
      return {
        code: HrcErrorCode.UNKNOWN_SESSION,
        label: 'scope',
        field: 'scopeRef',
        id: selector.scopeRef,
      }
    case 'stable':
    case 'target':
    case 'session':
      return {
        code: HrcErrorCode.UNKNOWN_SESSION,
        label: 'session',
        field: 'sessionRef',
        id: selector.sessionRef,
      }
  }
}
