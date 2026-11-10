import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import type { HrcLifecycleEvent } from 'hrc-core'
import { appendHrcEvent } from './hrc-event-helper.js'
import {
  requireKnownRuntime,
  requireRuntime,
  requireSession,
  requireTmuxPane,
} from './require-helpers.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  parseAttachRuntimeRequest,
  parseBindSurfaceRequest,
  parseJsonBody,
} from './server-parsers.js'
import { json, timestamp } from './server-util.js'

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

  const tmuxPane =
    runtime.transport === 'tmux' && runtime.controllerKind !== 'harness-broker'
      ? requireTmuxPane(runtime)
      : null
  const now = timestamp()
  const mutation = this.db.sqlite.transaction(() => {
    const session = requireSession(this.db, runtime.hostSessionId)
    const existing = this.db.surfaceBindings.findBySurface(body.surfaceKind, body.surfaceId)
    if (
      existing &&
      existing.unboundAt === undefined &&
      existing.runtimeId === runtime.runtimeId &&
      existing.clientTty === body.clientTty
    ) {
      return { binding: existing, events: [] as HrcLifecycleEvent[] }
    }

    const events: HrcLifecycleEvent[] = []
    const displaced =
      body.surfaceKind === 'ghostty' && body.clientTty !== undefined
        ? this.db.surfaceBindings.unbindOtherGhosttyClientTty(
            body.clientTty,
            body.surfaceId,
            now,
            'client_tty_rebound'
          )
        : []
    for (const retired of displaced) {
      const retiredSession = requireSession(this.db, retired.hostSessionId)
      events.push(
        appendHrcEvent(this.db, 'surface.unbound', {
          ts: now,
          hostSessionId: retiredSession.hostSessionId,
          scopeRef: retiredSession.scopeRef,
          laneRef: retiredSession.laneRef,
          generation: retiredSession.generation,
          runtimeId: retired.runtimeId,
          payload: {
            surfaceKind: retired.surfaceKind,
            surfaceId: retired.surfaceId,
            runtimeId: retired.runtimeId,
            unboundAt: retired.unboundAt,
            ...(retired.clientTty ? { clientTty: retired.clientTty } : {}),
            ...(retired.reason ? { reason: retired.reason } : {}),
          },
        })
      )
    }

    const binding = this.db.surfaceBindings.bind({
      surfaceKind: body.surfaceKind,
      surfaceId: body.surfaceId,
      clientTty: body.clientTty,
      hostSessionId: runtime.hostSessionId,
      runtimeId: runtime.runtimeId,
      generation: runtime.generation,
      windowId: body.windowId ?? tmuxPane?.windowId,
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
      ...(binding.clientTty ? { clientTty: binding.clientTty } : {}),
      ...(binding.windowId ? { windowId: binding.windowId } : {}),
      ...(binding.paneId ? { paneId: binding.paneId } : {}),
    }

    if (eventKind === 'surface.rebound' && existing) {
      eventJson['previousHostSessionId'] = existing.hostSessionId
      eventJson['previousRuntimeId'] = existing.runtimeId
      eventJson['previousGeneration'] = existing.generation
      if (existing.clientTty) eventJson['previousClientTty'] = existing.clientTty
    }

    events.push(
      appendHrcEvent(this.db, eventKind, {
        ts: now,
        hostSessionId: session.hostSessionId,
        scopeRef: session.scopeRef,
        laneRef: session.laneRef,
        generation: session.generation,
        runtimeId: runtime.runtimeId,
        payload: eventJson,
      })
    )
    return { binding, events }
  })()
  for (const event of mutation.events) this.notifyEvent(event)
  return json(mutation.binding)
}

export const surfaceHandlersMethods = {
  handleAttachRuntime,
  handleBindSurface,
}

export type SurfaceHandlersMethods = typeof surfaceHandlersMethods
