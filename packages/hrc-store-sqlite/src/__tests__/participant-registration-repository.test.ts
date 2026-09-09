import { describe, expect, test } from 'bun:test'

import { openHrcDatabase } from '../index.js'
import type {
  ParticipantAttempt,
  ParticipantAttemptState,
  ParticipantRegistration,
} from '../index.js'

const registration = (): ParticipantRegistration => ({
  registrationId: 'preg-1',
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
  createdAt: '2026-09-09T21:10:00.000Z',
  updatedAt: '2026-09-09T21:10:00.000Z',
  ...overrides,
})

describe('T-08349 generic participant persistence boundaries', () => {
  test('reserves the permanent key and atomically freezes the prepared boundary', () => {
    const db = openHrcDatabase(':memory:')
    try {
      expect(db.migrations.applied).toContain('0064_participant_registration_lifecycle')
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
})
