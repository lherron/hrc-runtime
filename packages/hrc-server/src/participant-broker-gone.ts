/**
 * T-10333: a participant-served runtime whose broker is gone leaves `ready`.
 *
 * Lance's ruling: HRC decides host succession from its own records, and a dead
 * socket means a dead host. For a `join: 'participant-served'` registration the
 * broker belongs to the host, which kills it on exit, so once HRC's attachment
 * closes AND a fresh dial of the attempt's serving socket finds no listener,
 * the row is terminal (`participant_broker_gone`) and mail sees an absent seat.
 *
 * Everything else external keeps the T-08294 split exactly: a Codex-desktop
 * observer (or any external owner that is not participant-served) records the
 * detachment and nothing more, because "a helper process is not desktop
 * liveness". A live or indeterminate probe changes nothing either: only a
 * positive dead-transport observation may assert the host's death.
 */

import { HrcErrorCode } from 'hrc-core'
import type { HrcRuntimeSnapshot } from 'hrc-core'

import { isActiveBrokerRun } from './broker/controller/internal.js'
import { isExternalLifecycleOwner } from './external-participant-lifecycle.js'
import { appendHrcEvent } from './hrc-event-helper.js'
import { observeParticipantTransportEvidence } from './participant-transport-evidence.js'
import { isTerminalBrokerInvocationState } from './require-helpers.js'
import { runtimeActivityPatch } from './runtime-activity.js'
import type { HrcServerInstanceForHandlers } from './server-instance-context.js'
import { writeServerLog } from './server-log.js'
import { isRuntimeUnavailableStatus, timestamp } from './server-util.js'

export const PARTICIPANT_BROKER_GONE_REASON = 'participant_broker_gone'

export type ParticipantBrokerLossOutcome =
  | 'not_external'
  | 'observer_only'
  | 'live'
  | 'indeterminate'
  | 'superseded'
  | 'terminated'

function isSettled(runtime: HrcRuntimeSnapshot): boolean {
  return runtime.status === 'terminated' || isRuntimeUnavailableStatus(runtime.status)
}

export async function settleParticipantBrokerLoss(
  server: HrcServerInstanceForHandlers,
  input: { runtimeId: string; invocationId: string | undefined; code: string }
): Promise<ParticipantBrokerLossOutcome> {
  const runtime = server.db.runtimes.getByRuntimeId(input.runtimeId)
  if (runtime === null || !isExternalLifecycleOwner(runtime)) return 'not_external'
  const attempt =
    input.invocationId === undefined
      ? null
      : server.db.participantRegistrations.getAttemptByInvocationId(input.invocationId)
  const registration =
    attempt === null
      ? null
      : server.db.participantRegistrations.getRegistrationById(attempt.registrationId)
  if (
    attempt === null ||
    registration === null ||
    attempt.runtimeId !== input.runtimeId ||
    registration.join !== 'participant-served'
  ) {
    return 'observer_only'
  }

  const probe = await observeParticipantTransportEvidence(server, registration, attempt, 'host')
  if (probe.outcome !== 'dead') {
    writeServerLog('INFO', 'participant.broker_lost.host_not_proven_dead', {
      runtimeId: input.runtimeId,
      registrationId: registration.registrationId,
      attemptId: attempt.attemptId,
      outcome: probe.outcome,
      endpoint: attempt.attachSocketPath ?? null,
    })
    return probe.outcome
  }

  const event = server.db.sqlite.transaction(() => {
    // Re-read under the write lock: a successor registration, a reconnect or an
    // operator terminate may have moved the row while the dial was in flight.
    const current = server.db.runtimes.getByRuntimeId(input.runtimeId)
    if (
      current === null ||
      isSettled(current) ||
      current.activeInvocationId !== input.invocationId
    ) {
      return null
    }
    const now = timestamp()
    const invocationId = input.invocationId as string
    const failedRunIds: string[] = []
    for (const run of server.db.runs.listByRuntimeId(input.runtimeId)) {
      if (run.completedAt !== undefined) continue
      if (!isActiveBrokerRun(run) && run.status !== 'queued') continue
      server.db.runs.markCompleted(run.runId, {
        status: 'failed',
        completedAt: now,
        updatedAt: now,
        errorCode: HrcErrorCode.RUNTIME_UNAVAILABLE,
        errorMessage: `participant host is gone: ${PARTICIPANT_BROKER_GONE_REASON}`,
      })
      failedRunIds.push(run.runId)
    }
    const invocation = server.db.brokerInvocations.getByInvocationId(invocationId)
    if (invocation !== null && !isTerminalBrokerInvocationState(invocation.invocationState)) {
      server.db.brokerInvocations.update(invocationId, {
        invocationState: 'failed',
        lifecycleTerminalReason: PARTICIPANT_BROKER_GONE_REASON,
        updatedAt: now,
      })
    }
    server.db.runtimes.update(input.runtimeId, {
      status: 'terminated',
      statusChangedAt: now,
      lifecycleTerminalReason: PARTICIPANT_BROKER_GONE_REASON,
      activeInvocationId: null as unknown as HrcRuntimeSnapshot['activeInvocationId'],
      ...runtimeActivityPatch(server.db, input.runtimeId, {
        source: 'housekeeping',
        updatedAt: now,
      }),
      runtimeStateJson: {
        ...(current.runtimeStateJson ?? {}),
        status: 'terminated',
        updatedAt: now,
        terminalReason: PARTICIPANT_BROKER_GONE_REASON,
        participantBrokerGone: {
          observedAt: now,
          brokerErrorCode: input.code,
          registrationId: registration.registrationId,
          attemptId: attempt.attemptId,
          invocationId,
          evidence: probe.evidence,
        },
      },
    })
    writeServerLog('WARN', 'participant.broker_lost.terminated', {
      runtimeId: input.runtimeId,
      registrationId: registration.registrationId,
      attemptId: attempt.attemptId,
      invocationId,
      endpoint: attempt.attachSocketPath ?? null,
      priorStatus: current.status,
      failedRunIds,
      reason: PARTICIPANT_BROKER_GONE_REASON,
    })
    return appendHrcEvent(server.db, 'runtime.terminated', {
      ts: now,
      hostSessionId: current.hostSessionId,
      scopeRef: current.scopeRef,
      laneRef: current.laneRef,
      generation: current.generation,
      runtimeId: input.runtimeId,
      ...(current.transport === 'headless' || current.transport === 'tmux'
        ? { transport: current.transport }
        : {}),
      payload: {
        reason: PARTICIPANT_BROKER_GONE_REASON,
        invocationId,
        brokerErrorCode: input.code,
        failedRunIds,
      },
    })
  })()
  if (event === null) return 'superseded'
  server.notifyEvent(event)
  return 'terminated'
}
