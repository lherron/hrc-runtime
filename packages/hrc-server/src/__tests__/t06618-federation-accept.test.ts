import { describe, expect, test } from 'bun:test'

import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { FederationAcceptCrashError, createFederationAcceptHandler } from '../federation/accept.js'
import { formatDmPayload } from '../messages.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06618'
const SESSION = `${SCOPE}/lane:default`

function envelope(messageId = 'msg-11111111-1111-4111-8111-111111111111') {
  return {
    protocolVersion: '1.7',
    messageId,
    kind: 'dm' as const,
    phase: 'request' as const,
    from: {
      kind: 'session' as const,
      sessionRef: 'agent:mable:project:hrc-runtime:task:minisvc/lane:main',
    },
    to: { kind: 'session' as const, sessionRef: SESSION },
    body: 'federated hello',
    rootMessageId: messageId,
    expected: { homeNodeId: 'lab', placementEpoch: 4 },
    futureEnvelopeField: { safely: 'ignored' },
  }
}

function installPlacement(
  db: ReturnType<typeof openHrcDatabase>,
  patch: {
    homeNodeId?: string
    placementEpoch?: number
  } = {}
) {
  createPlacementLedgerRepository(db.sqlite).installActive({
    scopeRef: SCOPE,
    homeNodeId: patch.homeNodeId ?? 'lab',
    placementEpoch: patch.placementEpoch ?? 4,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'pin' },
    establishmentProvenance: 'pin',
    updatedAt: '2026-07-20T00:00:00.000Z',
  })
}

