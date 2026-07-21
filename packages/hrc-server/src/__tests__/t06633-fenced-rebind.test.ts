import { describe, expect, test } from 'bun:test'

import type { LocatePeerResolution, ScopeLocation } from 'hrc-core'
import {
  createPlacementLedgerRepository,
  openBindingRegistry,
  openHrcDatabase,
} from 'hrc-store-sqlite'
import type {
  BindingRegistry,
  PlacementLedgerRecord,
  PlacementLedgerRepository,
} from 'hrc-store-sqlite'

import { withScopeAuthorityLock, withScopeSummonLock } from '../federation/authority-lock.js'
import type { PeerEntry } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { PeerToken } from '../federation/peer-token.js'
import {
  activateFederationRebind,
  casFederationRebind,
  normalizeFederationRebindRequest,
  revokeFederationRebind,
} from '../federation/rebind.js'
import type { FederationRebindDependencies } from '../federation/rebind.js'
import type { BindingRegistryClient } from '../federation/registry-client.js'
import { RegistryUnreachableError } from '../federation/registry-client.js'
import { evaluateSummonGate } from '../federation/summon-gate.js'
import type { SummonGateDeps, SummonPath } from '../federation/summon-gate.js'

const SCOPE = 'agent:cody:project:hrc-runtime:task:T-06633'
const REQUEST = {
  scopeRef: SCOPE,
  expectedHomeNodeId: 'svc',
  expectedPlacementEpoch: 1,
  newHomeNodeId: 'lab',
} as const
const NOW = '2026-07-21T08:00:00.000Z'
const ALL_SUMMON_PATHS: readonly SummonPath[] = [
  'ensure-target',
  'archived-successor',
  'resolve-session',
  'command-run',
  'app-session',
]

function registryClient(registry: BindingRegistry): BindingRegistryClient {
  return {
    async consult(scopeRef) {
      const binding = registry.get(scopeRef)
      return binding === undefined ? { outcome: 'unbound' } : { outcome: 'bound', binding }
    },
    async establish(request) {
      return registry.establish(request)
    },
    async compareAndSwap(request) {
      return registry.compareAndSwap(request)
    },
  }
}

function peer(nodeId: string): PeerEntry {
  return {
    nodeId: parseNodeId(nodeId, 'test peer'),
    endpoint: 'http://svc.example.ts.net:18490/',
    token: new PeerToken('t06633-test-token'),
  }
}

function locationFor(nodeId: string, record: PlacementLedgerRecord | undefined): ScopeLocation {
  const ledger =
    record === undefined
      ? ({ state: 'absent' } as const)
      : {
          state: record.state,
          record: {
            homeNodeId: record.homeNodeId,
            placementEpoch: record.placementEpoch,
            birthClass: record.birthClass,
            authorityProvenance: record.authorityProvenance,
            establishmentProvenance: record.establishmentProvenance,
            ...(record.priorHomeNodeId === undefined
              ? {}
              : { priorHomeNodeId: record.priorHomeNodeId }),
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
          },
        }
  return {
    scopeRef: SCOPE,
    localNodeId: nodeId,
    federationConfigured: true,
    gateMode: 'enforce',
    declared: { source: 'none', detail: 'test' },
    ledger,
    registry: { outcome: 'not-consulted', detail: 'ledger observation only' },
    authority:
      record?.state === 'active'
        ? { state: 'bound', source: 'ledger', record: ledger.record, isLocal: true }
        : { state: 'unbound' },
    observed: { scope: 'local-node-only', nodeId, runtimeCount: 0, runtimes: [] },
    notes: [],
    birthChain: { state: 'not-applicable', detail: 'test' },
  }
}

function observeOld(ledger: PlacementLedgerRepository): Promise<LocatePeerResolution> {
  return Promise.resolve({
    nodeId: 'svc',
    state: 'answered',
    checkedAt: NOW,
    answeredAt: NOW,
    latencyMs: 0,
    location: locationFor('svc', ledger.get(SCOPE)),
  })
}

function gateDeps(
  localNodeId: string,
  ledger: PlacementLedgerRepository,
  registry: BindingRegistryClient
): SummonGateDeps {
  return {
    mode: 'enforce',
    federationConfigured: true,
    localNodeId,
    ledger,
    registry,
    policyFor: async () => ({
      placement: { pins: { 'hrc-runtime:T-06633': 'lab' } },
      claimsTask: false,
    }),
    capabilityFor: async () => ({ outcome: 'capable' }),
  }
}

