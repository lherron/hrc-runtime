import { describe, expect, test } from 'bun:test'

import { openHrcDatabase } from '../index.js'
import type {
  ParticipantAttempt,
  ParticipantAttemptState,
  ParticipantRegistration,
} from '../index.js'
import { brokerMigrations } from '../migrations/broker-migrations.js'
import { schemaMigrations } from '../migrations/schema-migrations.js'

const registration = (): ParticipantRegistration => ({
  registrationId: 'preg-1',
  // Every pre-protocol-join registration is `legacy`, and keeps every one of
  // its identity columns (R7.1).
  registrationMode: 'legacy',
  classId: 'controlled-participant',
  adapterId: 'controlled-participant',
  join: 'hrc-hosted',
  participantKey: 'opaque-permanent-key',
  scopeRef: 'agent:smokey:project:hrc-runtime:task:participant-1',
  laneRef: 'main',
  hostSessionId: 'hsid-participant-1',
  generation: 1,
  workspaceCwd: '/tmp/workspace',
  socketPath: '/tmp/participant.sock',
  preparationJson: '{"opaque":true}',
  continuityEvidenceJson: '{"continuity":"known"}',
  createdAt: '2026-09-09T21:10:00.000Z',
  updatedAt: '2026-09-09T21:10:00.000Z',
})

const attempt = (overrides: Partial<ParticipantAttempt> = {}): ParticipantAttempt => ({
  attemptId: 'patt-1',
  registrationId: 'preg-1',
  attachEpoch: 1,
  requestId: 'req-participant-1',
  operationId: 'op-participant-1',
  invocationId: 'inv-participant-1',
  runtimeId: 'rt-participant-1',
  state: 'REGISTERED',
  recoveryDisposition: 'unresolved',
  establishmentWorkState: 'pending',
  establishmentAttemptCount: 0,
  createdAt: '2026-09-09T21:10:00.000Z',
  updatedAt: '2026-09-09T21:10:00.000Z',
  ...overrides,
})

