import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  HrcBadRequestError,
  HrcDomainError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  createHrcError,
  httpStatusForErrorCode,
  resolveTmuxSocketPath,
} from 'hrc-core'
import type {
  HrcEventEnvelope,
  HrcHttpError,
  HrcLaunchRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { readSpoolEntries } from 'hrc-launch'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  type RestartStyle,
  type TmuxManager as ServerTmuxManager,
  type TmuxManagerOptions,
  type TmuxPaneState,
  createTmuxManager,
} from './tmux.js'

type ResolveSessionRequest = {
  sessionRef: string
}

type ResolveSessionResponse = {
  hostSessionId: string
  generation: number
  created: boolean
  session: HrcSessionRecord
}

type EnsureRuntimeRequest = {
  hostSessionId: string
  intent: HrcRuntimeIntent
  restartStyle?: RestartStyle | undefined
}

type EnsureRuntimeResponse = {
  runtimeId: string
  hostSessionId: string
  transport: 'tmux'
  status: string
  tmux: {
    sessionId: string
    windowId: string
    paneId: string
  }
}

type CaptureResponse = {
  text: string
}

type AttachDescriptorResponse = {
  transport: 'tmux'
  argv: string[]
}

type RuntimeActionResponse = {
  ok: true
  hostSessionId: string
  runtimeId: string
}

type FollowSubscriber = (event: HrcEventEnvelope) => void

type LaunchLifecyclePayload = {
  hostSessionId: string
  timestamp?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
  exitCode?: number | undefined
  signal?: string | undefined
}

type HookEnvelope = {
  launchId: string
  hostSessionId: string
  generation: number
  runtimeId?: string | undefined
  hookData: unknown
}

type SessionRow = {
  host_session_id: string
  scope_ref: string
  lane_ref: string
  generation: number
  status: string
  prior_host_session_id: string | null
  created_at: string
  updated_at: string
  parsed_scope_json: string | null
  ancestor_scope_refs_json: string
  last_applied_intent_json: string | null
  continuation_json: string | null
}

const NDJSON_HEADERS = {
  'content-type': 'application/x-ndjson; charset=utf-8',
}

export type HrcServerOptions = {
  runtimeRoot: string
  stateRoot: string
  socketPath: string
  lockPath: string
  spoolDir: string
  dbPath: string
  tmuxSocketPath?: string | undefined
}

export type HrcServer = {
  stop(): Promise<void>
}

export type TmuxManager = ServerTmuxManager
export { createTmuxManager }
export type { RestartStyle, TmuxManagerOptions }

class HrcServerInstance implements HrcServer {
  private readonly followSubscribers = new Set<FollowSubscriber>()
  private readonly server: Bun.Server<undefined>
  private stopping = false

  constructor(
    private readonly options: HrcServerOptions,
    private readonly db: HrcDatabase,
    private readonly tmux: ServerTmuxManager
  ) {
    this.server = Bun.serve({
      unix: options.socketPath,
      fetch: (request) => this.handleRequest(request),
    })
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return
    }

