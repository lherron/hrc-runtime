import { randomUUID } from 'node:crypto'

import {
  APP_SESSION_SCOPE_PREFIX,
  HrcConflictError,
  HrcErrorCode,
  HrcUnprocessableEntityError,
  validateFence,
} from 'hrc-core'
import type {
  ClearAppSessionContextResponse,
  SendAppHarnessInFlightInputResponse,
  SendLiteralInputResponse,
} from 'hrc-core'
import {
  assertAppIdentityCurrent,
  assertAppIntentIdentityEnv,
  assertAppRunIdUnused,
  withAppIdentityOwner,
} from './app-session-identity.js'
import { normalizeDispatchIntent } from './dispatch-invocation.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { assertLocalPersonaAllowed } from './local-persona-policy.js'
import {
  requireContinuity,
  requireManagedAppSession,
  requireSession,
  requireTmuxPane,
  resolveManagedHarnessIntent,
  validateAppSessionFence,
} from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import {
  requireLatestRuntime,
  requireLatestSessionRuntime,
  resolveActiveRunId,
} from './runtime-select.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import {
  parseAppHarnessInFlightInputRequest,
  parseAppSessionSelectorFromQuery,
  parseClearAppSessionContextRequest,
  parseDispatchAppHarnessTurnRequest,
  parseInterruptAppSessionRequest,
  parseJsonBody,
  parseSendLiteralInputRequest,
  parseTerminateAppSessionRequest,
} from './server-parsers.js'
import { json, timestamp } from './server-util.js'

export async function handleAppSessionDispatchTurn(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseDispatchAppHarnessTurnRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  assertAppIntentIdentityEnv(body.runtimeIntent, 'runtimeIntent')
  return await withAppIdentityOwner(this.db, body.selector, async () => {
    const managed = requireManagedAppSession(this.db, body.selector)
    if (managed.kind !== 'harness') {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.SESSION_KIND_MISMATCH,
        `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot dispatch turns`,
        {
          appId: managed.appId,
          appSessionKey: managed.appSessionKey,
          existingKind: managed.kind,
          requestedOperation: 'dispatch-turn',
        }
      )
    }

    const requestedSession = requireSession(this.db, managed.activeHostSessionId)
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
    assertAppIdentityCurrent(this.db, session)
    assertAppRunIdUnused(this.db, body.runId)
    const runId = body.runId ?? `run-${randomUUID()}`
    const effectiveIntent = body.runtimeIntent ?? resolveManagedHarnessIntent(managed, session)
    assertAppIntentIdentityEnv(effectiveIntent, 'stored-or-supplied intent')
    const intent = normalizeDispatchIntent(effectiveIntent, session, runId)

    return await this.dispatchTurnForSession(session, intent, body.prompt, {
      runId,
      ensureInteractiveRuntime: true,
    })
  })
}

export async function handleAppSessionInFlightInput(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseAppHarnessInFlightInputRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  return await withAppIdentityOwner(this.db, body.selector, async () => {
    const managed = requireManagedAppSession(this.db, body.selector)
    if (managed.kind !== 'harness') {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.SESSION_KIND_MISMATCH,
        `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot accept semantic in-flight input`,
        {
          appId: managed.appId,
          appSessionKey: managed.appSessionKey,
          existingKind: managed.kind,
          requestedOperation: 'in-flight-input',
        }
      )
    }

    const session = requireSession(this.db, managed.activeHostSessionId)
    validateAppSessionFence(body.fence, session)
    assertAppIdentityCurrent(this.db, session)
    const runtime = requireLatestSessionRuntime(this.db, session.hostSessionId)
    const runId = body.runId ?? resolveActiveRunId(this.db, runtime)
    const result = await this.deliverInFlightInputToRuntime(session, runtime, {
      runtimeId: runtime.runtimeId,
      runId,
      prompt: body.prompt,
      ...(body.inputType ? { inputType: body.inputType } : {}),
    })

    return json({
      ...result,
      hostSessionId: session.hostSessionId,
    } satisfies SendAppHarnessInFlightInputResponse)
  })
}

