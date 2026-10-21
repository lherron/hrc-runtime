import { randomUUID } from 'node:crypto'

import type {
  ParticipantAttempt,
  ParticipantHostBinding,
  ParticipantRegistration,
} from 'hrc-store-sqlite'
import type { WriterEvidence } from 'spaces-runtime-contracts'

import type { DirectJoinRequest } from './participant-host-registration.js'
import { declarationOf } from './participant-successor-continuation.js'

/**
 * The durable replacement intent stored on the predecessor attempt. It is the
 * record a retry, a restart and the scheduler all re-enter from, so its
 * identity rules (§5.4) live with its shape.
 */

export type ReplacementKind = 'bridge' | 'host'

export type ReplacementIntent = {
  schemaVersion: 'participant-replacement-intent/v1'
  kind: ReplacementKind
  operationId: string
  predecessor: {
    bindingId: string
    hostIncarnationId: string
    hostSessionId: string
    generation: number
    runtimeId: string
    attemptId: string
    attachEpoch: number
    invocationId: string
  }
  predecessorWork: {
    state: ParticipantAttempt['establishmentWorkState']
    attemptCount: number
    nextAttemptAt?: string | undefined
    lastError?: string | undefined
  }
  candidate: {
    hostIncarnationId: string
    classId?: string | undefined
    participantKey?: string | undefined
    workspaceCwd?: string | undefined
    socketPath?: string | undefined
    /** Stored only when `fresh`; an absent field is `continue` (R6.6 amendment). */
    continuation?: 'fresh' | undefined
  }
  preAttachSupersession?: boolean | undefined
  receipt?: WriterEvidence | undefined
  /** First satisfying evidence; retained so freshness is evaluated per axis. */
  retirementBasis?: WriterEvidence | undefined
  allocatedAttemptId?: string | undefined
  renewedRecovery?: { reason: string; recordedAt: string } | undefined
  createdAt: string
}

export function parseReplacementIntent(value: string | undefined): ReplacementIntent | null {
  if (value === undefined) return null
  try {
    const parsed = JSON.parse(value) as ReplacementIntent
    return parsed.schemaVersion === 'participant-replacement-intent/v1' ? parsed : null
  } catch {
    return null
  }
}

/** Same candidate and predecessor, regardless of the continuation declaration. */
export function sameReplacementTarget(
  intent: ReplacementIntent,
  request: DirectJoinRequest
): boolean {
  return (
    intent.candidate.hostIncarnationId === request.hostIncarnationId &&
    (request.expectedPredecessor === undefined
      ? intent.preAttachSupersession === true
      : intent.predecessor.hostIncarnationId === request.expectedPredecessor.hostIncarnationId &&
        intent.predecessor.runtimeId === request.expectedPredecessor.runtimeId &&
        intent.predecessor.generation === request.expectedPredecessor.generation)
  )
}

/**
 * §5.4 idempotency: the normalized declaration is part of the request
 * identity, so a retry that changes only `continue`/`fresh` is never answered
 * with the other declaration's allocation.
 */
export function sameReplacementRequest(
  intent: ReplacementIntent,
  request: DirectJoinRequest
): boolean {
  return (
    sameReplacementTarget(intent, request) &&
    declarationOf(intent.candidate.continuation) === declarationOf(request.continuation)
  )
}

export const DECLARATION_MISMATCH_DETAIL =
  'a replacement intent for this predecessor and host incarnation was made with a different continuation declaration'

export function buildReplacementIntent(input: {
  kind: ReplacementKind
  preAttachSupersession: boolean
  binding: ParticipantHostBinding
  predecessor: ParticipantAttempt
  request: DirectJoinRequest
  createdAt: string
}): ReplacementIntent {
  const { binding, predecessor, request } = input
  return {
    schemaVersion: 'participant-replacement-intent/v1',
    kind: input.kind,
    ...(input.preAttachSupersession ? { preAttachSupersession: true } : {}),
    operationId: `participant-replacement-${randomUUID()}`,
    predecessor: {
      bindingId: binding.bindingId,
      hostIncarnationId: binding.hostIncarnationId,
      hostSessionId: binding.hostSessionId,
      generation: binding.generation,
      runtimeId: binding.runtimeId,
      attemptId: predecessor.attemptId,
      attachEpoch: predecessor.attachEpoch,
      invocationId: predecessor.invocationId,
    },
    predecessorWork: {
      state: predecessor.establishmentWorkState,
      attemptCount: predecessor.establishmentAttemptCount,
      ...(predecessor.establishmentNextAttemptAt === undefined
        ? {}
        : { nextAttemptAt: predecessor.establishmentNextAttemptAt }),
      ...(predecessor.establishmentLastError === undefined
        ? {}
        : { lastError: predecessor.establishmentLastError }),
    },
    candidate: {
      hostIncarnationId: request.hostIncarnationId,
      ...(request.classId === undefined ? {} : { classId: request.classId }),
      ...(request.participantKey === undefined ? {} : { participantKey: request.participantKey }),
      ...(request.workspaceCwd === undefined ? {} : { workspaceCwd: request.workspaceCwd }),
      ...(request.socketPath === undefined ? {} : { socketPath: request.socketPath }),
      ...(request.continuation === 'fresh' ? { continuation: 'fresh' as const } : {}),
    },
    createdAt: input.createdAt,
  }
}

/** The join request a stored intent stands for, for startup/scheduler re-entry. */
export function joinRequestFromIntent(
  registration: ParticipantRegistration,
  intent: ReplacementIntent
): DirectJoinRequest {
  const { candidate, predecessor } = intent
  return {
    requestedSessionRef: registration.scopeRef,
    hostIncarnationId: candidate.hostIncarnationId,
    laneRef: registration.laneRef,
    ...(candidate.classId === undefined ? {} : { classId: candidate.classId }),
    ...(candidate.participantKey === undefined ? {} : { participantKey: candidate.participantKey }),
    ...(candidate.workspaceCwd === undefined ? {} : { workspaceCwd: candidate.workspaceCwd }),
    ...(candidate.socketPath === undefined ? {} : { socketPath: candidate.socketPath }),
    ...(candidate.continuation === undefined ? {} : { continuation: candidate.continuation }),
    expectedPredecessor: {
      hostIncarnationId: predecessor.hostIncarnationId,
      runtimeId: predecessor.runtimeId,
      generation: predecessor.generation,
    },
  }
}
