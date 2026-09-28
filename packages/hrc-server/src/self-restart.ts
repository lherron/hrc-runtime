/**
 * T-09872 — `hrc restartme` (durable record hrc-runtime.self-restart-turn-boundary).
 *
 * An agent arms a restart of ITS OWN seat, named by the lifecycle credential
 * it presents. Arming binds one intent per host session to the broker turn
 * that is active at arm time (runtimeId, invocationId, native turnId). Only
 * that turn's committed, non-retained terminal claims the intent; on the claim
 * HRC rotates the session (generation + 1, continuation dropped) and hands the
 * successor a resume prompt naming the wrkq handoff through the semantic
 * turn-handoff door.
 *
 * The intent lives in memory: a daemon restart between arm and turn end loses
 * it, and the agent re-arms. Queued input and stale intents are out of scope
 * by Lance's ruling (2026-09-28).
 */
import {
  HRC_LIFECYCLE_CREDENTIAL_HEADER,
  HRC_LIFECYCLE_RUNTIME_HEADER,
  HRC_LIFECYCLE_SESSION_REF_HEADER,
  HrcBadRequestError,
  HrcDomainError,
  HrcErrorCode,
  type HrcEventEnvelope,
  type HrcLifecycleEvent,
  type HrcRestartSelfRefusalCode,
  type HrcRestartSelfResponse,
  HrcUnprocessableEntityError,
  selfRestartResumePrompt,
} from 'hrc-core'

import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { formatSessionRef } from './messages.js'
import { parseJsonBody } from './parsers/common.js'
import {
  participantRotationUnsupported,
  resolveParticipantDelivery,
} from './participant-delivery.js'
import { requireSession } from './require-helpers.js'
import { sessionEventBase } from './runtime-control-handlers/session-event-base.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { verifyLifecycleCaller } from './server-lifecycle-authority.js'
import { isLifecycleBindingLive } from './server-lifecycle-credentials.js'
import { writeServerLog } from './server-log.js'
import { json, timestamp } from './server-util.js'

export type SelfRestartIntent = {
  readonly hostSessionId: string
  readonly runtimeId: string
  readonly generation: number
  readonly invocationId: string
  readonly turnId: string
  readonly handoffId: string
  readonly armedAt: string
  /** The credential's bound scopeRef. */
  readonly armedBy: string
}

/** One armed intent per host session. */
export class SelfRestartIntents {
  readonly #byHostSession = new Map<string, SelfRestartIntent>()

  get(hostSessionId: string): SelfRestartIntent | undefined {
    return this.#byHostSession.get(hostSessionId)
  }

  set(intent: SelfRestartIntent): void {
    this.#byHostSession.set(intent.hostSessionId, intent)
  }

  delete(hostSessionId: string): SelfRestartIntent | undefined {
    const intent = this.#byHostSession.get(hostSessionId)
    this.#byHostSession.delete(hostSessionId)
    return intent
  }

  /**
   * Delete-returning claim: the intent is removed and returned only when the
   * terminal names exactly the bound turn. Any other terminal (another turn,
   * another invocation, another runtime) leaves it armed.
   */
  claim(terminal: {
    hostSessionId: string
    runtimeId: string | undefined
    invocationId: string | undefined
    turnId: string | undefined
  }): SelfRestartIntent | undefined {
    const intent = this.#byHostSession.get(terminal.hostSessionId)
    if (
      intent === undefined ||
      terminal.runtimeId !== intent.runtimeId ||
      terminal.invocationId !== intent.invocationId ||
      terminal.turnId !== intent.turnId
    ) {
      return undefined
    }
    this.#byHostSession.delete(terminal.hostSessionId)
    return intent
  }
}

const TERMINAL_KINDS = new Set(['turn.completed', 'turn.failed', 'turn.interrupted'])

function refused(code: HrcRestartSelfRefusalCode, message: string): HrcDomainError {
  return new HrcDomainError(HrcErrorCode.SELF_RESTART_REFUSED, message, { refusal: code })
}

