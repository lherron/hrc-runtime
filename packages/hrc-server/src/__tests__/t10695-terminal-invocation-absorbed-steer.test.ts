import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import {
  UNRESOLVED_ABSORBED_OWNER_MARKER,
  hasUnsettledAbsorbedAuxiliary,
  settleTerminalInvocationAbsorbedAuxiliaries,
} from '../broker/turn-ownership'
import { type HrcServer, createHrcServer } from '../index'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture'
import { type OfflineRuntime, seedOfflineRuntime } from './fixtures/t08566-offline-reader-double'

// Recorded on rt-e2250e39 (2026-10-11): steers _10 and _16 were absorbed into
// turns that never reached a terminal, and the invocation was disposed by
// operator_evict. No broker event can ever settle them, and nothing applied the
// unresolved-owner marker, so the operator disposal Lance ruled on T-10573 was
// refused forever as unsettled_absorbed_auxiliary.

const STEER = 'submission-t10695-steer'
const STEER_RUN = 'run-t10695-steer'
const TURN = 'turn-t10695-never-terminal'

let fixture: HrcServerTestFixture
let server: HrcServer
let seeded: OfflineRuntime

function seedAbsorbedSteer(invocationState: 'disposed' | 'ready'): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    const invocation = db.brokerInvocations.getByInvocationId(seeded.invocationId)
    db.brokerInvocations.update(seeded.invocationId, { invocationState, updatedAt: now })
    db.runs.insert({
      runId: STEER_RUN,
      hostSessionId: seeded.hostSessionId,
      runtimeId: seeded.runtimeId,
      scopeRef: seeded.scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      status: 'failed',
      acceptedAt: now,
      completedAt: now,
      updatedAt: now,
      errorCode: 'run_abandoned_by_runtime',
      errorMessage: 'run abandoned by runtime',
      operationId: invocation?.operationId,
      invocationId: seeded.invocationId,
      dispatchedInputId: STEER,
      brokerSubmissionId: STEER,
    })
    const append = (seq: number, type: string, payload: unknown) =>
      db.brokerInvocationEvents.appendEvent({
        invocationId: seeded.invocationId,
        seq,
        time: now,
        type,
        runtimeId: seeded.runtimeId,
        payload,
      })
    append(1, 'turn.started', { turnId: TURN })
    append(2, 'admission.admitted', { submissionId: STEER, class: 'steer' })
    append(3, 'submission.absorbed', { submissionId: STEER, turnId: TURN })
  } finally {
    db.close()
  }
}

function withDb<T>(fn: (db: ReturnType<typeof openHrcDatabase>) => T): T {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return fn(db)
  } finally {
    db.close()
  }
}

function dispose(extra: Record<string, unknown>) {
  return fixture.postJson('/v1/runtimes/prune', {
    runtimeIds: [seeded.runtimeId],
    disposeRetainedEvidence: true,
    reason: 'T-10695 test disposal',
    ...extra,
  })
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('t10695-')
  server = await createHrcServer(fixture.serverOpts())
  seeded = await seedOfflineRuntime(fixture, 'full')
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

describe('T-10695 absorbed steer whose invocation is terminal', () => {
  it('is settled with the unresolved-owner marker once its invocation is terminal', () => {
    seedAbsorbedSteer('disposed')
    withDb((db) => {
      settleTerminalInvocationAbsorbedAuxiliaries(db, seeded.runtimeId, fixture.now())
      const run = db.runs.getByRunId(STEER_RUN)
      expect(run?.status).toBe('failed')
      expect(run?.errorCode).toBe('run_abandoned_by_runtime')
      expect(run?.errorMessage).toContain('run abandoned by runtime; ')
      expect(run?.errorMessage).toContain(UNRESOLVED_ABSORBED_OWNER_MARKER)
      expect(hasUnsettledAbsorbedAuxiliary(db, seeded.runtimeId)).toBe(false)
    })
  })

  it('stays unsettled while the absorbing turn is open on a live invocation (control)', () => {
    seedAbsorbedSteer('ready')
    withDb((db) => {
      settleTerminalInvocationAbsorbedAuxiliaries(db, seeded.runtimeId, fixture.now())
      expect(db.runs.getByRunId(STEER_RUN)?.errorMessage).toBe('run abandoned by runtime')
      expect(hasUnsettledAbsorbedAuxiliary(db, seeded.runtimeId)).toBe(true)
    })
  })

  it('dry-run disposal reports what --yes would do, and --yes disposes', async () => {
    seedAbsorbedSteer('disposed')
    const dryRun = await dispose({ dryRun: true })
    expect(await dryRun.json()).toMatchObject({
      results: [{ runtimeId: seeded.runtimeId, status: 'skipped', reason: 'dry_run_disposition' }],
    })
    // The dry run mutates nothing.
    expect(withDb((db) => db.runs.getByRunId(STEER_RUN)?.errorMessage)).toBe(
      'run abandoned by runtime'
    )

    const applied = await dispose({ yes: true })
    expect(await applied.json()).toMatchObject({
      results: [{ runtimeId: seeded.runtimeId, status: 'pruned', reason: 'operator_disposed' }],
    })
    withDb((db) => {
      expect(db.runtimes.getByRuntimeId(seeded.runtimeId)).toBeNull()
      expect(
        db.retainedEvidenceOutcomes.latest(seeded.runtimeId, seeded.invocationId)?.outcome
      ).toBe('operator_disposed')
    })
  })

  it('still refuses disposal while the invocation is live (control)', async () => {
    seedAbsorbedSteer('ready')
    const dryRun = await dispose({ dryRun: true })
    expect(await dryRun.json()).toMatchObject({
      results: [
        { runtimeId: seeded.runtimeId, status: 'skipped', reason: 'unsettled_absorbed_auxiliary' },
      ],
    })
  })
})
