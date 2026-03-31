import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  buildCliInvocation,
  deliverSdkInflightInput,
  getSdkInflightCapability,
  runSdkTurn,
} from 'hrc-adapter-agent-spaces'
import {
  HrcBadRequestError,
  HrcConflictError,
  HrcDomainError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
  HrcRuntimeUnavailableError,
  HrcUnprocessableEntityError,
  createHrcError,
  httpStatusForErrorCode,
  validateFence,
} from 'hrc-core'
import type {
  HrcEventEnvelope,
  HrcFence,
  HrcHttpError,
  HrcLaunchRecord,
  HrcProvider,
  HrcRunRecord,
  HrcRuntimeIntent,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
} from 'hrc-core'
import { readSpoolEntries, writeLaunchArtifact } from 'hrc-launch'
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
  supportsInFlightInput: boolean
  tmux: {
    sessionId: string
    windowId: string
    paneId: string
  }
}

type DispatchTurnRequest = {
  hostSessionId: string
  prompt: string
  fences?: HrcFence | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
}

type DispatchTurnResponse = {
  runId: string
  hostSessionId: string
  generation: number
  runtimeId: string
  transport: 'sdk' | 'tmux'
  status: 'completed' | 'started'
  supportsInFlightInput: boolean
}

type InFlightInputRequest = {
  runtimeId: string
  runId: string
  prompt: string
  inputType?: string | undefined
}

type InFlightInputResponse = {
  accepted: boolean
  runtimeId: string
  runId: string
  pendingTurns?: number | undefined
}

type ClearContextRequest = {
  hostSessionId: string
  relaunch?: boolean | undefined
}

type ClearContextResponse = {
  hostSessionId: string
  generation: number
  priorHostSessionId: string
}

type CaptureResponse = {
  text: string
}

type AttachDescriptorResponse = {
  transport: 'tmux'
  argv: string[]
  bindingFence: {
    hostSessionId: string
    runtimeId: string
    generation: number
    windowId?: string | undefined
    tabId?: string | undefined
    paneId?: string | undefined
  }
}

type RuntimeActionResponse = {
  ok: true
  hostSessionId: string
  runtimeId: string
}

type BindSurfaceRequest = {
  surfaceKind: string
  surfaceId: string
  runtimeId: string
  hostSessionId: string
  generation: number
  windowId?: string | undefined
  tabId?: string | undefined
  paneId?: string | undefined
}

