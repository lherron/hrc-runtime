/** T-08576 R-B7(q) foreign-handle mutation acceptance tests. */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { finalizeRuntimeTermination } from '../server-misc'
import { markRuntimeDead } from '../startup-reconcile/runtime-mutations'
import {
  NOW,
  internal,
  makeRunningAppRun,
  post,
  seedAppIdentity,
  seedForeignRuntime,
  setUpAppSessionBirthFixture,
  tearDownAppSessionBirthFixture,
  writerOutcome,
} from './fixtures/app-session-birth.fixture'

beforeEach(setUpAppSessionBirthFixture)
afterEach(tearDownAppSessionBirthFixture)

describe('T-08576 app-session birth ownership mutations', () => {
  it('R-B7(q) real insert/update refusals protect a live app run from direct finalization', () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-direct'
    makeRunningAppRun(runId)

    const insertRuntimeId = 'rt-t08576-foreign-insert'
    const insertOutcome = writerOutcome(() =>
      seedForeignRuntime({ runtimeId: insertRuntimeId, laneRef: 'insert', activeRunId: runId })
    )
    const foreign = seedForeignRuntime({
      runtimeId: 'rt-t08576-foreign-update',
      laneRef: 'update',
    })
    const updateOutcome = writerOutcome(() =>
      internal.db.runtimes.update(foreign.runtimeId, { activeRunId: runId, updatedAt: NOW })
    )
    const beforeFinalize = internal.db.runtimes.getByRuntimeId(foreign.runtimeId)!

    finalizeRuntimeTermination(internal.db, beforeFinalize, '2026-09-17T07:11:00.000Z')

    expect({
      insertOutcome,
      insertAttemptState:
        internal.db.runtimes.getByRuntimeId(insertRuntimeId)?.status ?? ('absent' as const),
      updateOutcome,
      activeRunIdBeforeFinalize: beforeFinalize.activeRunId,
      finalizedRuntimeStatus: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status,
      appRunStatus: internal.db.runs.getByRunId(runId)?.status,
    }).toEqual({
      insertOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      insertAttemptState: 'absent',
      updateOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      activeRunIdBeforeFinalize: undefined,
      finalizedRuntimeStatus: 'terminated',
      appRunStatus: 'running',
    })
  })

  it('R-B7(q) real updateRunId refusal protects a live app run from HTTP termination', async () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-http'
    makeRunningAppRun(runId)
    const foreign = seedForeignRuntime({
      runtimeId: 'rt-t08576-foreign-update-run-id',
      laneRef: 'update-run-id',
    })
    const updateRunIdOutcome = writerOutcome(() =>
      internal.db.runtimes.updateRunId(foreign.runtimeId, runId, NOW)
    )
    const activeRunIdBeforeTerminate = internal.db.runtimes.getByRuntimeId(
      foreign.runtimeId
    )?.activeRunId

    const response = await post('/v1/terminate', { runtimeId: foreign.runtimeId })

    expect({
      updateRunIdOutcome,
      activeRunIdBeforeTerminate,
      responseStatus: response.status,
      terminatedRuntimeStatus: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status,
      appRunStatus: internal.db.runs.getByRunId(runId)?.status,
    }).toEqual({
      updateRunIdOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      activeRunIdBeforeTerminate: undefined,
      responseStatus: 200,
      terminatedRuntimeStatus: 'terminated',
      appRunStatus: 'running',
    })
  })

  it('R-B7(q) refused foreign handle survives startup-reconcile mutation without failing the app run', () => {
    seedAppIdentity()
    const runId = 'run-t08576-live-startup'
    makeRunningAppRun(runId)
    const foreign = seedForeignRuntime({
      runtimeId: 'rt-t08576-foreign-startup',
      laneRef: 'startup',
    })
    const updateOutcome = writerOutcome(() =>
      internal.db.runtimes.update(foreign.runtimeId, { activeRunId: runId, updatedAt: NOW })
    )
    const beforeMutation = internal.db.runtimes.getByRuntimeId(foreign.runtimeId)!
    const session = internal.db.sessions.getByHostSessionId(foreign.hostSessionId)!

    markRuntimeDead(internal.db, session, beforeMutation, 'runtime', {
      reason: 't08576-startup-reconcile',
    })

    expect({
      updateOutcome,
      activeRunIdBeforeMutation: beforeMutation.activeRunId,
      reconciledRuntimeStatus: internal.db.runtimes.getByRuntimeId(foreign.runtimeId)?.status,
      appRunStatus: internal.db.runs.getByRunId(runId)?.status,
    }).toEqual({
      updateOutcome: { threw: true, errorName: 'RunIdOwnershipError' },
      activeRunIdBeforeMutation: undefined,
      reconciledRuntimeStatus: 'dead',
      appRunStatus: 'running',
    })
  })
})
