import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { BrokerControllerError } from '../broker/controller/errors.js'
import { markBrokerCrashTerminal } from '../broker/controller/lifecycle.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { observeAttempt } from '../mail-kicker-handlers.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import { serverInternals } from './fixtures/mail-kicker-harness.js'

const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07908'
const TARGET = `${SCOPE}/lane:main`
const HOST_SESSION_ID = 'hsid-t07908'
const RUNTIME_ID = 'rt-t07908'
const RUN_ID = 'run-t07908'

const RUNTIME_DEAD_STATUSES = [
  'crashed',
  'terminated',
  'dead',
  'stale',
  'stopped',
  'failed',
  'disposed',
  'exited',
] as const

describe('T-07908 kicker observation', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer | undefined

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t07908-kicker-')
    server = await createHrcServer(
      fixture.serverOpts({
        hrcMailKickerEnabled: true,
        hrcMailKickerSweepIntervalMs: 60_000,
        otelListenerEnabled: false,
        wrkqLedger: new FakeWrkqLedger(),
      })
    )
  })

  afterEach(async () => {
    if (server !== undefined) await server.stop()
    await fixture.cleanup()
  })

  for (const status of RUNTIME_DEAD_STATUSES) {
    it(`finishes a claimed attempt whose accepted run belongs to a ${status} runtime`, async () => {
      const db = serverInternals(server as HrcServer).db
      const now = timestamp()
      db.sessions.insert({
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: RUNTIME_ID,
        runtimeKind: 'harness',
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status,
        statusChangedAt: now,
        supportsInflightInput: false,
        adopted: false,
        createdAt: now,
        updatedAt: now,
      })
      const claim = db.mailDrives.claim(
        TARGET,
        'insert',
        { envelopeIds: ['EN-T07908'] },
        { driveAttemptId: 'drive-t07908', runId: RUN_ID }
      )
      if (claim.outcome !== 'acquired') throw new Error('fixture failed to claim drive slot')
      const attempt = db.mailDrives.recordSession(claim.attempt.driveAttemptId, {
        hostSessionId: HOST_SESSION_ID,
        generation: 1,
        runtimeId: RUNTIME_ID,
      })
      db.runs.insert({
        runId: RUN_ID,
        hostSessionId: HOST_SESSION_ID,
        runtimeId: RUNTIME_ID,
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        status: 'accepted',
        acceptedAt: now,
        updatedAt: now,
      })

      const observation = observeAttempt(
        server as unknown as Parameters<typeof observeAttempt>[0],
        attempt
      )

      expect(observation).toBe('finished')
      expect(db.mailDrives.getAttempt(claim.attempt.driveAttemptId)).toMatchObject({
        state: 'failed',
        completedAt: expect.any(String),
      })
      expect(db.mailDrives.getSlot(TARGET)?.activeDriveAttemptId).toBeUndefined()
    })
  }
})

describe('T-07908 broker crash finalization', () => {
  let dir: string
  let db: HrcDatabase

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hrc-t07908-crash-'))
    db = openHrcDatabase(join(dir, 'state.sqlite'))
  })

  afterEach(async () => {
    db.close()
    await rm(dir, { recursive: true, force: true })
  })

  it('fails the drive-owned run when neither the runtime nor invocation links it', () => {
    const now = '2026-09-02T18:43:17.000Z'
    const operationId = 'op-t07908'
    const invocationId = 'inv-t07908'
    db.sessions.insert({
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: RUNTIME_ID,
      runtimeKind: 'harness',
      hostSessionId: HOST_SESSION_ID,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      harness: 'codex-cli',
      provider: 'openai',
      controllerKind: 'harness-broker',
      activeOperationId: operationId,
      activeInvocationId: invocationId,
      status: 'busy',
      statusChangedAt: now,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
    db.runtimeOperations.insert({
      operationId,
      runtimeId: RUNTIME_ID,
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      operationKind: 'broker_invocation',
      controller: 'harness-broker',
      startupMethod: 'test',
      status: 'running',
      routeDecisionJson: '{}',
      createdAt: now,
      updatedAt: now,
    })
    db.brokerInvocations.insert({
      invocationId,
      operationId,
      runtimeId: RUNTIME_ID,
      brokerProtocol: 'harness-broker/0.2',
      brokerDriver: 'codex-app-server',
      invocationState: 'turn_active',
      capabilitiesJson: '{}',
      specHash: 'spec-t07908',
      startRequestHash: 'request-t07908',
      selectedProfileHash: 'profile-t07908',
      createdAt: now,
      updatedAt: now,
    })
    const claim = db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: ['EN-T07908'] },
      { driveAttemptId: 'drive-t07908', runId: RUN_ID }
    )
    if (claim.outcome !== 'acquired') throw new Error('fixture failed to claim drive slot')
    db.mailDrives.recordSession(claim.attempt.driveAttemptId, {
      hostSessionId: HOST_SESSION_ID,
      generation: 1,
      runtimeId: RUNTIME_ID,
    })
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: HOST_SESSION_ID,
      runtimeId: RUNTIME_ID,
      scopeRef: SCOPE,
      laneRef: 'main',
      generation: 1,
      transport: 'headless',
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
    })

    markBrokerCrashTerminal(
      {
        db,
        now: () => now,
        serverInstanceId: 'server-t07908',
        logger: {},
        getActiveInvocationId: () => undefined,
        getActiveClient: () => undefined,
        deleteActive: () => undefined,
        markBrokerClosing: () => undefined,
        fireBrokerTmuxLeaseReap: () => undefined,
      },
      RUNTIME_ID,
      new BrokerControllerError('broker_process_closed', 'harness broker process closed')
    )

    expect(db.runs.getByRunId(RUN_ID)).toMatchObject({
      status: 'failed',
      completedAt: now,
      errorCode: 'runtime_unavailable',
      errorMessage: 'harness broker process closed',
    })
    expect(db.runtimes.getByRuntimeId(RUNTIME_ID)?.status).toBe('crashed')
    expect(db.brokerInvocations.getByInvocationId(invocationId)?.invocationState).toBe('failed')
    expect(
      db.hrcEvents
        .listFromHrcSeq(1, { runtimeId: RUNTIME_ID })
        .find((event) => event.eventKind === 'runtime.crashed')?.runId
    ).toBe(RUN_ID)
  })
})
