import { describe, expect, test } from 'bun:test'

import { openHrcDatabase } from '../index.js'
import type { ParticipantAttempt, ParticipantRegistration } from '../index.js'

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
  preparationJson: '{"opaque":true}',
  continuityEvidenceJson: '{"continuity":"known"}',
  createdAt: '2026-09-09T21:10:00.000Z',
  updatedAt: '2026-09-09T21:10:00.000Z',
})

const attempt = (): ParticipantAttempt => ({
  attemptId: 'patt-1',
  registrationId: 'preg-1',
  attachEpoch: 1,
  invocationId: 'inv-participant-1',
  runtimeId: 'rt-participant-1',
  state: 'REGISTERED',
  createdAt: '2026-09-09T21:10:00.000Z',
  updatedAt: '2026-09-09T21:10:00.000Z',
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

  test('requires an explicit state transition; a stale writer cannot overwrite it', () => {
    const db = openHrcDatabase(':memory:')
    try {
      db.participantRegistrations.insertRegistration(registration())
      db.participantRegistrations.insertAttempt(attempt())
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['REGISTERED'],
          'IDENTITY_MINTED',
          '2026-09-09T21:10:01.000Z'
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['REGISTERED'],
          'ABANDONED',
          '2026-09-09T21:10:02.000Z',
          'must-not-win-stale-write'
        )
      ).toBe(false)
      const stored = db.participantRegistrations.getAttempt('patt-1')
      expect(stored).toMatchObject({ state: 'IDENTITY_MINTED' })
      expect(stored).not.toHaveProperty('dispositionReason')

      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['IDENTITY_MINTED'],
          'TERMINAL',
          '2026-09-09T21:10:03.000Z',
          'verified-death'
        )
      ).toBe(true)
      expect(
        db.participantRegistrations.transitionAttempt(
          'patt-1',
          ['TERMINAL'],
          'ACTIVE',
          '2026-09-09T21:10:04.000Z'
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })
})