    this.stopping = true
    this.server.stop(true)
    this.followSubscribers.clear()
    this.db.close()
    await Promise.allSettled([
      unlinkIfExists(this.options.lockPath),
      unlinkIfExists(this.options.socketPath),
    ])
  }

  private async handleRequest(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url)
      const pathname = url.pathname

      if (request.method === 'POST' && pathname === '/v1/sessions/resolve') {
        return await this.handleResolveSession(request)
      }

      if (request.method === 'GET' && pathname === '/v1/sessions') {
        return this.handleListSessions(url)
      }

      if (request.method === 'GET' && pathname.startsWith('/v1/sessions/by-host/')) {
        const hostSessionId = pathname.slice('/v1/sessions/by-host/'.length)
        return this.handleGetSessionByHost(hostSessionId)
      }

      if (request.method === 'GET' && pathname === '/v1/events') {
        return this.handleEvents(url, request)
      }

      if (request.method === 'POST' && pathname === '/v1/runtimes/ensure') {
        return await this.handleEnsureRuntime(request)
      }

      if (request.method === 'GET' && pathname === '/v1/capture') {
        return await this.handleCapture(url)
      }

      if (request.method === 'GET' && pathname === '/v1/attach') {
        return this.handleAttach(url)
      }

      if (request.method === 'POST' && pathname === '/v1/interrupt') {
        return await this.handleInterrupt(request)
      }

      if (request.method === 'POST' && pathname === '/v1/terminate') {
        return await this.handleTerminate(request)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/wrapper-started')
      ) {
        const launchId = pathname
          .slice('/v1/internal/launches/'.length)
          .replace('/wrapper-started', '')
        return await this.handleWrapperStarted(launchId, request)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/child-started')
      ) {
        const launchId = pathname
          .slice('/v1/internal/launches/'.length)
          .replace('/child-started', '')
        return await this.handleChildStarted(launchId, request)
      }

      if (
        request.method === 'POST' &&
        pathname.startsWith('/v1/internal/launches/') &&
        pathname.endsWith('/exited')
      ) {
        const launchId = pathname.slice('/v1/internal/launches/'.length).replace('/exited', '')
        return await this.handleExited(launchId, request)
      }

      if (request.method === 'POST' && pathname === '/v1/internal/hooks/ingest') {
        return await this.handleHookIngest(request)
      }

      return new Response('Not Found', { status: 404 })
    } catch (error) {
      return errorResponse(error)
    }
  }

  private async handleResolveSession(request: Request): Promise<Response> {
    const body = await parseJsonBody(request)
    const parsed = parseResolveSessionRequest(body)
    const existing = findContinuitySession(this.db, parsed.sessionRef)
    if (existing) {
      const event = this.appendEvent(existing, 'session.resolved', {
        created: false,
      })
      this.notifyEvent(event)

      return json({
        hostSessionId: existing.hostSessionId,
        generation: existing.generation,
        created: false,
        session: existing,
      } satisfies ResolveSessionResponse)
    }

    const now = timestamp()
    const { scopeRef, laneRef } = parseSessionRef(parsed.sessionRef)
    const hostSessionId = createHostSessionId()
    const session: HrcSessionRecord = {
      hostSessionId,
      scopeRef,
      laneRef,
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    }

    const createdSession = this.db.sessions.create(session)
    this.db.continuities.upsert({
      scopeRef,
      laneRef,
      activeHostSessionId: hostSessionId,
      updatedAt: now,
    })

    const event = this.appendEvent(createdSession, 'session.created', {
      created: true,
    })
    this.notifyEvent(event)

    return json({
      hostSessionId,
      generation: createdSession.generation,
      created: true,
      session: createdSession,
    } satisfies ResolveSessionResponse)
  }

  private handleListSessions(url: URL): Response {
    const scopeRef = normalizeOptionalQuery(url.searchParams.get('scopeRef'))
    const laneRef = normalizeOptionalQuery(url.searchParams.get('laneRef'))

    const rows = scopeRef
      ? this.listSessionsByScope(scopeRef, laneRef)
      : this.listAllSessions(laneRef)

    return json(rows)
  }

  private handleGetSessionByHost(hostSessionId: string): Response {
    const session = this.db.sessions.findByHostSessionId(hostSessionId)
    if (!session) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_HOST_SESSION,
        `unknown host session "${hostSessionId}"`,
        { hostSessionId }
      )
    }

    return json(session)
  }

  private handleEvents(url: URL, request: Request): Response {
    const fromSeq = parseFromSeq(url.searchParams.get('fromSeq'))
    const follow = url.searchParams.get('follow') === 'true'
    const events = this.db.events.listFromSeq(fromSeq)

    if (!follow) {
      return new Response(events.map(serializeEvent).join(''), {
        status: 200,
        headers: NDJSON_HEADERS,
      })
    }

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        for (const event of events) {
          controller.enqueue(encodeNdjson(event))
        }

        const subscriber: FollowSubscriber = (event) => {
          if (event.seq >= fromSeq) {
            controller.enqueue(encodeNdjson(event))
          }
        }

        this.followSubscribers.add(subscriber)
        const close = () => {
          this.followSubscribers.delete(subscriber)
          try {
            controller.close()
          } catch {
            // Stream may already be closed by Bun on disconnect.
          }
        }

        request.signal.addEventListener('abort', close, { once: true })
      },
      cancel: () => undefined,
    })

    return new Response(stream, {
      status: 200,
      headers: NDJSON_HEADERS,
    })
  }

  private async handleEnsureRuntime(request: Request): Promise<Response> {
    const body = parseEnsureRuntimeRequest(await parseJsonBody(request))
    const session = requireSession(this.db, body.hostSessionId)
    const intent = body.intent
    validateEnsureRuntimeIntent(intent)

    const existingRuntime = findLatestRuntime(this.db, session.hostSessionId)
    const restartStyle = body.restartStyle ?? 'reuse_pty'

    let tmuxPane: TmuxPaneState
    let runtime: HrcRuntimeSnapshot
    let eventKind = 'runtime.created'

    if (restartStyle === 'reuse_pty' && existingRuntime?.tmuxJson) {
      const inspected = await this.tmux.inspectSession(getTmuxSessionName(existingRuntime))
      if (inspected) {
        tmuxPane = inspected
        const now = timestamp()
        runtime =
          this.db.runtimes.update(existingRuntime.runtimeId, {
            status: 'ready',
            tmuxJson: toTmuxJson(tmuxPane),
            updatedAt: now,
            lastActivityAt: now,
          }) ?? existingRuntime
        eventKind = 'runtime.ensured'
        this.db.sessions.updateIntent(session.hostSessionId, intent, now)
        const event = this.db.events.append({
          ts: now,
          hostSessionId: session.hostSessionId,
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
          generation: session.generation,
          runtimeId: runtime.runtimeId,
          source: 'hrc',
          eventKind,
          eventJson: {
            restartStyle,
            tmux: simplifyTmuxJson(runtime.tmuxJson),
          },
        })
        this.notifyEvent(event)
        return json(toEnsureRuntimeResponse(runtime))
      }
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    } else {
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    }

    const now = timestamp()
    const harness = deriveHarness(intent)
    const tmuxJson = toTmuxJson(tmuxPane)

    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    if (existingRuntime) {
      this.db.runtimes.updateStatus(existingRuntime.runtimeId, 'terminated', now)
    }

    runtime = this.db.runtimes.create({
      runtimeId: `rt-${randomUUID()}`,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      harness,
      provider: intent.harness.provider,
      status: 'ready',
      tmuxJson,
      supportsInflightInput: false,
      adopted: false,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const event = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind,
      eventJson: {
        restartStyle,
        tmux: simplifyTmuxJson(runtime.tmuxJson),
      },
    })
    this.notifyEvent(event)

    return json(toEnsureRuntimeResponse(runtime))
  }

  private async handleCapture(url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = requireRuntime(this.db, runtimeId)
    const tmux = requireTmuxPane(runtime)
    const text = await this.tmux.capture(tmux.paneId)

    this.db.runtimes.updateActivity(runtime.runtimeId, timestamp(), timestamp())

    return json({
      text,
    } satisfies CaptureResponse)
  }

  private handleAttach(url: URL): Response {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = requireRuntime(this.db, runtimeId)
    const tmux = requireTmuxPane(runtime)

    return json({
      transport: 'tmux',
      argv: this.tmux.getAttachDescriptor(tmux.sessionName).argv,
    } satisfies AttachDescriptorResponse)
  }

  private async handleInterrupt(request: Request): Promise<Response> {
    const body = parseRuntimeActionBody(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    const session = requireSession(this.db, runtime.hostSessionId)
    const tmux = requireTmuxPane(runtime)

    await this.tmux.interrupt(tmux.paneId)

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)
    const event = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'runtime.interrupted',
      eventJson: {
        paneId: tmux.paneId,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
    } satisfies RuntimeActionResponse)
  }

  private async handleTerminate(request: Request): Promise<Response> {
    const body = parseRuntimeActionBody(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    const session = requireSession(this.db, runtime.hostSessionId)
    const tmux = requireTmuxPane(runtime)

    await this.tmux.terminate(tmux.sessionName)

    const now = timestamp()
    this.db.runtimes.updateStatus(runtime.runtimeId, 'terminated', now)
    const event = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'runtime.terminated',
      eventJson: {
        sessionName: tmux.sessionName,
      },
    })
    this.notifyEvent(event)

    return json({
      ok: true,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
    } satisfies RuntimeActionResponse)
  }

  private async handleWrapperStarted(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'wrapper-started')
    const session = requireSession(this.db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()

    const launch = upsertLaunch(this.db, launchId, session, {
      status: 'wrapper_started',
      wrapperPid: body.wrapperPid,
      wrapperStartedAt: now,
      updatedAt: now,
    })

    const event = this.appendEvent(session, 'launch.wrapper_started', {
      launchId,
      wrapperPid: launch.wrapperPid,
    })
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleChildStarted(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'child-started')
    const session = requireSession(this.db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()

    upsertLaunch(this.db, launchId, session, {
      status: 'child_started',
      childPid: body.childPid,
      childStartedAt: now,
      updatedAt: now,
    })

    const event = this.appendEvent(session, 'launch.child_started', {
      launchId,
      childPid: body.childPid,
    })
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleExited(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'exited')
    const session = requireSession(this.db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()

    upsertLaunch(this.db, launchId, session, {
      status: 'exited',
      exitedAt: now,
      exitCode: body.exitCode,
      signal: body.signal,
      updatedAt: now,
    })

    const event = this.appendEvent(session, 'launch.exited', {
      launchId,
      exitCode: body.exitCode,
      signal: body.signal,
    })
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleHookIngest(request: Request): Promise<Response> {
    const envelope = parseHookEnvelope(await parseJsonBody(request))
    const session = requireSession(this.db, envelope.hostSessionId)
    const event = this.db.events.append({
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: envelope.runtimeId,
      source: 'hook',
      eventKind: 'hook.ingested',
      eventJson: {
        launchId: envelope.launchId,
        hookData: envelope.hookData,
      },
    })

    this.notifyEvent(event)
    return json({ ok: true })
  }

  private appendEvent(
    session: HrcSessionRecord,
    eventKind: string,
    eventJson: Record<string, unknown>
  ): HrcEventEnvelope {
    return this.db.events.append({
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      source: 'hrc',
      eventKind,
      eventJson,
    })
  }

  private notifyEvent(event: HrcEventEnvelope): void {
    for (const subscriber of this.followSubscribers) {
      subscriber(event)
    }
  }

  private listSessionsByScope(scopeRef: string, laneRef?: string): HrcSessionRecord[] {
    if (laneRef) {
      return this.db.sessions.listByScopeRef(scopeRef, laneRef)
    }

    return this.db.sessions.listByScopeRef(scopeRef)
  }

  private listAllSessions(laneRef?: string): HrcSessionRecord[] {
    const sql = laneRef
      ? `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        WHERE lane_ref = ?
        ORDER BY scope_ref ASC, generation ASC
      `
      : `
        SELECT
          host_session_id,
          scope_ref,
          lane_ref,
          generation,
          status,
          prior_host_session_id,
          created_at,
          updated_at,
          parsed_scope_json,
          ancestor_scope_refs_json,
          last_applied_intent_json,
          continuation_json
        FROM sessions
        ORDER BY scope_ref ASC, lane_ref ASC, generation ASC
      `

    const rows = laneRef
      ? this.db.sqlite.query<SessionRow, [string]>(sql).all(laneRef)
      : this.db.sqlite.query<SessionRow, []>(sql).all()

    return rows.map(mapSessionRow)
  }
}

export async function createHrcServer(options: HrcServerOptions): Promise<HrcServer> {
  await prepareFilesystem(options)
  await acquireServerLock(options)

  try {
    const tmux = createTmuxManager({
      socketPath: options.tmuxSocketPath ?? resolveTmuxSocketPath(),
    })
    await tmux.initialize()
    const db = openHrcDatabase(options.dbPath)
    await replaySpool(options, db)
    return new HrcServerInstance(options, db, tmux)
  } catch (error) {
    await Promise.allSettled([
      unlinkIfExists(options.lockPath),
      unlinkIfExists(options.socketPath),
      unlinkIfExists(options.tmuxSocketPath ?? resolveTmuxSocketPath()),
    ])
    throw error
  }
}

async function prepareFilesystem(options: HrcServerOptions): Promise<void> {
  await Promise.all([
    mkdir(options.runtimeRoot, { recursive: true }),
    mkdir(options.stateRoot, { recursive: true }),
    mkdir(options.spoolDir, { recursive: true }),
    mkdir(dirname(options.socketPath), { recursive: true }),
    mkdir(dirname(options.lockPath), { recursive: true }),
    mkdir(dirname(options.dbPath), { recursive: true }),
    mkdir(dirname(options.tmuxSocketPath ?? resolveTmuxSocketPath()), { recursive: true }),
  ])
}

async function acquireServerLock(options: HrcServerOptions): Promise<void> {
  const currentPid = process.pid
  const existingPid = await readLockPid(options.lockPath)

  if (existingPid !== null) {
    if (isLiveProcess(existingPid)) {
      throw new Error(`hrc server already running with lock ${options.lockPath}`)
    }

    await Promise.allSettled([unlinkIfExists(options.lockPath), unlinkIfExists(options.socketPath)])
  } else {
    await unlinkIfExists(options.socketPath)
  }

  await writeFile(options.lockPath, String(currentPid), 'utf-8')
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = await readFile(lockPath, 'utf-8')
    const pid = Number.parseInt(raw.trim(), 10)
    return Number.isFinite(pid) ? pid : null
  } catch {
    return null
  }
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function replaySpool(options: HrcServerOptions, db: HrcDatabase): Promise<void> {
  let launchIds: string[]
  try {
    launchIds = (await readdir(options.spoolDir)).sort()
  } catch {
    return
  }

  for (const launchId of launchIds) {
    const launchDir = join(options.spoolDir, launchId)
    const launchDirStat = await stat(launchDir).catch(() => null)
    if (!launchDirStat?.isDirectory()) {
      continue
    }

    const entries = await readSpoolEntries(options.spoolDir, launchId)
    for (const entry of entries) {
      await replaySpoolEntry(db, entry.payload)
      await unlinkIfExists(entry.path)
    }

    await rm(launchDir, { recursive: true, force: true })
  }
}

async function replaySpoolEntry(db: HrcDatabase, payload: unknown): Promise<void> {
  if (!isRecord(payload)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'spool entry must be an object')
  }

  const endpoint = payload['endpoint']
  const replayPayload = payload['payload']
  if (typeof endpoint !== 'string') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'spool entry endpoint must be a string'
    )
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/wrapper-started')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/wrapper-started', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'wrapper-started')
    const session = requireSession(db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'wrapper_started',
      wrapperPid: body.wrapperPid,
      wrapperStartedAt: now,
      updatedAt: now,
    })
    db.events.append({
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      source: 'hrc',
      eventKind: 'launch.wrapper_started',
      eventJson: { launchId, wrapperPid: body.wrapperPid, replayed: true },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/child-started')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/child-started', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'child-started')
    const session = requireSession(db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'child_started',
      childPid: body.childPid,
      childStartedAt: now,
      updatedAt: now,
    })
    db.events.append({
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      source: 'hrc',
      eventKind: 'launch.child_started',
      eventJson: { launchId, childPid: body.childPid, replayed: true },
    })
    return
  }

  if (endpoint.startsWith('/v1/internal/launches/') && endpoint.endsWith('/exited')) {
    const launchId = endpoint.slice('/v1/internal/launches/'.length).replace('/exited', '')
    const body = parseLaunchLifecyclePayload(replayPayload, 'exited')
    const session = requireSession(db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()
    upsertLaunch(db, launchId, session, {
      status: 'exited',
      exitedAt: now,
      exitCode: body.exitCode,
      signal: body.signal,
      updatedAt: now,
    })
    db.events.append({
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      source: 'hrc',
      eventKind: 'launch.exited',
      eventJson: { launchId, exitCode: body.exitCode, signal: body.signal, replayed: true },
    })
    return
  }

  if (endpoint === '/v1/internal/hooks/ingest') {
    const envelope = parseHookEnvelope(replayPayload)
    const session = requireSession(db, envelope.hostSessionId)
    db.events.append({
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: envelope.generation,
      runtimeId: envelope.runtimeId,
      source: 'hook',
      eventKind: 'hook.ingested',
      eventJson: {
        launchId: envelope.launchId,
        hookData: envelope.hookData,
        replayed: true,
      },
    })
    return
  }

  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    `unsupported spool endpoint "${endpoint}"`,
    { endpoint }
  )
}

