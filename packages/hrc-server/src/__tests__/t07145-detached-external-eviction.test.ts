import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { access } from 'node:fs/promises'
import { join } from 'node:path'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'
import type { ExternalRegistrationGrant } from 'hrc-store-sqlite'

import {
  markExternalParticipantDetached,
  performExternalRegistrationHello,
} from '../external-registration-rendezvous.js'
import type { ExternalParticipantRpcClient } from '../external-registration-rendezvous.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { hashRegistrationCredential } from '../registration-handlers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture.js'

const REGISTRATION_ID = 'registration-t07145'
const CREDENTIAL = 'credential-t07145'
const SCOPE = 'agent:arris:project:arris:task:reg-t07145'

class HelloClient implements ExternalParticipantRpcClient {
  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'epr.hello') {
      return {
        protocolVersion: 'epr/1',
        registrationId: params['registrationId'],
        credential: CREDENTIAL,
        capabilities: { events: true, turns: false, continuations: true },
        participantInfo: { name: 'arris' },
      }
    }
    if (method === 'epr.established') return { ready: true, currentSeq: 0 }
    throw new Error(`unexpected ${method}`)
  }

  async notify(): Promise<void> {}
  async close(): Promise<void> {}
}

describe('T-07145 detached external operator eviction', () => {
  let fixture: HrcServerTestFixture
  let server: HrcServer

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t07145-detached-external-')
    server = await createHrcServer(fixture.serverOpts())
  })

  afterEach(async () => {
    await server.stop()
    await fixture.cleanup()
  })

  test('POST /v1/terminate evicts a detached external participant without changing placement', async () => {
    const internal = server as unknown as HrcServerInstanceForHandlers
    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    const grant: ExternalRegistrationGrant = {
      registrationId: REGISTRATION_ID,
      classId: 'arris-agent',
      derivedScope: SCOPE,
      socketPath: join(fixture.tmpDir, 'participant.sock'),
      credentialHash: hashRegistrationCredential(CREDENTIAL),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumed: false,
      turnsAllowed: false,
      provisioner: {},
      createdAt: now,
    }

    try {
      expect(db.externalRegistrationGrants.issueWithinCapacity(grant, 1, now).outcome).toBe(
        'issued'
      )
      const delivery = (
        await performExternalRegistrationHello(internal, REGISTRATION_ID, new HelloClient())
      ).delivery
      const linked = db.externalRegistrationGrants.getByRegistrationId(REGISTRATION_ID)
      if (!linked?.attachTokenRef) throw new Error('external registration mint linkage missing')

      const ledger = createPlacementLedgerRepository(db.sqlite)
      const binding = ledger.installActive({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'explicit_local' },
        establishmentProvenance: 'explicit_local',
        updatedAt: now,
      })

      markExternalParticipantDetached(internal, linked, 600_000, {
        reason: 'socket_closed',
      })
      expect(db.runtimes.getByRuntimeId(delivery.runtimeId)).toMatchObject({
        status: 'detached',
        runtimeStateJson: { lifecycleOwner: 'external' },
      })

      const response = await fixture.postJson('/v1/terminate', {
        runtimeId: delivery.runtimeId,
      })

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        ok: true,
        runtimeId: delivery.runtimeId,
        droppedContinuation: false,
      })
      expect(db.runtimes.getByRuntimeId(delivery.runtimeId)).toMatchObject({
        status: 'terminated',
        lifecycleTerminalReason: 'operator_evict',
        runtimeStateJson: {
          lifecycleOwner: 'external',
          terminalReason: 'operator_evict',
          externalRegistration: {
            finalReason: 'operator_evict',
            attachTokenRevokedAt: expect.any(String),
          },
        },
      })
      expect(db.brokerInvocations.getByInvocationId(delivery.invocationId)).toMatchObject({
        invocationState: 'disposed',
        lifecycleTerminalReason: 'operator_evict',
      })
      await expect(access(linked.attachTokenRef)).rejects.toThrow()
      expect(ledger.get(SCOPE)).toEqual(binding)
    } finally {
      db.close()
    }
  })
})