export async function handleAppSessionClearContext(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseClearAppSessionContextRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  if (body.spec?.kind === 'harness') {
    assertAppIntentIdentityEnv(body.spec.runtimeIntent, 'spec.runtimeIntent')
  }
  return await withAppIdentityOwner(this.db, body.selector, async () => {
    const managed = requireManagedAppSession(this.db, body.selector)
    const session = requireSession(this.db, managed.activeHostSessionId)
    assertAppIdentityCurrent(this.db, session)
    return json(
      (await this.rotateSessionContext(session, {
        relaunch: body.relaunch === true,
        managed,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.spec ? { relaunchSpec: body.spec } : {}),
      })) satisfies ClearAppSessionContextResponse
    )
  })
}

export async function handleAppSessionLiteralInput(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseSendLiteralInputRequest(await parseJsonBody(request))
  assertLocalPersonaAllowed(this, `${APP_SESSION_SCOPE_PREFIX}${body.selector.appId}`)
  return await withAppIdentityOwner(this.db, body.selector, async () => {
    const managed = requireManagedAppSession(this.db, body.selector)
    const session = requireSession(this.db, managed.activeHostSessionId)

    if (managed.kind !== 'command') {
      throw new HrcUnprocessableEntityError(
        HrcErrorCode.SESSION_KIND_MISMATCH,
        `app session "${managed.appId}/${managed.appSessionKey}" is kind "${managed.kind}", cannot accept literal input`,
        {
          appId: managed.appId,
          appSessionKey: managed.appSessionKey,
          existingKind: managed.kind,
          requestedOperation: 'literal-input',
        }
      )
    }

    validateAppSessionFence(body.fence, session)
    assertAppIdentityCurrent(this.db, session)
    const runtime = requireLatestRuntime(this.db, session.hostSessionId)

    const pane = requireTmuxPane(runtime)
    const tmux = this.tmuxForPane(pane)
    if (body.enter === true) {
      await tmux.sendKeys(pane.paneId, body.text)
    } else {
      await tmux.sendLiteral(pane.paneId, body.text)
    }

    const now = timestamp()
    this.db.runtimes.update(
      runtime.runtimeId,
      runtimeActivityPatch(this.db, runtime.runtimeId, {
        source: 'agent-message',
        occurredAt: now,
        updatedAt: now,
      })
    )
    const event = appendHrcEvent(this.db, 'app-session.literal-input', {
      ts: now,
      hostSessionId: session.hostSessionId,
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
      appId: managed.appId,
      appSessionKey: managed.appSessionKey,
      payload: {
        payloadLength: body.text.length,
        enter: body.enter === true,
      },
    })
    this.notifyEvent(event)

    return json({
      delivered: true,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      runtimeId: runtime.runtimeId,
    } satisfies SendLiteralInputResponse)
  })
}

export async function handleAppSessionCapture(
  this: HrcServerInstanceForHandlers,
  url: URL
): Promise<Response> {
  const { runtime } = this.resolveManagedSessionRuntime(parseAppSessionSelectorFromQuery(url))
  return await this.captureRuntime(runtime)
}

export function handleAppSessionAttach(this: HrcServerInstanceForHandlers, url: URL): Response {
  const { runtime } = this.resolveManagedSessionRuntime(parseAppSessionSelectorFromQuery(url))
  return this.attachRuntime(runtime, { allowLegacyTmuxAttach: true })
}

export async function handleAppSessionInterrupt(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseInterruptAppSessionRequest(await parseJsonBody(request))
  const { runtime } = this.resolveManagedSessionRuntime(body.selector)
  return await this.interruptRuntime(runtime, body.hard === true)
}

export async function handleAppSessionTerminate(
  this: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseTerminateAppSessionRequest(await parseJsonBody(request))
  const { runtime } = this.resolveManagedSessionRuntime(body.selector)
  return await this.terminateRuntime(runtime)
}