function parseResolveSessionRequest(input: unknown): ResolveSessionRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const sessionRef = input['sessionRef']
  if (typeof sessionRef !== 'string' || sessionRef.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'sessionRef is required', {
      field: 'sessionRef',
    })
  }

  parseSessionRef(sessionRef)
  return { sessionRef: sessionRef.trim() }
}

function parseEnsureRuntimeRequest(input: unknown): EnsureRuntimeRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  const intent = input['intent']
  if (!isRecord(intent)) {
    throw new HrcUnprocessableEntityError(HrcErrorCode.MISSING_RUNTIME_INTENT, 'intent is required')
  }

  const restartStyle = input['restartStyle']
  if (restartStyle !== undefined && restartStyle !== 'reuse_pty' && restartStyle !== 'fresh_pty') {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'restartStyle must be "reuse_pty" or "fresh_pty"'
    )
  }

  return {
    hostSessionId: hostSessionId.trim(),
    intent: intent as HrcRuntimeIntent,
    restartStyle,
  }
}

function validateEnsureRuntimeIntent(intent: HrcRuntimeIntent): void {
  if (!isRecord(intent.harness)) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'intent.harness is required'
    )
  }

  if (intent.harness.interactive !== true) {
    throw new HrcRuntimeUnavailableError(
      'ensureRuntime supports only interactive runtimes in phase 1'
    )
  }
}

