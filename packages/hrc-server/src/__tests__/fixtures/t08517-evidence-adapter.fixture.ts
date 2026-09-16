import { createControlledParticipantAdapter } from 'agent-spaces/testing'
import type {
  ParticipantAdapter,
  WriterEvidence,
  WriterInspectionRequest,
  WriterRetirementRequest,
} from 'spaces-runtime-contracts'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context.js'

export type T08517EvidenceMode =
  | 'retired-recovered'
  | 'retired-unknown'
  | 'retired-live'
  | 'retired-dead'
  | 'unknown-dead'
  | 'writable-dead'
  | 'writable-unknown'
  | 'unknown-live'
  | 'live'
  | 'wrong-subject'
  | 'unknown'

export function createT08517EvidenceAdapter(
  adapterId: string,
  workspaceCwd: string,
  mode: () => T08517EvidenceMode,
  beforeAnswer: () => void
): ParticipantAdapter {
  const base = createControlledParticipantAdapter({ adapterId, workspaceCwd })
  const answer = (request: WriterRetirementRequest | WriterInspectionRequest): WriterEvidence => {
    beforeAnswer()
    const current = mode()
    return {
      schemaVersion: 'writer-evidence/v1',
      writerRef:
        current === 'wrong-subject'
          ? {
              ...request.writerRef,
              subject: request.writerRef.subject === 'host' ? 'bridge' : 'host',
            }
          : request.writerRef,
      observedAt: '2026-09-16T04:00:00.000Z',
      writePath: {
        state: current.startsWith('retired-')
          ? 'retired'
          : current === 'live' || current.startsWith('writable-')
            ? 'writable'
            : 'unknown',
        reason: current,
      },
      liveness: {
        state:
          current === 'live' || current.endsWith('-live')
            ? 'live'
            : current.endsWith('-dead')
              ? 'dead'
              : 'unknown',
        reason: current,
      },
      priorRecovery: {
        state: current === 'retired-recovered' ? 'recovered' : 'unknown',
        reason: current,
      },
    }
  }
  return {
    adapterId: base.adapterId,
    admit: (request) => base.admit(request),
    prepare: (request) => base.prepare(request),
    retireWriter: answer,
    inspectWriter: answer,
  }
}

export function storeT08517CrashBoundaryIntent(
  server: HrcServerInstanceForHandlers,
  prior: { attemptId: string; bindingId: string },
  workspaceCwd: string,
  classId: string,
  participantKey: string,
  candidateHostIncarnationId = 'host-b'
): void {
  const attempt = server.db.participantRegistrations.getAttempt(prior.attemptId)
  const binding = server.db.participantHostBindings.getBindingById(prior.bindingId)
  if (attempt === null || binding === null) throw new Error('crash-boundary predecessor missing')
  const replacementIntentJson = JSON.stringify({
    schemaVersion: 'participant-replacement-intent/v1',
    kind: 'host',
    operationId: 'participant-replacement-crash-boundary',
    predecessor: {
      bindingId: binding.bindingId,
      hostIncarnationId: binding.hostIncarnationId,
      hostSessionId: binding.hostSessionId,
      generation: binding.generation,
      runtimeId: binding.runtimeId,
      attemptId: attempt.attemptId,
      attachEpoch: attempt.attachEpoch,
      invocationId: attempt.invocationId,
    },
    predecessorWork: {
      state: attempt.establishmentWorkState,
      attemptCount: attempt.establishmentAttemptCount,
    },
    candidate: {
      hostIncarnationId: candidateHostIncarnationId,
      classId,
      participantKey,
      workspaceCwd,
      socketPath: `${workspaceCwd}/${candidateHostIncarnationId}.sock`,
    },
    createdAt: '2026-09-16T04:30:00.000Z',
  })
  const stored = server.db.participantRegistrations.storeReplacementIntent({
    attemptId: attempt.attemptId,
    attachEpoch: attempt.attachEpoch,
    replacementIntentJson,
    updatedAt: '2026-09-16T04:30:00.000Z',
  })
  if (stored !== 'stored') throw new Error(`crash-boundary intent was ${stored}`)
}
