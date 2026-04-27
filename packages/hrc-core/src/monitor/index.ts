import { HrcErrorCode, createHrcError } from '../errors.js'
import { type HrcSelector, formatSelector } from '../selectors.js'

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
  status: string
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
}

export type HrcMonitorWatchRequest = {
  selector?: HrcSelector | undefined
  follow?: boolean | undefined
  fromSeq?: number | undefined
  includeCorrelatedMessageResponses?: boolean | undefined
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
      const capture = resolveSelector(state, selector)
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
  const parts = resolveParts(state, selector)
  if (!parts) {
    return notFound(selector)
  }

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
    eventHighWaterSeq: highWaterSeq(state.events),
  }
}

function resolveParts(state: HrcMonitorState, selector: HrcSelector): ResolvedParts | null {
  switch (selector.kind) {
    case 'stable':
    case 'target':
    case 'session':
      return partsFromSession(state, latestSessionBySessionRef(state, selector.sessionRef))
    case 'scope':
      return partsFromSession(state, latestSessionByScopeRef(state, selector.scopeRef))
    case 'concrete':
      return partsFromSession(
        state,
        state.sessions.find((session) => session.hostSessionId === selector.hostSessionId)
      )
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

function partsFromSession(
  state: HrcMonitorState,
  session: HrcMonitorSessionState | undefined
): ResolvedParts | null {
  if (!session) {
    return null
  }

  const runtime =
    (session.runtimeId
      ? state.runtimes.find((candidate) => candidate.runtimeId === session.runtimeId)
      : undefined) ??
    state.runtimes.filter((candidate) => candidate.hostSessionId === session.hostSessionId).at(-1)

  return runtime ? { session, runtime } : null
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

  const runtime =
    (message.runtimeId
      ? state.runtimes.find((candidate) => candidate.runtimeId === message.runtimeId)
      : undefined) ??
    state.runtimes.filter((candidate) => candidate.hostSessionId === session.hostSessionId).at(-1)

  return runtime ? { session, runtime } : null
}

function latestSessionBySessionRef(
  state: HrcMonitorState,
  sessionRef: string
): HrcMonitorSessionState | undefined {
  return selectLatestSession(state.sessions.filter((session) => session.sessionRef === sessionRef))
}

function latestSessionByScopeRef(
  state: HrcMonitorState,
  scopeRef: string
): HrcMonitorSessionState | undefined {
  return selectLatestSession(state.sessions.filter((session) => session.scopeRef === scopeRef))
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
  const resolution = selector ? resolveSelector(state, selector) : undefined
  const parts =
    resolution && isResolution(resolution) ? resolveParts(state, selector as HrcSelector) : null

  return {
    kind: 'monitor.snapshot',
    ...(selector ? { selector: selectorView(selector) } : {}),
    eventHighWaterSeq: highWaterSeq(state.events),
    ...(state.daemon ? { daemon: state.daemon } : {}),
    ...(state.socket ? { socket: state.socket } : {}),
    ...(state.tmux ? { tmux: state.tmux } : {}),
    counts: {
      sessions: state.sessions.length,
      runtimes: state.runtimes.length,
    },
    ...(parts ? { session: parts.session, runtime: parts.runtime } : {}),
    ...(resolution ? { resolution } : {}),
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
        : matching.slice(-100)

  for (const event of replay) {
    yield {
      ...event,
      replayed: true,
    }
  }
}

function eventMatchesSelector(
  state: HrcMonitorState,
  event: HrcMonitorEvent,
  selector: HrcSelector
): boolean {
  switch (selector.kind) {
    case 'stable':
    case 'target':
    case 'session':
      return event.sessionRef === selector.sessionRef
    case 'scope':
      return event.scopeRef === selector.scopeRef
    case 'concrete':
      return event.hostSessionId === selector.hostSessionId
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

function isCorrelatedMessageResponse(event: HrcMonitorEvent, selector: HrcSelector): boolean {
  if (event.event !== 'message.response') {
    return false
  }

  switch (selector.kind) {
    case 'message':
      return (
        event.messageId === selector.messageId ||
        event.replyToMessageId === selector.messageId ||
        event.rootMessageId === selector.messageId
      )
    case 'message-seq':
      return event.messageSeq === selector.messageSeq
    default:
      return false
  }
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

function isResolution(result: HrcMonitorResolutionResult): result is HrcMonitorResolution {
  return !('ok' in result && result.ok === false)
}

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
