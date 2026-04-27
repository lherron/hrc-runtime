import { type LaneRef, formatScopeHandle, formatSessionHandle, parseScopeRef } from 'agent-scope'
import { CliUsageError } from 'cli-kit'
import {
  type HrcLifecycleEvent,
  type HrcMessageRecord,
  type HrcMonitorMessageState,
  type HrcMonitorRuntimeState,
  type HrcMonitorSessionState,
  type HrcMonitorSnapshot,
  type HrcMonitorState,
  type HrcRuntimeSnapshot,
  type HrcSelector,
  type HrcStatusResponse,
  createMonitorReader,
  parseSelector,
} from 'hrc-core'
import { HrcClient, discoverSocket } from 'hrc-sdk'
import { openHrcDatabase } from 'hrc-store-sqlite'

type MonitorShowOptions = {
  json: boolean
  selectorInput?: string | undefined
}

type MonitorShowJson = {
  kind: 'monitor.snapshot'
  selector?: {
    input: string
    canonical: string
    kind: string
  }
  daemon: {
    status: 'healthy'
    socketPath: string
    startedAt: string
    uptime: number
    apiVersion?: string | undefined
  }
  socket: {
    path: string
    responsive: true
  }
  eventLog: {
    highWaterSeq: number
  }
  tmux: {
    status: 'available' | 'unavailable'
    available: boolean
    version?: string | undefined
  }
  counts: {
    sessions: number
    runtimes: number
  }
  scope?: {
    scopeRef: string
    scopeHandle: string
  }
  session?: {
    scopeRef: string
    scopeHandle: string
    sessionRef: string
    sessionHandle: string
    hostSessionId: string
    generation: number
    laneRef: string
    status: string
    activeTurnId?: string | null | undefined
  }
  runtime?: HrcMonitorRuntimeState | undefined
}

class MonitorInfrastructureError extends Error {
  readonly exitCode = 3
}

export async function cmdMonitorShow(args: string[]): Promise<void> {
  const options = parseMonitorShowArgs(args)
  let selector: HrcSelector | undefined

  if (options.selectorInput !== undefined) {
    try {
      selector = parseSelector(options.selectorInput)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new CliUsageError(`invalid selector: ${message}`)
    }
  }

  try {
    const snapshot = await readMonitorSnapshot(selector)
    assertSelectorResolved(snapshot)
    const rendered = toMonitorShowJson(snapshot, options)

    if (options.json) {
      process.stdout.write(`${JSON.stringify(rendered, null, 2)}\n`)
      return
    }

    process.stdout.write(renderMonitorShowText(rendered))
  } catch (error) {
    if (error instanceof CliUsageError) {
      throw error
    }
    const message = error instanceof Error ? error.message : String(error)
    const infrastructureError =
      error instanceof MonitorInfrastructureError
        ? error
        : new MonitorInfrastructureError(`snapshot read failed: ${message}`)
    process.stderr.write(`hrc: ${infrastructureError.message}\n`)
    process.exit(infrastructureError.exitCode)
  }
}

function parseMonitorShowArgs(args: string[]): MonitorShowOptions {
  let json = false
  let selectorInput: string | undefined

  for (const arg of args) {
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      continue
    }
    if (arg.startsWith('-')) {
      throw new CliUsageError(`unknown option: ${arg}`)
    }
    if (selectorInput !== undefined) {
      throw new CliUsageError('monitor show accepts at most one selector')
    }
    selectorInput = arg
  }

  return { json, selectorInput }
}

async function readMonitorSnapshot(
  selector?: HrcSelector | undefined
): Promise<HrcMonitorSnapshot> {
  const socketPath = discoverSocket()
  const client = new HrcClient(socketPath)

  let status: HrcStatusResponse
  try {
    status = (await client.getStatus()) as HrcStatusResponse
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new MonitorInfrastructureError(`daemon unavailable on ${socketPath}: ${message}`)
  }

  const state = await buildMonitorState(status, client)
  return createMonitorReader(state).snapshot(selector)
}