type UnbindSurfaceRequest = {
  surfaceKind: string
  surfaceId: string
  reason?: string | undefined
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

      if (request.method === 'POST' && pathname === '/v1/turns') {
        return await this.handleDispatchTurn(request)
      }

      if (request.method === 'POST' && pathname === '/v1/in-flight-input') {
        return await this.handleInFlightInput(request)
      }

      if (request.method === 'GET' && pathname === '/v1/capture') {
        return await this.handleCapture(url)
      }

      if (request.method === 'GET' && pathname === '/v1/attach') {
        return this.handleAttach(url)
      }

      if (request.method === 'POST' && pathname === '/v1/surfaces/bind') {
        return await this.handleBindSurface(request)
      }

      if (request.method === 'POST' && pathname === '/v1/surfaces/unbind') {
        return await this.handleUnbindSurface(request)
      }

      if (request.method === 'GET' && pathname === '/v1/surfaces') {
        return this.handleListSurfaces(url)
      }

      if (request.method === 'POST' && pathname === '/v1/interrupt') {
        return await this.handleInterrupt(request)
      }

      if (request.method === 'POST' && pathname === '/v1/terminate') {
        return await this.handleTerminate(request)
      }

      if (request.method === 'POST' && pathname === '/v1/clear-context') {
        return await this.handleClearContext(request)
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
    const runtime = await this.ensureRuntimeForSession(
      session,
      body.intent,
      body.restartStyle ?? 'reuse_pty'
    )
    return json(toEnsureRuntimeResponse(runtime))
  }

  private async handleDispatchTurn(request: Request): Promise<Response> {
    const body = parseDispatchTurnRequest(await parseJsonBody(request))
    const requestedSession = requireSession(this.db, body.hostSessionId)
    const continuity = requireContinuity(this.db, requestedSession)
    const activeSession = requireSession(this.db, continuity.activeHostSessionId)
    const fence = validateFence(body.fences, {
      activeHostSessionId: activeSession.hostSessionId,
      generation: activeSession.generation,
    })

    if (!fence.ok) {
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, fence.message, fence.detail)
    }

    const session = requireSession(this.db, fence.resolvedHostSessionId)
    const runId = `run-${randomUUID()}`
    const intent = normalizeDispatchIntent(
      body.runtimeIntent ?? session.lastAppliedIntentJson,
      session,
      runId
    )

    if (shouldUseSdkTransport(intent)) {
      return await this.handleSdkDispatchTurn(session, intent, body.prompt, runId)
    }

    const runtime = requireLatestRuntime(this.db, session.hostSessionId)
    assertRuntimeNotBusy(this.db, runtime)

    const launchId = `launch-${randomUUID()}`
    const now = timestamp()
    const launchesDir = join(this.options.runtimeRoot, 'launches')
    const cliInvocation = await buildDispatchInvocation(intent)
    const launchArtifactPath = join(launchesDir, `${launchId}.json`)
    const launchArtifact = {
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      runId,
      harness: runtime.harness,
      provider: runtime.provider,
      argv: cliInvocation.argv,
      env: cliInvocation.env,
      cwd: cliInvocation.cwd,
      callbackSocketPath: this.options.socketPath,
      spoolDir: this.options.spoolDir,
      correlationEnv: extractCorrelationEnv(cliInvocation.env),
    } satisfies Parameters<typeof writeLaunchArtifact>[0]

    const run = this.db.runs.create({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })
    this.db.runtimes.update(runtime.runtimeId, {
      activeRunId: run.runId,
      launchId,
      status: 'busy',
      lastActivityAt: now,
      updatedAt: now,
    })

    await writeLaunchArtifact(launchArtifact, launchesDir)

    this.db.launches.create({
      launchId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      harness: runtime.harness,
      provider: runtime.provider,
      launchArtifactPath,
      tmuxJson: runtime.tmuxJson,
      status: 'accepted',
      createdAt: now,
      updatedAt: now,
    })

    const acceptedEvent = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'turn.accepted',
      eventJson: {
        launchId,
        promptLength: body.prompt.length,
      },
    })
    this.notifyEvent(acceptedEvent)

    const tmuxPane = requireTmuxPane(runtime)
    await this.tmux.sendKeys(tmuxPane.paneId, buildLaunchCommand(launchArtifactPath))

    const startedAt = timestamp()
    this.db.runs.update(runId, {
      status: 'started',
      startedAt,
      updatedAt: startedAt,
    })
    this.db.runtimes.updateActivity(runtime.runtimeId, startedAt, startedAt)

    const startedEvent = this.db.events.append({
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'turn.started',
      eventJson: {
        launchId,
      },
    })
    this.notifyEvent(startedEvent)

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: false,
    } satisfies DispatchTurnResponse)
  }

  private async handleInFlightInput(request: Request): Promise<Response> {
    const body = parseInFlightInputRequest(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    const session = requireSession(this.db, runtime.hostSessionId)

    if (runtime.transport !== 'sdk' || runtime.supportsInflightInput !== true) {
      throw this.appendInflightRejected(
        session,
        runtime.runtimeId,
        body.runId,
        'semantic in-flight input is unsupported for this runtime',
        body.prompt,
        body.inputType,
        new HrcUnprocessableEntityError(
          HrcErrorCode.INFLIGHT_UNSUPPORTED,
          'semantic in-flight input is unsupported for this runtime',
          {
            runtimeId: runtime.runtimeId,
            transport: runtime.transport,
            supportsInflightInput: runtime.supportsInflightInput,
          }
        )
      )
    }

    const activeRun =
      runtime.activeRunId !== undefined ? this.db.runs.findById(runtime.activeRunId) : null
    const latestRun = findLatestRunForRuntime(this.db, runtime.runtimeId)
    const expectedRunId = activeRun?.runId ?? latestRun?.runId

    if (!expectedRunId || expectedRunId !== body.runId) {
      throw this.appendInflightRejected(
        session,
        runtime.runtimeId,
        body.runId,
        'run mismatch for semantic in-flight input',
        body.prompt,
        body.inputType,
        new HrcConflictError(
          HrcErrorCode.RUN_MISMATCH,
          'run mismatch for semantic in-flight input',
          {
            runtimeId: runtime.runtimeId,
            expectedRunId,
            actualRunId: body.runId,
          }
        )
      )
    }

    const delivered =
      activeRun && isRunActive(activeRun)
        ? await deliverSdkInflightInput({
            hostSessionId: runtime.hostSessionId,
            runId: body.runId,
            runtimeId: runtime.runtimeId,
            prompt: body.prompt,
            scopeRef: runtime.scopeRef,
            laneRef: runtime.laneRef,
            generation: runtime.generation,
          })
        : { accepted: true, pendingTurns: 0 }

    const now = timestamp()
    this.db.runtimes.updateActivity(runtime.runtimeId, now, now)

    const acceptedEvent = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId: body.runId,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'inflight.accepted',
      eventJson: {
        prompt: body.prompt,
        ...(body.inputType ? { inputType: body.inputType } : {}),
        ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
      },
    })
    this.notifyEvent(acceptedEvent)

    return json({
      accepted: delivered.accepted,
      runtimeId: runtime.runtimeId,
      runId: body.runId,
      ...(delivered.pendingTurns !== undefined ? { pendingTurns: delivered.pendingTurns } : {}),
    } satisfies InFlightInputResponse)
  }

  private async handleClearContext(request: Request): Promise<Response> {
    const body = parseClearContextRequest(await parseJsonBody(request))
    const session = requireSession(this.db, body.hostSessionId)
    const continuity = requireContinuity(this.db, session)
    if (continuity.activeHostSessionId !== session.hostSessionId) {
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'host session is no longer active', {
        expectedHostSessionId: session.hostSessionId,
        activeHostSessionId: continuity.activeHostSessionId,
      })
    }

    const now = timestamp()
    const nextSession: HrcSessionRecord = {
      hostSessionId: createHostSessionId(),
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation + 1,
      status: 'active',
      priorHostSessionId: session.hostSessionId,
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: session.ancestorScopeRefs,
      ...(session.lastAppliedIntentJson
        ? { lastAppliedIntentJson: session.lastAppliedIntentJson }
        : {}),
      ...(session.continuation ? { continuation: session.continuation } : {}),
    }

    this.db.sessions.updateStatus(session.hostSessionId, 'archived', now)
    this.db.sessions.create(nextSession)
    this.db.continuities.upsert({
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      activeHostSessionId: nextSession.hostSessionId,
      updatedAt: now,
    })

    const clearedEvent = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      source: 'hrc',
      eventKind: 'context.cleared',
      eventJson: {
        nextHostSessionId: nextSession.hostSessionId,
        relaunch: body.relaunch === true,
      },
    })
    this.notifyEvent(clearedEvent)

    const createdEvent = this.db.events.append({
      ts: now,
      hostSessionId: nextSession.hostSessionId,
      scopeRef: nextSession.scopeRef,
      laneRef: nextSession.laneRef,
      generation: nextSession.generation,
      source: 'hrc',
      eventKind: 'session.created',
      eventJson: {
        created: true,
        priorHostSessionId: session.hostSessionId,
      },
    })
    this.notifyEvent(createdEvent)

    if (body.relaunch === true) {
      const relaunchIntent = nextSession.lastAppliedIntentJson
      if (!relaunchIntent) {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.MISSING_RUNTIME_INTENT,
          'cannot relaunch without a prior runtime intent'
        )
      }
      await this.ensureRuntimeForSession(nextSession, relaunchIntent, 'fresh_pty')
    }

    return json({
      hostSessionId: nextSession.hostSessionId,
      generation: nextSession.generation,
      priorHostSessionId: session.hostSessionId,
    } satisfies ClearContextResponse)
  }

  private async handleCapture(url: URL): Promise<Response> {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = requireRuntime(this.db, runtimeId)
    const text =
      runtime.transport === 'sdk'
        ? this.db.runtimeBuffers
            .listByRuntimeId(runtime.runtimeId)
            .map((chunk) => chunk.text)
            .join('')
        : await this.tmux.capture(requireTmuxPane(runtime).paneId)

    this.db.runtimes.updateActivity(runtime.runtimeId, timestamp(), timestamp())

    return json({
      text,
    } satisfies CaptureResponse)
  }

  private handleAttach(url: URL): Response {
    const runtimeId = parseRuntimeIdQuery(url)
    const runtime = requireRuntime(this.db, runtimeId)
    if (runtime.transport === 'sdk') {
      throw new HrcRuntimeUnavailableError('attach is only available for tmux runtimes', {
        runtimeId,
        transport: runtime.transport,
      })
    }
    const tmux = requireTmuxPane(runtime)

    return json({
      transport: 'tmux',
      argv: this.tmux.getAttachDescriptor(tmux.sessionName).argv,
      bindingFence: {
        hostSessionId: runtime.hostSessionId,
        runtimeId: runtime.runtimeId,
        generation: runtime.generation,
        windowId: tmux.windowId,
        paneId: tmux.paneId,
      },
    } satisfies AttachDescriptorResponse)
  }

  private async handleBindSurface(request: Request): Promise<Response> {
    const body = parseBindSurfaceRequest(await parseJsonBody(request))
    const runtime = requireRuntime(this.db, body.runtimeId)
    if (runtime.hostSessionId !== body.hostSessionId || runtime.generation !== body.generation) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        'surface bind fence no longer matches runtime state',
        {
          runtimeId: runtime.runtimeId,
          expectedHostSessionId: body.hostSessionId,
          actualHostSessionId: runtime.hostSessionId,
          expectedGeneration: body.generation,
          actualGeneration: runtime.generation,
        }
      )
    }

    const session = requireSession(this.db, runtime.hostSessionId)
    const existing = this.db.surfaceBindings.findBySurface(body.surfaceKind, body.surfaceId)
    if (existing && existing.unboundAt === undefined && existing.runtimeId === runtime.runtimeId) {
      return json(existing)
    }

    const tmuxPane = runtime.transport === 'tmux' ? requireTmuxPane(runtime) : null
    const now = timestamp()
    const binding = this.db.surfaceBindings.bind({
      surfaceKind: body.surfaceKind,
      surfaceId: body.surfaceId,
      hostSessionId: runtime.hostSessionId,
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      windowId: body.windowId ?? tmuxPane?.windowId,
      tabId: body.tabId,
      paneId: body.paneId ?? tmuxPane?.paneId,
      boundAt: now,
    })

    const eventKind =
      existing && existing.unboundAt === undefined ? 'surface.rebound' : 'surface.bound'
    const eventJson: Record<string, unknown> = {
      surfaceKind: binding.surfaceKind,
      surfaceId: binding.surfaceId,
      hostSessionId: binding.hostSessionId,
      runtimeId: binding.runtimeId,
      generation: binding.generation,
      boundAt: binding.boundAt,
      ...(binding.windowId ? { windowId: binding.windowId } : {}),
      ...(binding.tabId ? { tabId: binding.tabId } : {}),
      ...(binding.paneId ? { paneId: binding.paneId } : {}),
    }

    if (eventKind === 'surface.rebound' && existing) {
      eventJson['previousHostSessionId'] = existing.hostSessionId
      eventJson['previousRuntimeId'] = existing.runtimeId
      eventJson['previousGeneration'] = existing.generation
    }

    const event = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind,
      eventJson,
    })
    this.notifyEvent(event)

    return json(binding)
  }

  private async handleUnbindSurface(request: Request): Promise<Response> {
    const body = parseUnbindSurfaceRequest(await parseJsonBody(request))
    const existing = this.db.surfaceBindings.findBySurface(body.surfaceKind, body.surfaceId)
    if (!existing) {
      throw new HrcNotFoundError(
        HrcErrorCode.UNKNOWN_SURFACE,
        `unknown surface binding "${body.surfaceKind}:${body.surfaceId}"`,
        {
          surfaceKind: body.surfaceKind,
          surfaceId: body.surfaceId,
        }
      )
    }

    if (existing.unboundAt !== undefined) {
      return json(existing)
    }

    const session = requireSession(this.db, existing.hostSessionId)
    const now = timestamp()
    const binding = this.db.surfaceBindings.unbind(
      body.surfaceKind,
      body.surfaceId,
      now,
      body.reason
    )
    if (!binding) {
      throw new HrcInternalError('surface binding disappeared during unbind', {
        surfaceKind: body.surfaceKind,
        surfaceId: body.surfaceId,
      })
    }

    const event = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: binding.runtimeId,
      source: 'hrc',
      eventKind: 'surface.unbound',
      eventJson: {
        surfaceKind: binding.surfaceKind,
        surfaceId: binding.surfaceId,
        runtimeId: binding.runtimeId,
        unboundAt: binding.unboundAt,
        ...(binding.reason ? { reason: binding.reason } : {}),
      },
    })
    this.notifyEvent(event)

    return json(binding)
  }

  private handleListSurfaces(url: URL): Response {
    const runtimeId = parseRuntimeIdQuery(url)
    requireRuntime(this.db, runtimeId)
    return json(this.db.surfaceBindings.findByRuntime(runtimeId))
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
    if (launch.runtimeId) {
      this.db.runtimes.update(launch.runtimeId, {
        wrapperPid: launch.wrapperPid,
        launchId,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleChildStarted(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'child-started')
    const session = requireSession(this.db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()

    const launch = upsertLaunch(this.db, launchId, session, {
      status: 'child_started',
      childPid: body.childPid,
      childStartedAt: now,
      updatedAt: now,
    })

    const event = this.appendEvent(session, 'launch.child_started', {
      launchId,
      childPid: body.childPid,
    })
    if (launch.runtimeId) {
      this.db.runtimes.update(launch.runtimeId, {
        childPid: body.childPid,
        status: 'busy',
        updatedAt: now,
        lastActivityAt: now,
      })
    }
    this.notifyEvent(event)
    return json({ ok: true })
  }

  private async handleExited(launchId: string, request: Request): Promise<Response> {
    const body = parseLaunchLifecyclePayload(await parseJsonBody(request), 'exited')
    const session = requireSession(this.db, body.hostSessionId)
    const now = body.timestamp ?? timestamp()

    const launch = upsertLaunch(this.db, launchId, session, {
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
    if (launch.runtimeId) {
      const activeRunId = this.db.runtimes.findById(launch.runtimeId)?.activeRunId
      this.db.runtimes.update(launch.runtimeId, {
        activeRunId: undefined,
        status: 'ready',
        updatedAt: now,
        lastActivityAt: now,
      })
      if (activeRunId) {
        this.db.runs.markCompleted(activeRunId, {
          status: body.exitCode === 0 ? 'completed' : 'failed',
          completedAt: now,
          updatedAt: now,
          ...(body.exitCode === 0
            ? {}
            : {
                errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
                errorMessage: `launch exited with code ${body.exitCode ?? 'unknown'}`,
              }),
        })
      }
    }
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

  private appendInflightRejected(
    session: HrcSessionRecord,
    runtimeId: string,
    runId: string,
    reason: string,
    prompt: string,
    inputType: string | undefined,
    error: HrcDomainError
  ): HrcDomainError {
    const knownRun = this.db.runs.findById(runId)
    const event = this.db.events.append({
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      ...(knownRun ? { runId } : {}),
      runtimeId,
      source: 'hrc',
      eventKind: 'inflight.rejected',
      eventJson: {
        reason,
        requestedRunId: runId,
        prompt,
        ...(inputType ? { inputType } : {}),
      },
    })
    this.notifyEvent(event)
    return error
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

  private async ensureRuntimeForSession(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    restartStyle: RestartStyle
  ): Promise<HrcRuntimeSnapshot> {
    validateEnsureRuntimeIntent(intent)

    const existingRuntime = findLatestRuntime(this.db, session.hostSessionId)
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
        return runtime
      }
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    } else {
      tmuxPane = await this.tmux.ensurePane(session.hostSessionId, restartStyle)
    }

    const now = timestamp()
    const harness = deriveInteractiveHarness(intent.harness.provider)
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

    return runtime
  }

  private async handleSdkDispatchTurn(
    session: HrcSessionRecord,
    intent: HrcRuntimeIntent,
    prompt: string,
    runId: string
  ): Promise<Response> {
    const existingProvider =
      findLatestSessionRuntime(this.db, session.hostSessionId)?.provider ??
      session.continuation?.provider
    const runtimeId = `rt-${randomUUID()}`
    const now = timestamp()

    this.db.sessions.updateIntent(session.hostSessionId, intent, now)

    const runtime = this.db.runtimes.create({
      runtimeId,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'sdk',
      harness: deriveSdkHarness(intent.harness.provider),
      provider: intent.harness.provider,
      status: 'busy',
      continuation: session.continuation,
      supportsInflightInput: getSdkInflightCapability(intent.harness.provider),
      adopted: false,
      activeRunId: runId,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
    })

    const run = this.db.runs.create({
      runId,
      hostSessionId: session.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: 'sdk',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })

    const runtimeCreatedEvent = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'runtime.created',
      eventJson: {
        transport: 'sdk',
        harness: runtime.harness,
      },
    })
    this.notifyEvent(runtimeCreatedEvent)

    const acceptedEvent = this.db.events.append({
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'turn.accepted',
      eventJson: {
        promptLength: prompt.length,
        transport: 'sdk',
      },
    })
    this.notifyEvent(acceptedEvent)

    const startedAt = timestamp()
    this.db.runs.update(run.runId, {
      status: 'started',
      startedAt,
      updatedAt: startedAt,
    })
    this.db.runtimes.updateActivity(runtime.runtimeId, startedAt, startedAt)

    const startedEvent = this.db.events.append({
      ts: startedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'turn.started',
      eventJson: {
        transport: 'sdk',
      },
    })
    this.notifyEvent(startedEvent)

    let chunkSeq = 1
    const result = await runSdkTurn({
      intent,
      hostSessionId: session.hostSessionId,
      runId,
      runtimeId: runtime.runtimeId,
      prompt,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      existingProvider,
      continuation: session.continuation,
      onHrcEvent: (event) => {
        const appended = this.db.events.append(event)
        this.notifyEvent(appended)
        this.db.runtimes.updateActivity(runtime.runtimeId, event.ts, event.ts)
      },
      onBuffer: (text) => {
        this.db.runtimeBuffers.append({
          runtimeId: runtime.runtimeId,
          chunkSeq,
          text,
          createdAt: timestamp(),
        })
        chunkSeq += 1
      },
    })

    const completedAt = timestamp()
    this.db.runs.markCompleted(run.runId, {
      status: result.result.success ? 'completed' : 'failed',
      completedAt,
      updatedAt: completedAt,
      ...(!result.result.success
        ? {
            errorCode:
              result.result.error?.code === 'provider_mismatch'
                ? HrcErrorCode.PROVIDER_MISMATCH
                : HrcErrorCode.RUNTIME_UNAVAILABLE,
            errorMessage: result.result.error?.message ?? 'sdk turn failed',
          }
        : {}),
    })

    this.db.runtimes.update(runtime.runtimeId, {
      status: 'ready',
      lastActivityAt: completedAt,
      updatedAt: completedAt,
      harnessSessionJson: result.harnessSessionJson,
      continuation: result.continuation,
    })
    this.db.runtimes.updateRunId(runtime.runtimeId, undefined, completedAt)

    if (result.continuation) {
      this.db.sessions.updateContinuation(session.hostSessionId, result.continuation, completedAt)
    }

    const completedEvent = this.db.events.append({
      ts: completedAt,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runId,
      runtimeId: runtime.runtimeId,
      source: 'hrc',
      eventKind: 'turn.completed',
      eventJson: {
        success: result.result.success,
        transport: 'sdk',
      },
    })
    this.notifyEvent(completedEvent)

    if (!result.result.success) {
      if (result.result.error?.code === 'provider_mismatch') {
        throw new HrcUnprocessableEntityError(
          HrcErrorCode.PROVIDER_MISMATCH,
          result.result.error.message,
          result.result.error.details ?? {}
        )
      }

      throw new HrcRuntimeUnavailableError(result.result.error?.message ?? 'sdk turn failed', {
        runtimeId: runtime.runtimeId,
        runId,
      })
    }

    return json({
      runId,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      transport: 'sdk',
      status: 'started',
      supportsInFlightInput: runtime.supportsInflightInput,
    } satisfies DispatchTurnResponse)
  }
}

export async function createHrcServer(options: HrcServerOptions): Promise<HrcServer> {
  await prepareFilesystem(options)
  await acquireServerLock(options)

  try {
    const tmux = createTmuxManager({
      socketPath: getTmuxSocketPath(options),
    })
    await tmux.initialize()
    const db = openHrcDatabase(options.dbPath)
    await replaySpool(options, db)
    return new HrcServerInstance(options, db, tmux)
  } catch (error) {
    await Promise.allSettled([
      unlinkIfExists(options.lockPath),
      unlinkIfExists(options.socketPath),
      unlinkIfExists(getTmuxSocketPath(options)),
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
    mkdir(dirname(getTmuxSocketPath(options)), { recursive: true }),
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

function parseDispatchTurnRequest(input: unknown): DispatchTurnRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  const prompt = input['prompt']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }

  const runtimeIntent = input['runtimeIntent']
  const fences = input['fences']

  return {
    hostSessionId: hostSessionId.trim(),
    prompt: prompt.trim(),
    ...(runtimeIntent && isRecord(runtimeIntent)
      ? { runtimeIntent: runtimeIntent as HrcRuntimeIntent }
      : {}),
    ...(fences !== undefined ? { fences: parseFenceInput(fences) } : {}),
  }
}

function parseInFlightInputRequest(input: unknown): InFlightInputRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const runtimeId = input['runtimeId']
  const runId = input['runId']
  const promptValue = typeof input['prompt'] === 'string' ? input['prompt'] : input['input']
  const inputType = input['inputType']

  if (typeof runtimeId !== 'string' || runtimeId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }
  if (typeof runId !== 'string' || runId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runId is required', {
      field: 'runId',
    })
  }
  if (typeof promptValue !== 'string' || promptValue.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'prompt is required', {
      field: 'prompt',
    })
  }
  if (inputType !== undefined && typeof inputType !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'inputType must be a string', {
      field: 'inputType',
    })
  }

  return {
    runtimeId: runtimeId.trim(),
    runId: runId.trim(),
    prompt: promptValue.trim(),
    ...(typeof inputType === 'string' && inputType.trim().length > 0
      ? { inputType: inputType.trim() }
      : {}),
  }
}

