import { describe, expect, test } from 'bun:test'

import {
  createPlacementLedgerRepository,
  createScopeRetirementRepository,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type { PlacementBinding, RegistryRetirementRecord } from 'hrc-store-sqlite'

import { createFederationAcceptHandler } from '../federation/accept.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { evaluateSummonGate } from '../federation/summon-gate.js'
import type { SummonGateDeps } from '../federation/summon-gate.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06681'
const RETIRED: RegistryRetirementRecord = {
  state: 'retired',
  scopeRef: SCOPE,
  placementEpoch: 1,
  birthClass: 'policy-born',
  authorityProvenance: { kind: 'policy', source: 'pin' },
  createdAt: '2026-07-20T00:00:00.000Z',
  updatedAt: '2026-07-20T00:01:00.000Z',
  retiredHomeNodeId: 'svc',
  retiredAt: '2026-07-20T00:01:00.000Z',
  reason: 'namespace_reconciliation',
  successorNodeId: 'svc',
}

function binding(patch: Partial<PlacementBinding> = {}): PlacementBinding {
  return {
    scopeRef: SCOPE,
    homeNodeId: 'svc',
    placementEpoch: 1,
    birthClass: 'policy-born',
    authorityProvenance: { kind: 'policy', source: 'pin' },
    establishmentProvenance: 'pin',
    createdAt: '2026-07-20T00:00:00.000Z',
    updatedAt: '2026-07-20T00:00:00.000Z',
    ...patch,
  }
}

function deps(patch: Partial<SummonGateDeps> = {}): SummonGateDeps {
  return {
    mode: 'enforce',
    federationConfigured: true,
    localNodeId: 'svc',
    ledger: {
      activeAuthority: () => binding(),
      installActive: (row) => ({ ...row, state: 'active' }),
    },
    registry: {
      consult: async () => ({ outcome: 'retired', retirement: RETIRED }),
      establish: async () => ({ outcome: 'retired', retirement: RETIRED }),
    },
    policyFor: async () => ({
      placement: { pins: { 'hrc-runtime:T-06681': 'svc' } },
      claimsTask: false,
    }),
    capabilityFor: async () => ({ outcome: 'capable' }),
    ...patch,
  }
}

describe('T-06681 summon gate retirement semantics', () => {
  test('same-node policy successor ignores the fenced old ledger and becomes activatable', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        retirementFor: () => ({
          retiredNodeId: 'svc',
          retiredPlacementEpoch: 1,
          successorNodeId: 'svc',
          reason: 'namespace_reconciliation',
        }),
      }),
    })
    expect(result).toMatchObject({
      enforced: false,
      evaluation: {
        decision: 'allow',
        reason: 'retired-policy-succession',
        homeNodeId: 'svc',
        registryRetirement: RETIRED,
      },
    })
  })

  test('a local ledger above the retained fence remains authority without registry I/O', async () => {
    let consults = 0
    const registry: BindingRegistryClient = {
      consult: async () => {
        consults += 1
        return { outcome: 'retired', retirement: RETIRED }
      },
      establish: async () => ({ outcome: 'retired', retirement: RETIRED }),
    }
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        ledger: {
          activeAuthority: () => binding({ placementEpoch: 2 }),
          installActive: (row) => ({ ...row, state: 'active' }),
        },
        registry,
        retirementFor: () => ({
          retiredNodeId: 'svc',
          retiredPlacementEpoch: 1,
          successorNodeId: 'svc',
          reason: 'namespace_reconciliation',
        }),
      }),
    })
    expect(result.evaluation.reason).toBe('local-authority')
    expect(consults).toBe(0)
  })

  test('other nodes see the tombstone and cannot silently re-home the scope', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        localNodeId: 'lab',
        ledger: {
          activeAuthority: () => undefined,
          installActive: (row) => ({ ...row, state: 'active' }),
        },
        retirementFor: () => undefined,
      }),
    })
    expect(result).toMatchObject({
      enforced: true,
      evaluation: { decision: 'refuse', reason: 'scope-retired', homeNodeId: 'svc' },
    })
  })

  test('mechanism-born retirement refuses generic succession', async () => {
    const result = await evaluateSummonGate({
      scopeRef: SCOPE,
      path: 'ensure-target',
      intent: 'implicit',
      deps: deps({
        ledger: {
          activeAuthority: () => undefined,
          installActive: (row) => ({ ...row, state: 'active' }),
        },
        registry: {
          consult: async () => ({
            outcome: 'retired',
            retirement: { ...RETIRED, birthClass: 'mechanism-born' },
          }),
          establish: async () => ({
            outcome: 'retired',
            retirement: { ...RETIRED, birthClass: 'mechanism-born' },
          }),
        },
        retirementFor: () => undefined,
      }),
    })
    expect(result).toMatchObject({
      enforced: true,
      evaluation: { decision: 'refuse', reason: 'scope-retired' },
    })
    if (result.evaluation.decision !== 'refuse') throw new Error('unreachable')
    expect(result.evaluation.diagnostic).toContain('claim-succession')
  })
})

describe('T-06681 retired-home accept fence', () => {
  function envelope() {
    return {
      protocolVersion: '1.0',
      messageId: 'msg-81818181-8181-4181-8181-818181818181',
      kind: 'dm' as const,
      phase: 'request' as const,
      from: { kind: 'session' as const, sessionRef: 'agent:mable:project:hrc-runtime:task:origin' },
      to: { kind: 'session' as const, sessionRef: `${SCOPE}/lane:main` },
      body: 'stale cached delivery',
      rootMessageId: 'msg-81818181-8181-4181-8181-818181818181',
      expected: { homeNodeId: 'svc', placementEpoch: 1 },
    }
  }

  test('stale cached traffic is redirected to the successor epoch before insertion', async () => {
    const db = openHrcDatabase(':memory:')
    try {
      createPlacementLedgerRepository(db.sqlite).installActive(binding())
      createScopeRetirementRepository(db.sqlite).retire({
        scopeRef: SCOPE,
        retiredNodeId: 'svc',
        retiredPlacementEpoch: 1,
        successorNodeId: 'lab',
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })
      const accept = createFederationAcceptHandler({ db, localNodeId: 'svc' })
      expect(
        await accept({
          authenticatedNodeId: 'lab',
          protocolVersion: '1.0',
          envelope: envelope(),
        })
      ).toEqual({
        outcome: 'refused',
        code: 'stale_placement',
        retryable: true,
        status: 409,
        redirect: { homeNodeId: 'lab', placementEpoch: 2 },
      })
      expect(db.messages.getById(envelope().messageId)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('terminal fences refuse without a redirect', async () => {
    const db = openHrcDatabase(':memory:')
    try {
      createScopeRetirementRepository(db.sqlite).retire({
        scopeRef: SCOPE,
        retiredNodeId: 'svc',
        retiredPlacementEpoch: 1,
        successorNodeId: null,
        reason: 'namespace_reconciliation',
        retiredAt: '2026-07-20T00:01:00.000Z',
      })
      const accept = createFederationAcceptHandler({ db, localNodeId: 'svc' })
      expect(
        await accept({
          authenticatedNodeId: 'lab',
          protocolVersion: '1.0',
          envelope: envelope(),
        })
      ).toEqual({
        outcome: 'refused',
        code: 'scope_retired_terminal',
        retryable: false,
        status: 409,
      })
    } finally {
      db.close()
    }
  })
})