describe('T-06618 durable idempotent federation receiver', () => {
  test('accepts a tolerant envelope once and duplicate delivery does not insert or dispatch twice', async () => {
    const db = openHrcDatabase(':memory:')
    installPlacement(db)
    const delivered: string[] = []
    const accept = createFederationAcceptHandler({
      db,
      localNodeId: 'lab',
      onAccepted: async ({ record }) => delivered.push(record.messageId),
    })

    try {
      const first = await accept({
        authenticatedNodeId: 'svc',
        protocolVersion: '1.7',
        envelope: envelope(),
      })
      expect(first).toMatchObject({ outcome: 'accepted', messageId: envelope().messageId })
      if (first.outcome === 'accepted') await first.afterAck?.()

      const firstSeq = db.messages.maxSeq()
      const duplicate = await accept({
        authenticatedNodeId: 'svc',
        protocolVersion: '1.7',
        envelope: envelope(),
      })

      expect(duplicate).toEqual({ outcome: 'duplicate', messageId: envelope().messageId })
      expect(db.messages.maxSeq()).toBe(firstSeq)
      expect(db.messages.query({})).toHaveLength(1)
      expect(delivered).toEqual([envelope().messageId])
      expect(db.messages.getById(envelope().messageId)).toMatchObject({
        messageSeq: 1,
        rootMessageId: envelope().messageId,
        body: 'federated hello',
      })
    } finally {
      db.close()
    }
  })

  test('a newer local placement tuple visibly redirects stale routing before insertion', async () => {
    const db = openHrcDatabase(':memory:')
    installPlacement(db, { homeNodeId: 'lab-next', placementEpoch: 5 })
    const accept = createFederationAcceptHandler({ db, localNodeId: 'lab' })

    try {
      const result = await accept({
        authenticatedNodeId: 'svc',
        protocolVersion: '1.7',
        envelope: envelope(),
      })
      expect(result).toEqual({
        outcome: 'refused',
        code: 'stale_placement',
        retryable: true,
        status: 409,
        redirect: { homeNodeId: 'lab-next', placementEpoch: 5 },
      })
      expect(db.messages.getById(envelope().messageId)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('repairs a missing local authority row from the exact registry binding without losing sender attribution', async () => {
    const db = openHrcDatabase(':memory:')
    const binding = {
      scopeRef: SCOPE,
      homeNodeId: 'lab',
      placementEpoch: 4,
      birthClass: 'policy-born' as const,
      authorityProvenance: { kind: 'policy' as const, source: 'pin' as const },
      establishmentProvenance: 'pin' as const,
      updatedAt: '2026-07-20T00:00:00.000Z',
    }
    const accept = createFederationAcceptHandler({
      db,
      localNodeId: 'lab',
      registry: { consult: async () => ({ outcome: 'bound', binding }) },
    })

    try {
      const result = await accept({
        authenticatedNodeId: 'svc',
        protocolVersion: '1.7',
        envelope: envelope(),
      })

      expect(result).toMatchObject({ outcome: 'accepted', messageId: envelope().messageId })
      expect(createPlacementLedgerRepository(db.sqlite).activeAuthority(SCOPE)).toMatchObject(
        binding
      )
      const record = db.messages.getById(envelope().messageId)
      expect(record?.from).toEqual(envelope().from)
      expect(record?.metadataJson).toMatchObject({
        federationIngress: { authenticatedNodeId: 'svc' },
      })
      expect(
        formatDmPayload(
          record!.from,
          record!.to,
          record!.body,
          record!.messageSeq,
          record!.messageId
        )
      ).toContain('hrcchat dm mable@hrc-runtime:minisvc --reply-to')
    } finally {
      db.close()
    }
  })

  test('does not activate a registry rebind tuple at federation ingress', async () => {
    const db = openHrcDatabase(':memory:')
    const accept = createFederationAcceptHandler({
      db,
      localNodeId: 'lab',
      registry: {
        consult: async () => ({
          outcome: 'bound',
          binding: {
            scopeRef: SCOPE,
            homeNodeId: 'lab',
            placementEpoch: 4,
            birthClass: 'policy-born',
            authorityProvenance: { kind: 'policy', source: 'pin' },
            establishmentProvenance: 'rebind',
            priorHomeNodeId: 'svc',
            updatedAt: '2026-07-20T00:00:00.000Z',
          },
        }),
      },
    })

    try {
      await expect(
        accept({
          authenticatedNodeId: 'svc',
          protocolVersion: '1.7',
          envelope: envelope(),
        })
      ).resolves.toEqual({
        outcome: 'refused',
        code: 'placement_unknown',
        retryable: true,
        status: 409,
      })
      expect(createPlacementLedgerRepository(db.sqlite).get(SCOPE)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('crash before ACK and retry converges to duplicate; crash after ACK does too', async () => {
    const beforeAckDb = openHrcDatabase(':memory:')
    installPlacement(beforeAckDb)
    let crash = true
    const beforeAck = createFederationAcceptHandler({
      db: beforeAckDb,
      localNodeId: 'lab',
      afterDurableAcceptance: () => {
        if (crash) throw new FederationAcceptCrashError('simulated crash before ACK')
      },
    })

    try {
      await expect(
        beforeAck({
          authenticatedNodeId: 'svc',
          protocolVersion: '1.7',
          envelope: envelope(),
        })
      ).rejects.toBeInstanceOf(FederationAcceptCrashError)
      expect(beforeAckDb.messages.getById(envelope().messageId)).toBeDefined()

      crash = false
      await expect(
        beforeAck({
          authenticatedNodeId: 'svc',
          protocolVersion: '1.7',
          envelope: envelope(),
        })
      ).resolves.toEqual({ outcome: 'duplicate', messageId: envelope().messageId })
    } finally {
      beforeAckDb.close()
    }

    const afterAckDb = openHrcDatabase(':memory:')
    installPlacement(afterAckDb)
    const afterAck = createFederationAcceptHandler({ db: afterAckDb, localNodeId: 'lab' })
    try {
      await expect(
        afterAck({
          authenticatedNodeId: 'svc',
          protocolVersion: '1.7',
          envelope: envelope('msg-22222222-2222-4222-8222-222222222222'),
        })
      ).resolves.toMatchObject({ outcome: 'accepted' })
      await expect(
        afterAck({
          authenticatedNodeId: 'svc',
          protocolVersion: '1.7',
          envelope: envelope('msg-22222222-2222-4222-8222-222222222222'),
        })
      ).resolves.toEqual({
        outcome: 'duplicate',
        messageId: 'msg-22222222-2222-4222-8222-222222222222',
      })
    } finally {
      afterAckDb.close()
    }
  })

  test('records the accepted-request ACK idempotently at the origin', () => {
    const db = openHrcDatabase(':memory:')
    try {
      const input = {
        requestMessageId: envelope().messageId,
        acceptedByNodeId: 'lab',
        acceptedEpoch: 4,
      }
      expect(db.federationAcceptedRequests.record(input)).toMatchObject({ outcome: 'recorded' })
      expect(db.federationAcceptedRequests.record(input)).toMatchObject({ outcome: 'duplicate' })
      expect(db.federationAcceptedRequests.get(input.requestMessageId)).toMatchObject(input)
      expect(() =>
        db.federationAcceptedRequests.record({ ...input, acceptedByNodeId: 'svc' })
      ).toThrow(/conflicting accepted-request ACK/)
    } finally {
      db.close()
    }
  })
})