function parseClearContextRequest(input: unknown): ClearContextRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const hostSessionId = input['hostSessionId']
  const relaunch = input['relaunch']
  if (typeof hostSessionId !== 'string' || hostSessionId.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'hostSessionId is required', {
      field: 'hostSessionId',
    })
  }
  if (relaunch !== undefined && typeof relaunch !== 'boolean') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'relaunch must be a boolean', {
      field: 'relaunch',
    })
  }

  return {
    hostSessionId: hostSessionId.trim(),
    ...(typeof relaunch === 'boolean' ? { relaunch } : {}),
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

function deriveInteractiveHarness(provider: HrcProvider): HrcRuntimeSnapshot['harness'] {
  return provider === 'openai' ? 'codex-cli' : 'claude-code'
}

function deriveSdkHarness(provider: HrcProvider): HrcRuntimeSnapshot['harness'] {
  return provider === 'openai' ? 'pi-sdk' : 'agent-sdk'
}

function shouldUseSdkTransport(intent: HrcRuntimeIntent): boolean {
  return (
    intent.harness.interactive === false || intent.execution?.preferredMode === 'nonInteractive'
  )
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
    supportsInFlightInput: runtime.supportsInflightInput,
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

function findLatestSessionRuntime(
  db: HrcDatabase,
  hostSessionId: string
): HrcRuntimeSnapshot | null {
  return db.runtimes.listByHostSessionId(hostSessionId).at(-1) ?? null
}

function findLatestRunForRuntime(db: HrcDatabase, runtimeId: string): HrcRunRecord | null {
  return db.runs.listByRuntimeId(runtimeId).at(-1) ?? null
}

function getTmuxSocketPath(options: HrcServerOptions): string {
  return options.tmuxSocketPath ?? join(options.runtimeRoot, 'tmux.sock')
}

function requireLatestRuntime(db: HrcDatabase, hostSessionId: string): HrcRuntimeSnapshot {
  const runtime = findLatestRuntime(db, hostSessionId)
  if (!runtime || runtime.status === 'terminated') {
    throw new HrcRuntimeUnavailableError(`no ready runtime for host session "${hostSessionId}"`, {
      hostSessionId,
    })
  }
  return runtime
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

function parseBindSurfaceRequest(input: unknown): BindSurfaceRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  const surfaceKind = requireTrimmedStringField(input, 'surfaceKind')
  const surfaceId = requireTrimmedStringField(input, 'surfaceId')
  const runtimeId = requireTrimmedStringField(input, 'runtimeId')
  const hostSessionId = requireTrimmedStringField(input, 'hostSessionId')
  const generation = input['generation']
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'generation is required', {
      field: 'generation',
    })
  }

  return {
    surfaceKind,
    surfaceId,
    runtimeId,
    hostSessionId,
    generation,
    ...readOptionalStringField(input, 'windowId'),
    ...readOptionalStringField(input, 'tabId'),
    ...readOptionalStringField(input, 'paneId'),
  }
}

