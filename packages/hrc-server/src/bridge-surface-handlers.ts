import { randomUUID } from 'node:crypto'

import {
  HrcBadRequestError,
  HrcConflictError,
  HrcErrorCode,
  HrcInternalError,
  HrcNotFoundError,
} from 'hrc-core'
import type {
  DeliverBridgeResponse,
  HrcLocalBridgeRecord,
  HrcRuntimeSnapshot,
  HrcSessionRecord,
  RegisterBridgeTargetRequest,
  RegisterBridgeTargetResponse,
} from 'hrc-core'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  findActiveBridgesByTarget,
  matchesBridgeBinding,
  mergeBridgeFence,
  validateBridgeFence,
} from './local-bridge-helpers.js'
import {
  requireBridge,
  requireContinuity,
  requireKnownRuntime,
  requireRuntime,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import { requireLatestRuntime } from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { parseRuntimeIdQuery } from './server-misc.js'
import {
  type BridgeTargetRequest,
  type DeliverTextRequest,
  normalizeOptionalQuery,
  parseAttachRuntimeRequest,
  parseBindSurfaceRequest,
  parseBridgeTargetRequest,
  parseCloseBridgeRequest,
  parseDeliverBridgeRequest,
  parseDeliverTextRequest,
  parseJsonBody,
  parseUnbindSurfaceRequest,
} from './server-parsers.js'
import { isRuntimeUnavailableStatus, json, timestamp } from './server-util.js'
import { resolveBridgeTargetSession } from './target-view.js'
import type { TmuxManager as ServerTmuxManager } from './tmux.js'

export async function handleAttachRuntime(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseAttachRuntimeRequest(await parseJsonBody(request))
  const runtime = await this.reconcileTmuxRuntimeLiveness(
    requireKnownRuntime(this.db, body.runtimeId)
  )
  return await this.attachRuntimeEffectfully(runtime)
}

export async function handleBindSurface(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
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

  const tmuxPane =
    runtime.transport === 'tmux' && runtime.controllerKind !== 'harness-broker'
      ? requireTmuxPane(runtime)
      : null
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

  const event = appendHrcEvent(this.db, eventKind, {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: runtime.runtimeId,
    payload: eventJson,
  })
  this.notifyEvent(event)

  return json(binding)
}

export async function handleUnbindSurface(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
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
  const binding = this.db.surfaceBindings.unbind(body.surfaceKind, body.surfaceId, now, body.reason)
  if (!binding) {
    throw new HrcInternalError('surface binding disappeared during unbind', {
      surfaceKind: body.surfaceKind,
      surfaceId: body.surfaceId,
    })
  }

  const event = appendHrcEvent(this.db, 'surface.unbound', {
    ts: now,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    runtimeId: binding.runtimeId,
    payload: {
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

export function handleListSurfaces(this: HrcServerInstanceForHandlers, url: URL): Response {
  const runtimeId = parseRuntimeIdQuery(url)
  const runtime = this.db.runtimes.getByRuntimeId(runtimeId)
  if (!runtime || isRuntimeUnavailableStatus(runtime.status)) {
    return json([])
  }
  return json(this.db.surfaceBindings.findByRuntime(runtimeId))
}

export async function handleRegisterBridgeTarget(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseBridgeTargetRequest(await parseJsonBody(request))
  const session = resolveBridgeTargetSession(this.db, body)
  const continuity = requireContinuity(this.db, session)
  const activeSession = requireSession(this.db, continuity.activeHostSessionId)
  validateBridgeFence(
    {
      ...(body.expectedHostSessionId !== undefined
        ? { expectedHostSessionId: body.expectedHostSessionId }
        : {}),
      ...(body.expectedGeneration !== undefined
        ? { expectedGeneration: body.expectedGeneration }
        : {}),
    },
    activeSession
  )

  const resolvedBinding = await this.resolveBridgeTargetBinding(body, session, activeSession)

  const now = timestamp()
  const matchingBridges = findActiveBridgesByTarget(
    this.db,
    resolvedBinding.transport,
    resolvedBinding.target
  )
  const bindingRequest: RegisterBridgeTargetRequest = {
    hostSessionId: resolvedBinding.hostSessionId,
    transport: resolvedBinding.transport,
    target: resolvedBinding.target,
    ...(resolvedBinding.runtimeId !== undefined ? { runtimeId: resolvedBinding.runtimeId } : {}),
    ...(body.expectedHostSessionId !== undefined
      ? { expectedHostSessionId: body.expectedHostSessionId }
      : {}),
    ...(body.expectedGeneration !== undefined
      ? { expectedGeneration: body.expectedGeneration }
      : {}),
  }
  const reusable = matchingBridges.find((bridge) => matchesBridgeBinding(bridge, bindingRequest))
  if (reusable) {
    return json(this.toBridgeTargetResponse(reusable, resolvedBinding))
  }

  for (const bridge of matchingBridges) {
    this.db.localBridges.close(bridge.bridgeId, now)
  }

  const bridge = this.db.localBridges.create({
    bridgeId: `bridge-${randomUUID()}`,
    hostSessionId: resolvedBinding.hostSessionId,
    ...(resolvedBinding.runtimeId !== undefined ? { runtimeId: resolvedBinding.runtimeId } : {}),
    transport: resolvedBinding.transport,
    target: resolvedBinding.target,
    ...(body.expectedHostSessionId !== undefined
      ? { expectedHostSessionId: body.expectedHostSessionId }
      : {}),
    ...(body.expectedGeneration !== undefined
      ? { expectedGeneration: body.expectedGeneration }
      : {}),
    createdAt: now,
  })

  return json(this.toBridgeTargetResponse(bridge, resolvedBinding))
}

export async function handleDeliverBridge(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseDeliverBridgeRequest(await parseJsonBody(request))
  return this.deliverBridgeText(
    requireBridge(this.db, body.bridgeId),
    {
      bridgeId: body.bridgeId,
      text: body.text,
      enter: true,
      expectedHostSessionId: body.expectedHostSessionId,
      expectedGeneration: body.expectedGeneration,
    },
    true
  )
}

export async function handleDeliverBridgeText(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseDeliverTextRequest(await parseJsonBody(request))
  return this.deliverBridgeText(requireBridge(this.db, body.bridgeId), body, false)
}

export async function deliverBridgeText(
  this: HrcServerInstanceForHandlers,
  bridge: HrcLocalBridgeRecord,
  delivery: DeliverTextRequest,
  compatibilityAlias: boolean
): Promise<Response> {
  if (bridge.closedAt !== undefined) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_BRIDGE, `unknown bridge "${bridge.bridgeId}"`, {
      bridgeId: bridge.bridgeId,
    })
  }

  const session = requireSession(this.db, bridge.hostSessionId)
  const continuity = requireContinuity(this.db, session)
  const activeSession = requireSession(this.db, continuity.activeHostSessionId)

  if (activeSession.hostSessionId !== bridge.hostSessionId) {
    throw new HrcConflictError(
      HrcErrorCode.STALE_CONTEXT,
      'bridge target is stale; reacquire the bridge target',
      {
        bridgeId: bridge.bridgeId,
        bridgeHostSessionId: bridge.hostSessionId,
        activeHostSessionId: activeSession.hostSessionId,
      }
    )
  }

  if (bridge.runtimeId !== undefined) {
    const runtime = this.db.runtimes.getByRuntimeId(bridge.runtimeId)
    if (
      !runtime ||
      runtime.hostSessionId !== bridge.hostSessionId ||
      runtime.status === 'terminated'
    ) {
      throw new HrcConflictError(HrcErrorCode.STALE_CONTEXT, 'bridge runtime is no longer active', {
        bridgeId: bridge.bridgeId,
        runtimeId: bridge.runtimeId,
        ...(runtime ? { runtimeHostSessionId: runtime.hostSessionId } : {}),
        bridgeHostSessionId: bridge.hostSessionId,
        ...(runtime ? { runtimeStatus: runtime.status } : {}),
      })
    }
  }

  const effectiveFence = mergeBridgeFence(bridge, delivery)
  validateBridgeFence(effectiveFence, activeSession)

  const runtime =
    bridge.runtimeId !== undefined ? this.db.runtimes.getByRuntimeId(bridge.runtimeId) : undefined
  const { paneId, tmux } = await this.resolveBridgePane(bridge, runtime)
  const text = delivery.text + (delivery.oobSuffix ?? '')
  if (delivery.enter) {
    await tmux.sendKeys(paneId, text)
  } else {
    await tmux.sendLiteral(paneId, text)
  }

  const event = appendHrcEvent(this.db, 'bridge.delivered', {
    ts: timestamp(),
    hostSessionId: activeSession.hostSessionId,
    scopeRef: activeSession.scopeRef,
    laneRef: activeSession.laneRef,
    generation: activeSession.generation,
    runtimeId: bridge.runtimeId,
    transport: bridge.transport === 'tmux' ? 'tmux' : undefined,
    payload: {
      bridgeId: bridge.bridgeId,
      ...(bridge.runtimeId !== undefined ? { runtimeId: bridge.runtimeId } : {}),
      target: bridge.target,
      payloadLength: delivery.text.length,
      enter: delivery.enter,
      oobSuffixLength: delivery.oobSuffix?.length ?? 0,
      generation: activeSession.generation,
      ...(compatibilityAlias ? { compatibilityAlias: true } : {}),
      ...(effectiveFence.expectedHostSessionId !== undefined
        ? { expectedHostSessionId: effectiveFence.expectedHostSessionId }
        : {}),
      ...(effectiveFence.expectedGeneration !== undefined
        ? { expectedGeneration: effectiveFence.expectedGeneration }
        : {}),
    },
  })
  this.notifyEvent(event)

  return json({
    delivered: true,
    bridgeId: bridge.bridgeId,
  } satisfies DeliverBridgeResponse)
}

export async function resolveBridgePane(
  this: HrcServerInstanceForHandlers,
  bridge: HrcLocalBridgeRecord,
  runtime: HrcRuntimeSnapshot | null | undefined
): Promise<{ paneId: string; tmux: ServerTmuxManager }> {
  // Lease-aware controller: a broker-tmux runtime's pane lives on a per-runtime
  // lease socket, not the default HRC tmux server. Probe + deliver through it.
  const runtimePane = runtime?.transport === 'tmux' ? requireTmuxPane(runtime) : undefined
  const tmux = runtimePane ? this.tmuxForPane(runtimePane) : this.tmux

  if (bridge.transport === 'tmux' || bridge.target.startsWith('%')) {
    try {
      await tmux.capture(bridge.target)
      return { paneId: bridge.target, tmux }
    } catch {
      // Fall back to the runtime binding or a reused pane below.
    }
  }

  if (runtimePane) {
    return { paneId: runtimePane.paneId, tmux }
  }

  const pane = await this.tmux.ensurePane(bridge.hostSessionId, 'reuse_pty')
  return { paneId: pane.paneId, tmux: this.tmux }
}

export async function resolveBridgeTargetBinding(
  this: HrcServerInstanceForHandlers,
  body: BridgeTargetRequest,
  session: HrcSessionRecord,
  activeSession: HrcSessionRecord
): Promise<{
  hostSessionId: string
  generation: number
  bridge?: string | undefined
  runtimeId?: string | undefined
  transport: string
  target: string
}> {
  if (body.transport !== undefined && body.target !== undefined) {
    if (body.runtimeId !== undefined) {
      const runtime = requireRuntime(this.db, body.runtimeId)
      if (runtime.hostSessionId !== session.hostSessionId) {
        throw new HrcBadRequestError(
          HrcErrorCode.MALFORMED_REQUEST,
          'runtimeId must belong to hostSessionId',
          {
            runtimeId: runtime.runtimeId,
            hostSessionId: session.hostSessionId,
            runtimeHostSessionId: runtime.hostSessionId,
          }
        )
      }
    }

    return {
      hostSessionId: session.hostSessionId,
      generation: activeSession.generation,
      ...(body.bridge !== undefined ? { bridge: body.bridge } : {}),
      ...(body.runtimeId !== undefined ? { runtimeId: body.runtimeId } : {}),
      transport: body.transport,
      target: body.target,
    }
  }

  const runtime =
    body.runtimeId !== undefined
      ? requireRuntime(this.db, body.runtimeId)
      : requireLatestRuntime(this.db, activeSession.hostSessionId)
  if (runtime.hostSessionId !== activeSession.hostSessionId) {
    throw new HrcBadRequestError(
      HrcErrorCode.MALFORMED_REQUEST,
      'runtimeId must belong to activeHostSessionId',
      {
        runtimeId: runtime.runtimeId,
        activeHostSessionId: activeSession.hostSessionId,
        runtimeHostSessionId: runtime.hostSessionId,
      }
    )
  }

  const pane = await this.tmux.ensurePane(activeSession.hostSessionId, 'reuse_pty')
  return {
    hostSessionId: activeSession.hostSessionId,
    generation: activeSession.generation,
    ...(body.bridge !== undefined ? { bridge: body.bridge } : {}),
    runtimeId: runtime.runtimeId,
    transport: body.bridge as string,
    target: pane.paneId,
  }
}

export function toBridgeTargetResponse(
  this: HrcServerInstanceForHandlers,
  bridge: HrcLocalBridgeRecord,
  resolvedBinding: { bridge?: string | undefined; generation: number }
): RegisterBridgeTargetResponse & { bridge?: string | undefined; generation: number } {
  return {
    ...bridge,
    ...(resolvedBinding.bridge !== undefined ? { bridge: resolvedBinding.bridge } : {}),
    generation: resolvedBinding.generation,
  }
}

export function handleListBridges(this: HrcServerInstanceForHandlers, url: URL): Response {
  const runtimeId = normalizeOptionalQuery(url.searchParams.get('runtimeId'))
  if (!runtimeId) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'runtimeId is required', {
      field: 'runtimeId',
    })
  }

  requireRuntime(this.db, runtimeId)
  return json(this.db.localBridges.listActive().filter((bridge) => bridge.runtimeId === runtimeId))
}

export async function handleCloseBridge(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseCloseBridgeRequest(await parseJsonBody(request))
  const existing = requireBridge(this.db, body.bridgeId)
  if (existing.closedAt !== undefined) {
    return json(existing)
  }

  const bridge = this.db.localBridges.close(body.bridgeId, timestamp())
  if (!bridge) {
    throw new HrcNotFoundError(HrcErrorCode.UNKNOWN_BRIDGE, `unknown bridge "${body.bridgeId}"`, {
      bridgeId: body.bridgeId,
    })
  }

  const session = this.db.sessions.getByHostSessionId(bridge.hostSessionId)
  if (session) {
    const event = appendHrcEvent(this.db, 'bridge.closed', {
      ts: timestamp(),
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      transport: bridge.transport === 'tmux' ? 'tmux' : undefined,
      payload: {
        bridgeId: bridge.bridgeId,
        target: bridge.target,
      },
    })
    this.notifyEvent(event)
  }

  return json(bridge)
}

export const bridgeSurfaceHandlersMethods = {
  handleAttachRuntime,
  handleBindSurface,
  handleUnbindSurface,
  handleListSurfaces,
  handleRegisterBridgeTarget,
  handleDeliverBridge,
  handleDeliverBridgeText,
  deliverBridgeText,
  resolveBridgePane,
  resolveBridgeTargetBinding,
  toBridgeTargetResponse,
  handleListBridges,
  handleCloseBridge,
}

export type BridgeSurfaceHandlersMethods = typeof bridgeSurfaceHandlersMethods