function deriveHarness(intent: HrcRuntimeIntent): HrcRuntimeSnapshot['harness'] {
  return intent.harness.provider === 'openai' ? 'codex-cli' : 'claude-code'
}

function toTmuxJson(tmuxPane: TmuxPaneState): Record<string, unknown> {
  return {
    socketPath: tmuxPane.socketPath,
    sessionName: tmuxPane.sessionName,
    windowName: tmuxPane.windowName,
    sessionId: tmuxPane.sessionId,
    windowId: tmuxPane.windowId,
    paneId: tmuxPane.paneId,
  }
}

function simplifyTmuxJson(tmuxJson: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!tmuxJson) {
    return {}
  }

  return {
    sessionId: tmuxJson['sessionId'],
    windowId: tmuxJson['windowId'],
    paneId: tmuxJson['paneId'],
  }
}

function toEnsureRuntimeResponse(runtime: HrcRuntimeSnapshot): EnsureRuntimeResponse {
  const tmux = requireTmuxPane(runtime)
  return {
    runtimeId: runtime.runtimeId,
    hostSessionId: runtime.hostSessionId,
    transport: 'tmux',
    status: runtime.status,
    tmux: {
      sessionId: tmux.sessionId,
      windowId: tmux.windowId,
      paneId: tmux.paneId,
    },
  }
}

function findLatestRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot | null {
  const runtimes = db.runtimes
    .listByHostSessionId(hostSessionId)
    .filter((runtime) => runtime.transport === 'tmux')
  return runtimes.at(-1) ?? null
}

function getTmuxSessionName(runtime: HrcRuntimeSnapshot): string {
  return requireTmuxPane(runtime).sessionName
}

function parseRuntimeIdQuery(url: URL): string {
  const runtimeId = normalizeOptionalQuery(url.searchParams.get('runtimeId'))
  if (!runtimeId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required')
  }
  return runtimeId
}

function parseRuntimeActionBody(input: unknown): { runtimeId: string } {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const runtimeId = input['runtimeId']
  if (typeof runtimeId !== 'string' || runtimeId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }

  return {
    runtimeId: runtimeId.trim(),
  }
}

function parseSessionRef(sessionRef: string): { scopeRef: string; laneRef: string } {
  const normalized = sessionRef.trim()
  const parts = normalized.split('/')
  if (parts.length !== 2 || !parts[1]?.startsWith('lane:')) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must use "<scopeRef>/lane:<laneRef>" format',
      { sessionRef }
    )
  }

  const scopeRef = parts[0]?.trim() ?? ''
  const laneRef = parts[1].slice('lane:'.length).trim()
  if (scopeRef.length === 0 || laneRef.length === 0) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'sessionRef must include scopeRef and laneRef',
      { sessionRef }
    )
  }

  return { scopeRef, laneRef }
}