async function buildMonitorState(
  status: HrcStatusResponse,
  client: HrcClient
): Promise<HrcMonitorState> {
  const runtimes = await client.listRuntimes()
  const messages = await readMessages(client)
  const events = readEvents(status.dbPath)
  const tmux = status.capabilities.backend.tmux

  return {
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
    tmux: {
      available: tmux.available,
      status: tmux.available ? 'available' : 'unavailable',
      ...(tmux.version ? { version: tmux.version } : {}),
    },
    sessions: status.sessions.map(toMonitorSession),
    runtimes: runtimes.map(toMonitorRuntime),
    messages,
    events,
  }
}

async function readMessages(client: HrcClient): Promise<HrcMonitorMessageState[]> {
  const response = await client.listMessages({ order: 'asc', limit: 10_000 })
  return response.messages.map(toMonitorMessage)
}

function readEvents(dbPath: string): HrcMonitorState['events'] {
  const db = openHrcDatabase(dbPath)
  try {
    return db.hrcEvents.listFromHrcSeq(1).map(toMonitorEvent)
  } finally {
    db.close()
  }
}

function toMonitorSession(entry: HrcStatusResponse['sessions'][number]): HrcMonitorSessionState {
  const session = entry.session
  const activeRuntime = entry.activeRuntime?.runtime
  return {
    sessionRef: sessionRefFor(session.scopeRef, session.laneRef),
    scopeRef: session.scopeRef,
    laneRef: laneIdForSessionRef(session.laneRef),
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    ...(activeRuntime?.runtimeId ? { runtimeId: activeRuntime.runtimeId } : {}),
    status: session.status,
    activeTurnId: activeRuntime?.activeRunId ?? null,
  }
}

function toMonitorRuntime(runtime: HrcRuntimeSnapshot): HrcMonitorRuntimeState {
  return {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    status: runtime.status,
    transport: runtime.transport,
    activeTurnId: runtime.activeRunId ?? null,
  }
}

function toMonitorMessage(message: HrcMessageRecord): HrcMonitorMessageState {
  return {
    messageId: message.messageId,
    messageSeq: message.messageSeq,
    ...(message.execution.sessionRef ? { sessionRef: message.execution.sessionRef } : {}),
    ...(message.execution.hostSessionId ? { hostSessionId: message.execution.hostSessionId } : {}),
    ...(message.execution.runtimeId ? { runtimeId: message.execution.runtimeId } : {}),
    ...(message.execution.runId ? { runId: message.execution.runId } : {}),
  }
}

function toMonitorEvent(event: HrcLifecycleEvent): HrcMonitorState['events'][number] {
  return {
    seq: event.hrcSeq,
    ts: event.ts,
    event: event.eventKind,
    sessionRef: sessionRefFor(event.scopeRef, event.laneRef),
    scopeRef: event.scopeRef,
    laneRef: laneIdForSessionRef(event.laneRef),
    hostSessionId: event.hostSessionId,
    generation: event.generation,
    ...(event.runtimeId ? { runtimeId: event.runtimeId } : {}),
    ...(event.runId ? { turnId: event.runId } : {}),
    payload: event.payload,
  }
}

function assertSelectorResolved(snapshot: HrcMonitorSnapshot): void {
  const resolution = snapshot.resolution
  if (resolution && 'ok' in resolution && resolution.ok === false) {
    throw new CliUsageError(resolution.error.message)
  }
}