function parseUnbindSurfaceRequest(input: unknown): UnbindSurfaceRequest {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'request body must be an object')
  }

  return {
    surfaceKind: requireTrimmedStringField(input, 'surfaceKind'),
    surfaceId: requireTrimmedStringField(input, 'surfaceId'),
    ...readOptionalStringField(input, 'reason'),
  }
}

function requireTrimmedStringField(input: Record<string, unknown>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} is required`, {
      field,
    })
  }

  return value.trim()
}

function readOptionalStringField(
  input: Record<string, unknown>,
  field: string
): Record<string, string> {
  const value = input[field]
  if (value === undefined) {
    return {}
  }
  if (typeof value !== 'string') {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, `${field} must be a string`, {
      field,
    })
  }

  const trimmed = value.trim()
  return trimmed.length > 0 ? { [field]: trimmed } : {}
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

function requireContinuity(db: HrcDatabase, session: HrcSessionRecord) {
  const continuity = db.continuities.findByRef(session.scopeRef, session.laneRef)
  if (!continuity) {
    throw new HrcNotFoundError(
      HrcErrorCode.UNKNOWN_SESSION,
      `unknown continuity for "${session.scopeRef}/lane:${session.laneRef}"`,
      {
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
      }
    )
  }
  return continuity
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

function parseFenceInput(input: unknown): HrcFence {
  if (!isRecord(input)) {
    throw new HrcBadRequestError(
      HrcErrorCode.INVALID_FENCE,
      'fences must be an object when provided'
    )
  }

  try {
    return {
      ...(typeof input['expectedHostSessionId'] === 'string'
        ? { expectedHostSessionId: input['expectedHostSessionId'].trim() }
        : {}),
      ...(typeof input['expectedGeneration'] === 'number'
        ? { expectedGeneration: input['expectedGeneration'] }
        : {}),
      ...(typeof input['followLatest'] === 'boolean'
        ? { followLatest: input['followLatest'] }
        : {}),
    }
  } catch (error) {
    throw new HrcBadRequestError(HrcErrorCode.INVALID_FENCE, String(error))
  }
}

function normalizeDispatchIntent(
  intent: HrcRuntimeIntent | undefined,
  session: HrcSessionRecord,
  runId: string
): HrcRuntimeIntent {
  if (!intent) {
    throw new HrcUnprocessableEntityError(
      HrcErrorCode.MISSING_RUNTIME_INTENT,
      'runtimeIntent is required when the session has no prior intent'
    )
  }

  const cwd =
    intent.placement?.cwd ??
    intent.placement?.projectRoot ??
    intent.placement?.agentRoot ??
    process.cwd()
  const projectRoot = intent.placement?.projectRoot ?? cwd
  const agentRoot = intent.placement?.agentRoot ?? projectRoot

  return {
    ...intent,
    placement: {
      ...intent.placement,
      agentRoot,
      projectRoot,
      cwd,
      runMode: intent.placement?.runMode ?? 'task',
      bundle: intent.placement?.bundle ?? { kind: 'agent-default' },
      dryRun: intent.placement?.dryRun ?? true,
      correlation: {
        sessionRef: {
          scopeRef: session.scopeRef,
          laneRef: session.laneRef,
        },
        hostSessionId: session.hostSessionId,
        runId,
      },
    },
  }
}

async function buildDispatchInvocation(intent: HrcRuntimeIntent): Promise<{
  argv: string[]
  env: Record<string, string>
  cwd: string
}> {
  let env: Record<string, string> = {}
  let cwd = intent.placement.cwd ?? process.cwd()

  try {
    const invocation = await buildCliInvocation(intent)
    env = invocation.env
    cwd = invocation.cwd
    if (await isLaunchCommandAvailable(invocation.argv[0])) {
      return { argv: invocation.argv, env, cwd }
    }
  } catch {
    // Fall back to the local harness shim when the real CLI invocation cannot be built.
  }

  const shimPath = await findHarnessShimPath()
  if (!shimPath) {
    throw new HrcRuntimeUnavailableError('no interactive harness executable is available')
  }

  return {
    argv: [shimPath],
    env,
    cwd,
  }
}

function buildLaunchCommand(launchArtifactPath: string): string {
  return `bun run ${shellQuote(join(process.cwd(), 'packages/hrc-launch/src/exec.ts'))} --launch-file ${shellQuote(launchArtifactPath)}`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

function extractCorrelationEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => key.startsWith('HRC_') || key.startsWith('AGENT_'))
  )
}

async function isLaunchCommandAvailable(command: string | undefined): Promise<boolean> {
  if (!command) {
    return false
  }
  if (command.includes('/')) {
    const stats = await stat(command).catch(() => null)
    return stats?.isFile() === true
  }

  const pathEntries = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  for (const entry of pathEntries) {
    const candidate = join(entry, command)
    const stats = await stat(candidate).catch(() => null)
    if (stats?.isFile()) {
      return true
    }
  }

  return false
}

async function findHarnessShimPath(): Promise<string | null> {
  const candidates = [
    join(process.cwd(), 'integration-tests/fixtures/hrc-shim/hrc-harness-shim.sh'),
    join(process.cwd(), 'integration-tests/fixtures/hrc-shim/harness'),
  ]

  for (const candidate of candidates) {
    const stats = await stat(candidate).catch(() => null)
    if (stats?.isFile()) {
      return candidate
    }
  }

  return null
}

function assertRuntimeNotBusy(db: HrcDatabase, runtime: HrcRuntimeSnapshot): void {
  if (!runtime.activeRunId) {
    return
  }

  const run = db.runs.findById(runtime.activeRunId)
  if (!run || isRunActive(run)) {
    throw new HrcConflictError(HrcErrorCode.RUNTIME_BUSY, 'runtime already has an active run', {
      runtimeId: runtime.runtimeId,
      activeRunId: runtime.activeRunId,
    })
  }
}

function isRunActive(run: HrcRunRecord): boolean {
  return run.status === 'accepted' || run.status === 'started' || run.status === 'running'
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