function findContinuitySession(db: HrcDatabase, sessionRef: string): HrcSessionRecord | null {
  const { scopeRef, laneRef } = parseSessionRef(sessionRef)
  const continuity = db.continuities.findByRef(scopeRef, laneRef)
  if (!continuity) {
    return null
  }

  return db.sessions.findByHostSessionId(continuity.activeHostSessionId)
}

function requireSession(db: HrcDatabase, hostSessionId: string): HrcSessionRecord {
  const session = db.sessions.findByHostSessionId(hostSessionId)
  if (!session) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_HOST_SESSION,
      `unknown host session "${hostSessionId}"`,
      { hostSessionId }
    )
  }

  return session
}

function requireRuntime(db: HrcDatabase, runtimeId: string): HrcRuntimeSnapshot {
  const runtime = db.runtimes.findById(runtimeId)
  if (!runtime) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_RUNTIME, `unknown runtime "${runtimeId}"`, {
      runtimeId,
    })
  }

  if (runtime.status === 'terminated') {
    throw new HrcRuntimeUnavailableError(`runtime "${runtimeId}" is terminated`, { runtimeId })
  }

  return runtime
}

function requireTmuxPane(runtime: HrcRuntimeSnapshot): TmuxPaneState {
  const sessionName = runtime.tmuxJson?.['sessionName']
  const sessionId = runtime.tmuxJson?.['sessionId']
  const windowId = runtime.tmuxJson?.['windowId']
  const paneId = runtime.tmuxJson?.['paneId']
  const socketPath = runtime.tmuxJson?.['socketPath']

  if (
    typeof sessionName !== 'string' ||
    typeof sessionId !== 'string' ||
    typeof windowId !== 'string' ||
    typeof paneId !== 'string' ||
    typeof socketPath !== 'string'
  ) {
    throw new HrcRuntimeUnavailableError(`runtime "${runtime.runtimeId}" is missing tmux state`, {
      runtimeId: runtime.runtimeId,
    })
  }

  return {
    socketPath,
    sessionName,
    windowName: 'main',
    sessionId,
    windowId,
    paneId,
  }
}