function toMonitorShowJson(
  snapshot: HrcMonitorSnapshot,
  options: MonitorShowOptions
): MonitorShowJson {
  const session = snapshot.session
  const scopeRef = session?.scopeRef ?? resolutionScopeRef(snapshot)
  const scopeHandle = scopeRef ? formatScopeHandle(parseScopeRef(scopeRef)) : undefined
  const sessionRef = session ? sessionRefFor(session.scopeRef, session.laneRef) : undefined
  const sessionHandle = session
    ? formatSessionHandle({
        scopeRef: session.scopeRef,
        laneRef: laneRefForHandle(session.laneRef),
      })
    : undefined
  const daemon = snapshot.daemon as MonitorShowJson['daemon']
  const socket = snapshot.socket as MonitorShowJson['socket']
  const tmux = snapshot.tmux as MonitorShowJson['tmux']
  const selectorCanonical = scopeRef ? `scope:${scopeRef}` : snapshot.selector?.canonical

  return {
    kind: 'monitor.snapshot',
    ...(options.selectorInput && selectorCanonical
      ? {
          selector: {
            input: options.selectorInput,
            canonical: selectorCanonical,
            kind: snapshot.selector?.kind ?? 'scope',
          },
        }
      : {}),
    daemon,
    socket,
    eventLog: {
      highWaterSeq: snapshot.eventHighWaterSeq,
    },
    tmux,
    counts: snapshot.counts,
    ...(scopeRef && scopeHandle ? { scope: { scopeRef, scopeHandle } } : {}),
    ...(session && sessionRef && sessionHandle && scopeHandle
      ? {
          session: {
            scopeRef: session.scopeRef,
            scopeHandle,
            sessionRef,
            sessionHandle,
            hostSessionId: session.hostSessionId,
            generation: session.generation,
            laneRef: session.laneRef,
            status: session.status,
            activeTurnId: session.activeTurnId ?? null,
          },
        }
      : {}),
    ...(snapshot.runtime ? { runtime: snapshot.runtime } : {}),
  }
}

function resolutionScopeRef(snapshot: HrcMonitorSnapshot): string | undefined {
  const resolution = snapshot.resolution
  if (!resolution || !isMonitorResolutionOk(resolution)) {
    return undefined
  }
  return resolution.scopeRef
}

function isMonitorResolutionOk(
  resolution: NonNullable<HrcMonitorSnapshot['resolution']>
): resolution is Exclude<NonNullable<HrcMonitorSnapshot['resolution']>, { ok: false }> {
  return !('ok' in resolution && resolution.ok === false)
}

function renderMonitorShowText(snapshot: MonitorShowJson): string {
  const lines: string[] = []
  lines.push('HRC Monitor Snapshot')
  if (snapshot.selector) {
    lines.push(`  selector: ${snapshot.selector.input}`)
  }
  lines.push(`  daemon: ${snapshot.daemon.status}`)
  lines.push(
    `  socket: ${snapshot.socket.path} (${snapshot.socket.responsive ? 'responsive' : 'down'})`
  )
  lines.push(`  event-log high-water: ${snapshot.eventLog.highWaterSeq}`)
  lines.push(`  tmux: ${snapshot.tmux.status}`)
  lines.push(`  sessions: ${snapshot.counts.sessions}`)
  lines.push(`  runtimes: ${snapshot.counts.runtimes}`)

  if (snapshot.scope) {
    lines.push('')
    lines.push(`  scope: ${snapshot.scope.scopeHandle}`)
    lines.push(`  scopeRef: ${snapshot.scope.scopeRef}`)
  }

  if (snapshot.session) {
    lines.push(`  session: ${snapshot.session.sessionHandle}`)
    lines.push(`  sessionRef: ${snapshot.session.sessionRef}`)
    lines.push(`  hostSessionId: ${snapshot.session.hostSessionId}`)
    lines.push(`  generation: ${snapshot.session.generation}`)
    lines.push(`  status: ${snapshot.session.status}`)
  }

  if (snapshot.runtime) {
    lines.push(`  runtime: ${snapshot.runtime.runtimeId}`)
    lines.push(`  runtimeStatus: ${snapshot.runtime.status}`)
    lines.push(`  transport: ${snapshot.runtime.transport}`)
  }

  return `${lines.join('\n')}\n`
}

function sessionRefFor(scopeRef: string, laneRef: string): string {
  return `${scopeRef}/lane:${laneIdForSessionRef(laneRef)}`
}

function laneIdForSessionRef(laneRef: string): string {
  const laneId = laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef
  return laneId === 'default' ? 'main' : laneId
}

function laneRefForHandle(laneRef: string): LaneRef {
  const laneId = laneIdForSessionRef(laneRef)
  return laneId === 'main' ? 'main' : `lane:${laneId}`
}