function parseRestartSelfBody(raw: unknown): { handoffId: string } | { cancel: true } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new HrcBadRequestError(HrcErrorCode.MALFORMED_REQUEST, 'body must be a JSON object')
  }
  const body = raw as Record<string, unknown>
  for (const key of Object.keys(body)) {
    if (key !== 'handoffId' && key !== 'cancel') {
      throw new HrcUnprocessableEntityError(HrcErrorCode.UNKNOWN_FIELD, `unknown field "${key}"`, {
        field: key,
      })
    }
  }
  if (body['cancel'] === true && body['handoffId'] === undefined) return { cancel: true }
  const handoffId = body['handoffId']
  if (body['cancel'] === undefined && typeof handoffId === 'string' && handoffId.trim() !== '') {
    return { handoffId: handoffId.trim() }
  }
  throw new HrcBadRequestError(
    HrcErrorCode.MALFORMED_REQUEST,
    'body must be exactly {handoffId: string} or {cancel: true}'
  )
}

/** `POST /v1/runtimes/restart-self` — arm or cancel the caller's own restart. */
export async function handleRestartSelf(
  server: HrcServerInstanceForHandlers,
  request: Request
): Promise<Response> {
  const body = parseRestartSelfBody(await parseJsonBody(request))
  const verification = verifyLifecycleCaller({
    caller: {
      runtimeId: request.headers.get(HRC_LIFECYCLE_RUNTIME_HEADER) ?? undefined,
      credential: request.headers.get(HRC_LIFECYCLE_CREDENTIAL_HEADER) ?? undefined,
      attributedSessionRef: request.headers.get(HRC_LIFECYCLE_SESSION_REF_HEADER) ?? undefined,
    },
    verifyCredential: (runtimeId, value) => server.lifecycleCredentials.verify(runtimeId, value),
    isLive: (binding) => isLifecycleBindingLive(server.db, binding),
  })
  if (!verification.ok) {
    writeServerLog('WARN', 'session.restart_refused', {
      refusal: verification.code,
      attributedCaller: request.headers.get(HRC_LIFECYCLE_SESSION_REF_HEADER),
    })
    throw refused(
      verification.code,
      `hrc restartme restarts only the calling agent runtime (${verification.detail})`
    )
  }
  const { binding } = verification
  const runtime = server.db.runtimes.getByRuntimeId(binding.runtimeId)
  if (runtime === null) {
    throw refused('credential_revoked', 'the calling runtime is no longer recorded')
  }
  const session = requireSession(server.db, runtime.hostSessionId)
  const now = timestamp()

  if ('cancel' in body) {
    const removed = server.selfRestartIntents.delete(session.hostSessionId)
    if (removed !== undefined) {
      server.notifyEvent(
        appendHrcEvent(server.db, 'session.restart_cancelled', {
          ...sessionEventBase(session, now),
          runtimeId: runtime.runtimeId,
          payload: {
            handoffId: removed.handoffId,
            runtimeId: removed.runtimeId,
            generation: removed.generation,
            invocationId: removed.invocationId,
            turnId: removed.turnId,
          },
        })
      )
    }
    return json({
      outcome: 'cancelled',
      hostSessionId: session.hostSessionId,
      cancelled: removed !== undefined,
      ...(removed !== undefined ? { handoffId: removed.handoffId } : {}),
    } satisfies HrcRestartSelfResponse)
  }

  // Same refusal as fresh-context against a participant: rotation would move
  // the address off a process HRC does not own.
  if (isExternalLifecycleOwner(runtime) || resolveParticipantDelivery(server, session) !== null) {
    throw participantRotationUnsupported(session, 'self-restart')
  }

  // Bind to the broker turn active NOW (rev 2, F1). The broker turnId, not
  // runs.activeRunId: a human-typed interactive turn has a turnId and no run.
  const probe =
    runtime.controllerKind === 'harness-broker'
      ? await server.getHarnessBrokerController().seatProbe(runtime.runtimeId)
      : undefined
  const seat = probe?.ok === true ? probe.response.seat : undefined
  if (probe === undefined || !probe.ok || seat === undefined || seat.state !== 'turn-active') {
    const observed =
      probe === undefined
        ? `controller ${runtime.controllerKind ?? 'unknown'} has no broker seat`
        : probe.ok
          ? `seat is ${probe.response.seat.state}`
          : `seat probe failed: ${probe.error.message}`
    throw refused(
      'no_active_turn',
      `hrc restartme must run inside an active turn of the calling runtime (${observed})`
    )
  }

  const invocationId = String(probe.response.invocationId)
  const turnId = String(seat.turnId)
  const previous = server.selfRestartIntents.get(session.hostSessionId)
  const replaced =
    previous !== undefined &&
    previous.runtimeId === runtime.runtimeId &&
    previous.invocationId === invocationId &&
    previous.turnId === turnId
  const intent: SelfRestartIntent = {
    hostSessionId: session.hostSessionId,
    runtimeId: runtime.runtimeId,
    generation: session.generation,
    invocationId,
    turnId,
    handoffId: body.handoffId,
    armedAt: now,
    armedBy: binding.scopeRef,
  }
  server.selfRestartIntents.set(intent)
  server.notifyEvent(
    appendHrcEvent(server.db, 'session.restart_armed', {
      ...sessionEventBase(session, now),
      runtimeId: runtime.runtimeId,
      payload: {
        handoffId: intent.handoffId,
        runtimeId: intent.runtimeId,
        generation: intent.generation,
        invocationId,
        turnId,
        armedBy: intent.armedBy,
        replaced,
      },
    })
  )
  return json({
    outcome: 'armed',
    handoffId: intent.handoffId,
    hostSessionId: intent.hostSessionId,
    runtimeId: intent.runtimeId,
    generation: intent.generation,
    invocationId,
    turnId,
    armedAt: now,
    replaced,
  } satisfies HrcRestartSelfResponse)
}