function upsertLaunch(
  db: HrcDatabase,
  launchId: string,
  session: HrcSessionRecord,
  patch: Partial<HrcLaunchRecord> & { updatedAt: string; status: string }
): HrcLaunchRecord {
  const existing = db.launches.findById(launchId)
  if (existing) {
    return db.launches.update(launchId, patch) ?? existing
  }

  const now = patch.updatedAt
  const created = db.launches.create({
    launchId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    harness: 'claude-code',
    provider: 'anthropic',
    launchArtifactPath: '',
    status: patch.status,
    createdAt: now,
    updatedAt: now,
    ...(patch.wrapperPid !== undefined ? { wrapperPid: patch.wrapperPid } : {}),
    ...(patch.childPid !== undefined ? { childPid: patch.childPid } : {}),
    ...(patch.wrapperStartedAt !== undefined ? { wrapperStartedAt: patch.wrapperStartedAt } : {}),
    ...(patch.childStartedAt !== undefined ? { childStartedAt: patch.childStartedAt } : {}),
    ...(patch.exitedAt !== undefined ? { exitedAt: patch.exitedAt } : {}),
    ...(patch.exitCode !== undefined ? { exitCode: patch.exitCode } : {}),
    ...(patch.signal !== undefined ? { signal: patch.signal } : {}),
  })

  return created
}