describe('T-08516 reconnect arming (R7.6 durable bounded retry)', () => {
  const armed = (patch: Partial<ParticipantAttempt> = {}) => {
    const db = openHrcDatabase(':memory:')
    db.participantRegistrations.insertRegistration(registration())
    db.participantRegistrations.insertAttempt(
      attempt({
        state: 'ACTIVE',
        preparedProfileJson: '{"kind":"harness-broker"}',
        adapterDispatchEnvJson: '{}',
        establishmentWorkState: 'completed',
        ...patch,
      })
    )
    return db
  }

  test('arms a new cycle from an activated, completed attempt', () => {
    const db = armed()
    try {
      expect(db.participantRegistrations.armParticipantReconnect('patt-1', 'NOW')).toBe(true)
      const after = db.participantRegistrations.getAttempt('patt-1')
      expect(after).toMatchObject({
        establishmentWorkState: 'pending',
        establishmentAttemptCount: 0,
      })
      expect(after?.establishmentLastError).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('is idempotent: a second arm while the cycle runs changes nothing', () => {
    const db = armed()
    try {
      expect(db.participantRegistrations.armParticipantReconnect('patt-1', 'NOW')).toBe(true)
      // Now `pending`, so the predicate no longer matches and the running
      // cycle's budget is left alone.
      expect(db.participantRegistrations.armParticipantReconnect('patt-1', 'LATER')).toBe(false)
    } finally {
      db.close()
    }
  })

  test('never re-arms an exhausted cycle', () => {
    const db = armed({ establishmentWorkState: 'exhausted', establishmentAttemptCount: 5 })
    try {
      expect(db.participantRegistrations.armParticipantReconnect('patt-1', 'NOW')).toBe(false)
      expect(db.participantRegistrations.getAttempt('patt-1')).toMatchObject({
        establishmentWorkState: 'exhausted',
        establishmentAttemptCount: 5,
      })
    } finally {
      db.close()
    }
  })

  test('an armed cycle stopped mid-flight is found again by establishment work', () => {
    // The stranding this replaces: `stageExistingParticipantAttachment`
    // persists ACTIVE -> DETACHED before awaiting install/hello, so a broker
    // outage or a crash there leaves an intermediate state. Once ARMED, the
    // row is pending and `listEstablishmentWork` finds it whatever state it
    // stopped in -- which is exactly what was impossible while it stayed
    // `completed`.
    const db = armed()
    try {
      db.participantRegistrations.armParticipantReconnect('patt-1', 'NOW')
      expect(
        db.participantRegistrations.transitionAttempt('patt-1', ['ACTIVE'], 'DETACHED', 'NOW')
      ).toBe(true)
      expect(db.participantRegistrations.listEstablishmentWork().map((a) => a.attemptId)).toContain(
        'patt-1'
      )
    } finally {
      db.close()
    }
  })

  test('a DETACHED attempt left at completed is invisible, which is the bug', () => {
    const db = armed()
    try {
      db.participantRegistrations.transitionAttempt('patt-1', ['ACTIVE'], 'DETACHED', 'NOW')
      // Not armed: every re-entry door excludes it. This case exists so the
      // stranding cannot come back silently.
      expect(db.participantRegistrations.listEstablishmentWork()).toEqual([])
      expect(db.participantRegistrations.listActivatedAttempts()).toEqual([])
      expect(db.participantRegistrations.armParticipantReconnect('patt-1', 'NOW')).toBe(false)
    } finally {
      db.close()
    }
  })

  test('only the current attempt of a registration is offered for reconnect', () => {
    const db = armed()
    try {
      db.participantRegistrations.insertAttempt(
        attempt({
          attemptId: 'patt-2',
          attachEpoch: 2,
          invocationId: 'inv-participant-2',
          runtimeId: 'rt-participant-2',
          state: 'ACTIVE',
          preparedProfileJson: '{"kind":"harness-broker"}',
          adapterDispatchEnvJson: '{}',
          establishmentWorkState: 'completed',
        })
      )
      expect(db.participantRegistrations.listActivatedAttempts().map((a) => a.attemptId)).toEqual([
        'patt-2',
      ])
    } finally {
      db.close()
    }
  })
})

describe('T-08349 generic participant persistence boundaries', () => {
  test('reserves the permanent key and atomically freezes the prepared boundary', () => {
    const db = openHrcDatabase(':memory:')
    try {
      expect(db.migrations.applied).toContain('0064_participant_registration_lifecycle')
      expect(db.migrations.applied).toContain('0065_participant_broker_identity')
      expect(db.migrations.applied).toContain('0066_participant_recovery_and_work')
      expect(db.migrations.applied).toContain('0067_participant_activation_work_repair')
      expect(db.migrations.applied).toContain('0068_participant_successor_evidence')
      expect(db.migrations.applied).toContain('0056_participant_runtime_ownership_repair')
      db.sqlite.transaction(() => {
        db.participantRegistrations.insertRegistration(registration())
        db.participantRegistrations.insertAttempt(attempt())
      })()

      expect(
        db.participantRegistrations.getRegistrationByClassAndKey(
          'controlled-participant',
          'opaque-permanent-key'
        )
      ).toEqual(registration())
      expect(
        db.participantRegistrations.freezePreparedBoundaryIfAbsent(
          'patt-1',
          '{"profile":"opaque"}',
          '{"adapter":"env"}',
          '2026-09-09T21:10:01.000Z'
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.freezePreparedBoundaryIfAbsent(
          'patt-1',
          '{"profile":"replacement"}',
          '{"adapter":"replacement"}',
          '2026-09-09T21:10:02.000Z'
        )
      ).toBe(false)
      expect(db.participantRegistrations.getAttempt('patt-1')).toMatchObject({
        preparedProfileJson: '{"profile":"opaque"}',
        adapterDispatchEnvJson: '{"adapter":"env"}',
      })
    } finally {
      db.close()
    }
  })

  test('requires attach-confirmed first activation but reconnects without reactivating', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.participantRegistrations.insertRegistration(registration())
      db.participantRegistrations.insertAttempt(attempt())

      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['REGISTERED'],
          'ACTIVE',
          '2026-09-09T21:10:01.000Z'
        )
      ).toBe(false)

      const firstActivationPath: readonly [ParticipantAttemptState, ParticipantAttemptState][] = [
        ['REGISTERED', 'IDENTITY_MINTED'],
        ['IDENTITY_MINTED', 'PREPARED'],
        ['PREPARED', 'HOSTING_INTENT_PERSISTED'],
        ['HOSTING_INTENT_PERSISTED', 'REALIZED'],
        ['REALIZED', 'DISPATCH_FROZEN'],
        ['DISPATCH_FROZEN', 'INSTALL_CONFIRMED'],
        ['INSTALL_CONFIRMED', 'INVOCATION_READY'],
        ['INVOCATION_READY', 'ATTACH_CONFIRMED'],
      ]
      for (const [from, to] of firstActivationPath) {
        expect(
          db.participantRegistrations.transitionAttempt(
            'patt-1',
            [from],
            to,
            '2026-09-09T21:10:02.000Z'
          )
        ).toBe(true)
      }
      expect(
        db.participantRegistrations.confirmInitialActivation('patt-1', '2026-09-09T21:10:03.000Z')
      ).toBe(true)
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['ACTIVE'],
          'DETACHED',
          '2026-09-09T21:10:04.000Z'
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['DETACHED'],
          'ATTACH_CONFIRMED',
          '2026-09-09T21:10:05.000Z'
        )
      ).toBe(true)

      expect(
        db.participantRegistrations.confirmInitialActivation('patt-1', '2026-09-09T21:10:06.000Z')
      ).toBe(false)
      expect(
        db.participantRegistrations.confirmReattachment('patt-1', '2026-09-09T21:10:07.000Z')
      ).toBe(true)
      expect(db.participantRegistrations.getAttempt('patt-1')).toMatchObject({
        state: 'ACTIVE',
        initialActivationConfirmedAt: '2026-09-09T21:10:03.000Z',
        establishmentWorkState: 'pending',
      })
    } finally {
      db.close()
    }
  })

  test('repairs only generic participant ACTIVE work and runtime lifecycle ownership', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.participantRegistrations.insertRegistration(registration())
      db.participantRegistrations.insertAttempt(
        attempt({ state: 'ACTIVE', establishmentWorkState: 'completed' })
      )
      db.sessions.insert({
        hostSessionId: 'hsid-participant-1',
        scopeRef: registration().scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: '2026-09-09T21:10:00.000Z',
        updatedAt: '2026-09-09T21:10:00.000Z',
        ancestorScopeRefs: [],
      })
      db.sessions.insert({
        hostSessionId: 'hsid-unrelated',
        scopeRef: 'agent:test:project:hrc-runtime:task:unrelated',
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: '2026-09-09T21:10:00.000Z',
        updatedAt: '2026-09-09T21:10:00.000Z',
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId: 'rt-participant-1',
        hostSessionId: 'hsid-participant-1',
        scopeRef: registration().scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        runtimeStateJson: { kind: 'harness-broker' },
        createdAt: '2026-09-09T21:10:00.000Z',
        updatedAt: '2026-09-09T21:10:00.000Z',
      })
      db.runtimes.insert({
        runtimeId: 'rt-unrelated',
        hostSessionId: 'hsid-unrelated',
        scopeRef: 'agent:test:project:hrc-runtime:task:unrelated',
        laneRef: 'main',
        generation: 1,
        transport: 'headless',
        harness: 'codex-cli',
        provider: 'openai',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        runtimeStateJson: { kind: 'harness-broker' },
        createdAt: '2026-09-09T21:10:00.000Z',
        updatedAt: '2026-09-09T21:10:00.000Z',
      })

      const repair = schemaMigrations.find(
        (migration) => migration.id === '0067_participant_activation_work_repair'
      )
      if (repair === undefined) throw new Error('participant activation repair migration missing')
      repair.apply(db.sqlite)
      const ownershipRepair = brokerMigrations.find(
        (migration) => migration.id === '0056_participant_runtime_ownership_repair'
      )
      if (ownershipRepair === undefined) {
        throw new Error('participant runtime ownership repair migration missing')
      }
      ownershipRepair.apply(db.sqlite)

      expect(db.participantRegistrations.getAttempt('patt-1')).toMatchObject({
        state: 'ACTIVE',
        establishmentWorkState: 'pending',
      })
      expect(db.runtimes.getByRuntimeId('rt-participant-1')?.runtimeStateJson).toMatchObject({
        lifecycleOwner: 'external',
      })
      expect(db.runtimes.getByRuntimeId('rt-unrelated')?.runtimeStateJson).toEqual({
        kind: 'harness-broker',
      })
    } finally {
      db.close()
    }
  })

  test('distinguishes a producer terminal from verified writer-death abandonment', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.participantRegistrations.insertRegistration(registration())
      db.participantRegistrations.insertAttempt(
        attempt({ attemptId: 'patt-terminal', state: 'ACTIVE' })
      )
      db.participantRegistrations.insertAttempt(
        attempt({
          attemptId: 'patt-writer-death',
          attachEpoch: 2,
          invocationId: 'inv-participant-2',
          runtimeId: 'rt-participant-2',
          state: 'ACTIVE',
        })
      )

      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-terminal',
          ['ACTIVE'],
          'TERMINAL',
          '2026-09-09T21:10:08.000Z',
          'producer-authored-terminal-projected'
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-writer-death',
          ['ACTIVE'],
          'ABANDONED',
          '2026-09-09T21:10:08.000Z',
          'verified-writer-death'
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-terminal',
          ['TERMINAL'],
          'ACTIVE',
          '2026-09-09T21:10:09.000Z'
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  test('persists restart-discoverable retries and exhausts work without abandoning ownership', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.participantRegistrations.insertRegistration(registration())
      db.participantRegistrations.insertAttempt(attempt())

      expect(db.participantRegistrations.listEstablishmentWork()).toHaveLength(1)
      expect(
        db.participantRegistrations.recordEstablishmentFailure({
          attemptId: 'patt-1',
          attachEpoch: 1,
          failedAt: '2026-09-15T14:00:00.000Z',
          nextAttemptAt: '2026-09-15T14:00:00.100Z',
          error: 'transient broker refusal',
          maxAttempts: 2,
        })
      ).toMatchObject({
        state: 'REGISTERED',
        establishmentWorkState: 'retry_wait',
        establishmentAttemptCount: 1,
        establishmentNextAttemptAt: '2026-09-15T14:00:00.100Z',
        recoveryDisposition: 'unresolved',
      })
      expect(
        db.participantRegistrations.recordEstablishmentFailure({
          attemptId: 'patt-1',
          attachEpoch: 1,
          failedAt: '2026-09-15T14:00:00.100Z',
          nextAttemptAt: '2026-09-15T14:00:00.200Z',
          error: 'still unavailable',
          maxAttempts: 2,
        })
      ).toMatchObject({
        state: 'REGISTERED',
        establishmentWorkState: 'exhausted',
        establishmentAttemptCount: 2,
        recoveryDisposition: 'unresolved',
      })
      expect(db.participantRegistrations.listEstablishmentWork()).toEqual([])
    } finally {
      db.close()
    }
  })

  test('records recovery only for an absorbing attempt and requires a nonempty reason', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.participantRegistrations.insertRegistration(registration())
      db.participantRegistrations.insertAttempt(attempt({ state: 'ACTIVE' }))
      expect(
        db.participantRegistrations.recordRecoveryDisposition(
          'patt-1',
          'reconciled',
          'validated ledger',
          '2026-09-15T14:30:00.000Z'
        )
      ).toBe(false)
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['ACTIVE'],
          'TERMINAL',
          '2026-09-15T14:30:01.000Z',
          'producer-authored-terminal-projected'
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.recordRecoveryDisposition(
          'patt-1',
          'abandoned',
          '   ',
          '2026-09-15T14:30:02.000Z'
        )
      ).toBe(false)
      expect(
        db.participantRegistrations.recordRecoveryDisposition(
          'patt-1',
          'abandoned',
          'validated history unavailable',
          '2026-09-15T14:30:03.000Z'
        )
      ).toBe(true)
      expect(db.participantRegistrations.getAttempt('patt-1')).toMatchObject({
        recoveryDisposition: 'abandoned',
        recoveryReason: 'validated history unavailable',
      })
    } finally {
      db.close()
    }
  })
})