function payloadString(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Called from `notifyEvent` after the retained-origin guard, so only a
 * committed, non-retained terminal reaches here. Synchronous claim; the
 * rotation and delivery run detached so the broker projection that produced
 * this event is never held up by (or re-entered from) its own teardown.
 */
export function maybeExecuteSelfRestart(
  server: HrcServerInstanceForHandlers,
  event: HrcEventEnvelope | HrcLifecycleEvent
): void {
  if (!('hrcSeq' in event) || !TERMINAL_KINDS.has(event.eventKind)) return
  const intent = server.selfRestartIntents.claim({
    hostSessionId: event.hostSessionId,
    runtimeId: event.runtimeId,
    invocationId: payloadString(event.payload, 'invocationId'),
    turnId: payloadString(event.payload, 'turnId'),
  })
  if (intent === undefined) return
  setTimeout(() => {
    void executeSelfRestart(server, intent, event.hrcSeq).catch((error) => {
      writeServerLog('WARN', 'session.restart_failed', {
        hostSessionId: intent.hostSessionId,
        handoffId: intent.handoffId,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }, 0)
}

async function executeSelfRestart(
  server: HrcServerInstanceForHandlers,
  intent: SelfRestartIntent,
  terminalHrcSeq: number
): Promise<void> {
  const session = requireSession(server.db, intent.hostSessionId)
  const rotation = await server.rotateSessionContext(session, {
    relaunch: false,
    dropContinuation: true,
    reason: 'self-restart',
  })
  const next = requireSession(server.db, rotation.hostSessionId)
  const prompt = selfRestartResumePrompt({
    handoffId: intent.handoffId,
    priorGeneration: session.generation,
    nextGeneration: next.generation,
  })

  let delivery: Record<string, unknown>
  try {
    const started = await server.persistAndDeliverSemanticTurnHandoff({
      from: { kind: 'entity', entity: 'system' },
      to: { kind: 'session', sessionRef: formatSessionRef(next.scopeRef, next.laneRef) },
      body: prompt,
    })
    delivery = {
      messageId: started.messageId,
      runId: started.runId,
      runtimeId: started.runtimeId,
    }
  } catch (error) {
    delivery = {
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof HrcDomainError ? { errorCode: error.code } : {}),
    }
  }

  server.notifyEvent(
    appendHrcEvent(server.db, 'session.restart_executed', {
      ...sessionEventBase(session, timestamp()),
      runtimeId: intent.runtimeId,
      payload: {
        handoffId: intent.handoffId,
        priorHostSessionId: session.hostSessionId,
        nextHostSessionId: next.hostSessionId,
        priorGeneration: session.generation,
        nextGeneration: next.generation,
        invocationId: intent.invocationId,
        turnId: intent.turnId,
        terminalHrcSeq,
        delivery,
      },
    })
  )
}
