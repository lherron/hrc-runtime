import type { DispatchTurnResponse, HrcRuntimeIntent, HrcSessionRecord } from 'hrc-core'
import type { HrcServerTestFixture } from '../../__tests__/fixtures/hrc-test-fixture'
import { seedDispatchedBrokerInvocation } from '../../__tests__/persisted-invocation.fixture'
import type { HrcServerInstanceForHandlers } from '../../server-instance-context'
import type { Driver } from './expected-admission'
export const CONFORMANCE_INVOCATION_ID = 'inv-conformance'
export const CONFORMANCE_RUNTIME_ID = 'rt-conformance'
const invocationId = CONFORMANCE_INVOCATION_ID
const runtimeId = CONFORMANCE_RUNTIME_ID

/** Positive rejection uses the executor's existing failed-run receipt shape. */
export function rejectedDispatchReceipt(
  ctx: HrcServerInstanceForHandlers,
  now: string
): HrcServerInstanceForHandlers['executeInteractiveBrokerInputTurn'] {
  return async (target, runtime, _body, runId) => {
    ctx.db.runs.insert({
      runId,
      hostSessionId: target.hostSessionId,
      runtimeId: runtime.runtimeId,
      scopeRef: target.scopeRef,
      laneRef: target.laneRef,
      generation: target.generation,
      transport: 'tmux',
      status: 'failed',
      acceptedAt: now,
      completedAt: now,
      updatedAt: now,
    })
    return Response.json({
      runId,
      hostSessionId: target.hostSessionId,
      generation: target.generation,
      runtimeId: runtime.runtimeId,
      transport: 'tmux',
      status: 'started',
      supportsInFlightInput: true,
      admission: 'rejected',
      reason: 'positive rejection at delivery receipt',
    } satisfies DispatchTurnResponse)
  }
}

export function seedAdmissionDriver(
  ctx: HrcServerInstanceForHandlers,
  fixture: HrcServerTestFixture,
  requestedSession: HrcSessionRecord,
  driver: Driver,
  intent: HrcRuntimeIntent
): HrcSessionRecord {
  let session = requestedSession
  // Ordinary delivery is fresh; participant delivery deliberately crosses the stale threshold.
  const createdAt = new Date(Date.now() - (driver === 'participant' ? 120_000 : 0)).toISOString()
  ctx.db.sqlite
    .query('UPDATE sessions SET created_at = ? WHERE host_session_id = ?')
    .run(createdAt, session.hostSessionId)
  session = { ...session, createdAt }
  ctx.db.sessions.updateIntent(session.hostSessionId, intent, fixture.now())
  if (driver === 'tmux-cold' || driver === 'sdk') return session
  seedDispatchedBrokerInvocation(ctx.db, {
    runtimeId,
    invocationId,
    executionFormat: driver === 'v2-headless' ? 'format2' : 'format1',
  })
  ctx.db.runtimeOperations.insert({
    operationId: `op-${invocationId}`,
    runtimeId,
    hostSessionId: session.hostSessionId,
    generation: session.generation,
    operationKind: 'broker_invocation',
    controller: 'harness-broker',
    startupMethod: 'test',
    status: 'started',
    routeDecisionJson: '{}',
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
  })
  ctx.db.brokerInvocations.update(invocationId, {
    capabilitiesJson: JSON.stringify({
      admission: { classes: ['exclusive', 'queue', 'preempt', 'steer'] },
    }),
    updatedAt: fixture.now(),
  })
  ctx.db.runtimes.insert({
    runtimeId,
    hostSessionId: session.hostSessionId,
    scopeRef: session.scopeRef,
    laneRef: session.laneRef,
    generation: session.generation,
    transport: driver === 'tmux-live' ? 'tmux' : 'headless',
    status: 'ready',
    controllerKind: 'harness-broker',
    ...(driver === 'tmux-live'
      ? {
          tmuxJson: {
            socketPath: fixture.tmuxSocketPath,
            sessionName: 'conformance',
            windowName: 'main',
            paneId: '%1',
            brokerDriver: 'codex-cli-tmux',
          },
        }
      : {}),
    activeOperationId: `op-${invocationId}`,
    activeInvocationId: invocationId,
    harness: 'codex-cli',
    provider: 'openai',
    supportsInflightInput: true,
    createdAt: fixture.now(),
    updatedAt: fixture.now(),
  })
  if (driver === 'participant') {
    ctx.db.participantRegistrations.insertRegistration({
      registrationId: 'preg-conformance',
      join: 'participant-served',
      scopeRef: session.scopeRef,
      laneRef: session.laneRef,
      hostSessionId: session.hostSessionId,
      generation: session.generation,
      hostIncarnationId: 'host-conformance',
      policy: {
        addressPolicy: 'selected-scope',
        continuityPolicy: 'host-incarnation',
        lifecycleOwner: 'externally-owned',
        replaySemantics: 'full-source-replay',
      },
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    })
    ctx.db.participantRegistrations.insertAttempt({
      attemptId: 'patt-conformance',
      registrationId: 'preg-conformance',
      attachEpoch: 1,
      requestId: 'req-conformance',
      operationId: 'op-conformance',
      invocationId,
      runtimeId,
      state: 'ACTIVE',
      preparedDescriptorJson: '{}',
      adapterDispatchEnvJson: '{}',
      recoveryDisposition: 'unresolved',
      establishmentWorkState: 'completed',
      establishmentAttemptCount: 0,
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    })
  }
  return session
}
