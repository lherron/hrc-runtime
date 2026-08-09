import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from '../index.js'
import type { ExternalRegistrationGrant } from '../index.js'

describe('T-07134 external registration grant persistence', () => {
  let tempDir: string
  let dbPath: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'hrc-registration-grants-'))
    dbPath = join(tempDir, 'state.sqlite')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const grant = (patch: Partial<ExternalRegistrationGrant> = {}): ExternalRegistrationGrant => ({
    registrationId: 'registration-a',
    classId: 'arris-agent',
    derivedScope: 'agent:arris:project:arris:task:reg-aaaaaaaaaaaaaaaaaaaaaaaa',
    socketPath: '/tmp/arris-a.sock',
    credentialHash: 'hash-only',
    expiresAt: '2026-08-09T20:01:00.000Z',
    consumed: false,
    turnsAllowed: false,
    provisioner: { name: 'arris', pid: 123 },
    createdAt: '2026-08-09T20:00:00.000Z',
    ...patch,
  })

  test('migrates and round-trips the hash-only A2 read surface', () => {
    const db = openHrcDatabase(dbPath)
    try {
      expect(db.migrations.applied).toContain('0037_external_registration_grants')
      expect(db.migrations.applied).toContain('0038_external_registration_mint')
      expect(
        db.externalRegistrationGrants.issueWithinCapacity(grant(), 1, '2026-08-09T20:00:00.000Z')
      ).toMatchObject({ outcome: 'issued' })
      expect(db.externalRegistrationGrants.getByRegistrationId('registration-a')).toEqual(grant())
    } finally {
      db.close()
    }
  })

  test('frees expired-unconsumed capacity but successful hello consumption remains occupied', () => {
    const db = openHrcDatabase(dbPath)
    try {
      db.externalRegistrationGrants.issueWithinCapacity(grant(), 1, '2026-08-09T20:00:00.000Z')
      expect(
        db.externalRegistrationGrants.issueWithinCapacity(
          grant({ registrationId: 'registration-b', derivedScope: `${grant().derivedScope}-b` }),
          1,
          '2026-08-09T20:00:30.000Z'
        )
      ).toEqual({ outcome: 'instances-exhausted', occupied: 1 })

      expect(
        db.externalRegistrationGrants.consumeIfAvailable(
          'registration-a',
          '2026-08-09T20:00:30.000Z'
        )
      ).toBe(true)
      expect(
        db.externalRegistrationGrants.consumeIfAvailable(
          'registration-a',
          '2026-08-09T20:00:31.000Z'
        )
      ).toBe(false)
      expect(
        db.externalRegistrationGrants.countCapacityOccupants(
          'arris-agent',
          '2027-01-01T00:00:00.000Z'
        )
      ).toBe(1)

      db.sqlite.exec('DELETE FROM external_registration_grants')
      db.externalRegistrationGrants.issueWithinCapacity(grant(), 1, '2026-08-09T20:00:00.000Z')
      expect(
        db.externalRegistrationGrants.countCapacityOccupants(
          'arris-agent',
          '2026-08-09T20:02:00.000Z'
        )
      ).toBe(0)
    } finally {
      db.close()
    }
  })

  test('projects only live unconsumed and delivery-pending rows for restart rendezvous', () => {
    const db = openHrcDatabase(dbPath)
    try {
      const pending = grant({ registrationId: 'registration-pending' })
      const expired = grant({
        registrationId: 'registration-expired',
        derivedScope: `${grant().derivedScope}-expired`,
        expiresAt: '2026-08-09T19:59:00.000Z',
      })
      db.externalRegistrationGrants.issueWithinCapacity(pending, 4, pending.createdAt)
      db.externalRegistrationGrants.issueWithinCapacity(expired, 4, expired.createdAt)
      expect(
        db.externalRegistrationGrants.consumeIfAvailable(
          pending.registrationId,
          '2026-08-09T20:00:30.000Z'
        )
      ).toBe(true)
      db.externalRegistrationGrants.recordMint(pending.registrationId, {
        hostSessionId: 'hsid-pending',
        runtimeId: 'rt-pending',
        operationId: 'op-pending',
        invocationId: 'inv-pending',
        attachTokenRef: '/tmp/pending.token',
        controllerInstanceId: 'controller-pending',
        capabilities: { events: true, turns: false, continuations: false },
        participantInfo: { name: 'pending' },
      })
      expect(
        db.externalRegistrationGrants
          .listRendezvousCandidates('2026-08-09T20:02:00.000Z')
          .map((candidate) => candidate.registrationId)
      ).toEqual(['registration-pending'])
      expect(
        db.externalRegistrationGrants.markEstablished(
          pending.registrationId,
          '2026-08-09T20:02:01.000Z'
        )
      ).toBe(true)
      expect(
        db.externalRegistrationGrants.listRendezvousCandidates('2026-08-09T20:02:02.000Z')
      ).toEqual([])
      expect(db.externalRegistrationGrants.listEstablished()).toEqual([
        expect.objectContaining({
          registrationId: pending.registrationId,
          establishmentState: 'ESTABLISHED',
        }),
      ])
    } finally {
      db.close()
    }
  })
})