function parseLaunchLifecyclePayload(
  input: unknown,
  kind: 'wrapper-started' | 'child-started' | 'exited'
): LaunchLifecyclePayload {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }

  const base: LaunchLifecyclePayload = {
    hostSessionId: hostSessionId.trim(),
  }

  if (typeof input['timestamp'] === 'string' && input['timestamp'].trim().length > 0) {
    base.timestamp = input['timestamp']
  }

  if (kind === 'wrapper-started') {
    const wrapperPid = input['wrapperPid']
    if (typeof wrapperPid === 'number') {
      base.wrapperPid = wrapperPid
    }
  }

  if (kind === 'child-started') {
    const childPid = input['childPid']
    if (typeof childPid === 'number') {
      base.childPid = childPid
    }
  }

  if (kind === 'exited') {
    const exitCode = input['exitCode']
    const signal = input['signal']
    if (typeof exitCode === 'number') {
      base.exitCode = exitCode
    }
    if (typeof signal === 'string' && signal.trim().length > 0) {
      base.signal = signal
    }
  }

  return base
}

function parseHookEnvelope(input: unknown): HookEnvelope {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const launchId = input['launchId']
  const hostSessionId = input['hostSessionId']
  const generation = input['generation']
  if (
    typeof launchId !== 'string' ||
    typeof hostSessionId !== 'string' ||
    typeof generation !== 'number'
  ) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'hook envelope requires launchId, hostSessionId, and generation'
    )
  }

  return {
    launchId,
    hostSessionId,
    generation,
    runtimeId: typeof input['runtimeId'] === 'string' ? input['runtimeId'] : undefined,
    hookData: input['hookData'],
  }
}

async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be valid JSON')
  }
}

function parseFromSeq(raw: string | null): number {
  if (raw === null || raw.trim().length === 0) {
    return 1
  }

  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'fromSeq must be >= 1')
  }

  return parsed
}

function normalizeOptionalQuery(value: string | null): string | undefined {
  if (value === null) {
    return undefined
  }

  const normalized = value.trim()
  return normalized.length > 0 ? normalized : undefined
}

function mapSessionRow(row: SessionRow): HrcSessionRecord {
  return {
    hostSessionId: row.host_session_id,
    scopeRef: row.scope_ref,
    laneRef: row.lane_ref,
    generation: row.generation,
    status: row.status,
    priorHostSessionId: row.prior_host_session_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parsedScopeJson: parseJsonValue<Record<string, unknown>>(row.parsed_scope_json),
    ancestorScopeRefs: parseJsonValue<string[]>(row.ancestor_scope_refs_json) ?? [],
    lastAppliedIntentJson: parseJsonValue(row.last_applied_intent_json),
    continuation: parseJsonValue(row.continuation_json),
  }
}

function parseJsonValue<T>(value: string | null): T | undefined {
  if (value === null) {
    return undefined
  }

  return JSON.parse(value) as T
}

function encodeNdjson(event: HrcEventEnvelope): Uint8Array {
  return new TextEncoder().encode(serializeEvent(event))
}

function serializeEvent(event: HrcEventEnvelope): string {
  return `${JSON.stringify(event)}\n`
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status })
}

function errorResponse(error: unknown): Response {
  if (error instanceof HrcDomainError) {
    return Response.json(error.toResponse(), { status: error.status })
  }

  const internal = toInternalError(error)
  return Response.json(internal, {
    status: httpStatusForErrorCode(internal.error.code),
  })
}

function toInternalError(error: unknown): HrcHttpError {
  if (error instanceof HrcInternalError) {
    return error.toResponse()
  }

  return createHrcError(HrcErrorCode.INTERNAL_ERROR, 'internal server error', {
    cause: error instanceof Error ? error.message : String(error),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createHostSessionId(): string {
  return `hsid-${randomUUID()}`
}

function timestamp(): string {
  return new Date().toISOString()
}

async function unlinkIfExists(path: string): Promise<void> {
  await rm(path, { force: true })
}