describe('T-06633 fenced manual rebind', () => {
  test('rejects an old epoch that cannot be safely incremented to E+1', () => {
    expect(() =>
      normalizeFederationRebindRequest({
        ...REQUEST,
        expectedPlacementEpoch: Number.MAX_SAFE_INTEGER,
      })
    ).toThrow('room for E+1')
  })

  test('every fault boundary is nowhere-or-one, retryable, idempotent, and converges at E+1', async () => {
    const oldDb = openHrcDatabase(':memory:')
    const newDb = openHrcDatabase(':memory:')
    const registry = openBindingRegistry(':memory:')
    try {
      const oldLedger = createPlacementLedgerRepository(oldDb.sqlite)
      const newLedger = createPlacementLedgerRepository(newDb.sqlite)
      const established = registry.establish({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        now: NOW,
      }).binding
      oldLedger.installActive(established)
      const client = registryClient(registry)
      let oldLive: string[] = ['runtime-old']
      let newLive: string[] = []
      const common = {
        peerForNodeId: (nodeId: string) => (nodeId === 'svc' ? peer(nodeId) : undefined),
        observePeerScope: () => observeOld(oldLedger),
        log: () => {},
        now: () => NOW,
      }
      const oldDeps: FederationRebindDependencies = {
        ...common,
        owner: {},
        localNodeId: 'svc',
        ledger: oldLedger,
        registry: client,
        liveRuntimeIds: () => oldLive,
      }
      const newDeps: FederationRebindDependencies = {
        ...common,
        owner: {},
        localNodeId: 'lab',
        ledger: newLedger,
        registry: client,
        liveRuntimeIds: () => newLive,
      }

      await expect(revokeFederationRebind(oldDeps, REQUEST)).resolves.toMatchObject({
        ok: false,
        outcome: 'live-runtime-present',
        state: 'old-home-live',
      })
      expect(oldLedger.activeAuthority(SCOPE)?.homeNodeId).toBe('svc')

      await expect(casFederationRebind(newDeps, REQUEST)).resolves.toMatchObject({
        ok: false,
        outcome: 'conflict',
        state: 'unchanged',
      })
      expect(registry.get(SCOPE)).toMatchObject({ homeNodeId: 'svc', placementEpoch: 1 })

      oldLive = []
      await expect(revokeFederationRebind(oldDeps, REQUEST)).resolves.toMatchObject({
        ok: true,
        outcome: 'revoked',
        state: 'revoked-nowhere',
      })
      await expect(revokeFederationRebind(oldDeps, REQUEST)).resolves.toMatchObject({
        ok: true,
        outcome: 'idempotent',
      })
      expect(oldLedger.activeAuthority(SCOPE)).toBeUndefined()

      for (const path of ALL_SUMMON_PATHS) {
        await expect(
          evaluateSummonGate({
            scopeRef: SCOPE,
            path,
            intent: 'implicit',
            knownSession: path === 'archived-successor',
            deps: gateDeps('svc', oldLedger, client),
          })
        ).resolves.toMatchObject({
          enforced: true,
          evaluation: { decision: 'refuse', reason: 'rebind-revoked', retryable: true },
        })
      }

      const registryDown: BindingRegistryClient = {
        ...client,
        async compareAndSwap() {
          throw new RegistryUnreachableError('fault injected between REVOKE and CAS')
        },
      }
      await expect(
        casFederationRebind({ ...newDeps, registry: registryDown }, REQUEST)
      ).resolves.toMatchObject({
        ok: false,
        outcome: 'refused',
        state: 'revoked-nowhere',
        retryable: true,
      })
      expect(oldLedger.activeAuthority(SCOPE)).toBeUndefined()
      expect(newLedger.activeAuthority(SCOPE)).toBeUndefined()

      await expect(casFederationRebind(newDeps, REQUEST)).resolves.toMatchObject({
        ok: true,
        outcome: 'registry-updated',
        state: 'registry-moved-activation-pending',
      })
      await expect(casFederationRebind(newDeps, REQUEST)).resolves.toMatchObject({
        ok: true,
        outcome: 'idempotent',
      })
      expect(registry.get(SCOPE)).toMatchObject({
        homeNodeId: 'lab',
        placementEpoch: 2,
        establishmentProvenance: 'rebind',
        priorHomeNodeId: 'svc',
      })
      await expect(
        evaluateSummonGate({
          scopeRef: SCOPE,
          path: 'archived-successor',
          intent: 'implicit',
          knownSession: true,
          deps: gateDeps('lab', newLedger, client),
        })
      ).resolves.toMatchObject({
        enforced: true,
        evaluation: {
          decision: 'refuse',
          reason: 'rebind-activation-pending',
          retryable: true,
        },
      })

      newLive = ['unexpected-new-runtime']
      await expect(activateFederationRebind(newDeps, REQUEST)).resolves.toMatchObject({
        ok: false,
        outcome: 'live-runtime-present',
        state: 'registry-moved-activation-pending',
      })
      expect(newLedger.activeAuthority(SCOPE)).toBeUndefined()

      newLive = []
      await expect(activateFederationRebind(newDeps, REQUEST)).resolves.toMatchObject({
        ok: true,
        outcome: 'activated',
        state: 'active-new-home',
      })
      await expect(activateFederationRebind(newDeps, REQUEST)).resolves.toMatchObject({
        ok: true,
        outcome: 'idempotent',
      })
      expect(oldLedger.activeAuthority(SCOPE)).toBeUndefined()
      expect(newLedger.activeAuthority(SCOPE)).toMatchObject({
        homeNodeId: 'lab',
        placementEpoch: 2,
        establishmentProvenance: 'rebind',
        priorHomeNodeId: 'svc',
      })
    } finally {
      registry.close()
      oldDb.close()
      newDb.close()
    }
  })

  test('the shared scope lock serializes summon mint against revoke in both orderings', async () => {
    const db = openHrcDatabase(':memory:')
    try {
      const ledger = createPlacementLedgerRepository(db.sqlite)
      ledger.installActive({
        scopeRef: SCOPE,
        homeNodeId: 'svc',
        placementEpoch: 1,
        birthClass: 'policy-born',
        authorityProvenance: { kind: 'policy', source: 'pin' },
        establishmentProvenance: 'pin',
        updatedAt: NOW,
      })
      const owner = {}
      let live: string[] = []
      let releaseMint!: () => void
      const mintHeld = new Promise<void>((resolve) => {
        releaseMint = resolve
      })
      const summonFirst = withScopeSummonLock(owner, SCOPE, async () => {
        expect(ledger.activeAuthority(SCOPE)?.homeNodeId).toBe('svc')
        await mintHeld
        live = ['minted-runtime']
      })
      await Bun.sleep(0)
      const revokeQueued = revokeFederationRebind(
        {
          owner,
          localNodeId: 'svc',
          ledger,
          registry: {} as BindingRegistryClient,
          peerForNodeId: () => undefined,
          liveRuntimeIds: () => live,
          log: () => {},
        },
        REQUEST
      )
      releaseMint()
      await summonFirst
      await expect(revokeQueued).resolves.toMatchObject({
        ok: false,
        outcome: 'live-runtime-present',
      })
      expect(ledger.activeAuthority(SCOPE)?.homeNodeId).toBe('svc')

      live = []
      const revokeFirst = revokeFederationRebind(
        {
          owner,
          localNodeId: 'svc',
          ledger,
          registry: {} as BindingRegistryClient,
          peerForNodeId: () => undefined,
          liveRuntimeIds: () => live,
          log: () => {},
        },
        REQUEST
      )
      const summonQueued = withScopeSummonLock(owner, SCOPE, async () =>
        ledger.activeAuthority(SCOPE)
      )
      await expect(revokeFirst).resolves.toMatchObject({ ok: true, outcome: 'revoked' })
      await expect(summonQueued).resolves.toBeUndefined()
    } finally {
      db.close()
    }
  })

  test('summons remain concurrent while a queued rebind excludes later summons', async () => {
    const owner = {}
    const sequence: string[] = []
    let releaseSummons!: () => void
    const summonsHeld = new Promise<void>((resolve) => {
      releaseSummons = resolve
    })
    const summon = (label: string) =>
      withScopeSummonLock(owner, SCOPE, async () => {
        sequence.push(`${label}:start`)
        await summonsHeld
        sequence.push(`${label}:end`)
      })

    const first = summon('summon-1')
    const second = summon('summon-2')
    await Bun.sleep(0)
    expect(sequence).toEqual(['summon-1:start', 'summon-2:start'])

    const rebind = withScopeAuthorityLock(owner, SCOPE, () => {
      sequence.push('rebind')
    })
    const third = withScopeSummonLock(owner, SCOPE, () => {
      sequence.push('summon-3')
    })
    releaseSummons()
    await Promise.all([first, second, rebind, third])
    expect(sequence.slice(2)).toEqual(['summon-1:end', 'summon-2:end', 'rebind', 'summon-3'])
  })
})
