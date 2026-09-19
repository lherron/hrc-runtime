import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type {
  ListLiveSeatRefsResponse,
  ListPlacementBindingsResponse,
  ListUnbornDesignationsResponse,
  ScopeLocation,
} from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'

import { homeAuthorityDeps, resolveForeignHome } from '../federation/home-authority.js'
import { locateScope } from '../federation/locate.js'
import type { BindingRegistryClient, RegistryConsultResult } from '../federation/registry-client.js'
import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/**
 * T-08609 contract: `GET /v1/runtimes/live-refs`,
 * `GET /v1/placement/bindings?home=self&state=active`,
 * `GET /v1/federation/designations?unborn=true`, plus the V2 conformance proof
 * that `GET /v1/federation/locate` answers what `resolveForeignHome` and
 * `registry.consult` answer for the cold-start and birth-retry cases.
 *
 * Run with: TMPDIR=/tmp bun run --filter hrc-server test t08609-placement-federation
 */

const HOST = 'hsid-t08609-01'
const LIVE_A = 'agent:t08609:project:hrc-runtime:task:live-a'
const LIVE_B = 'agent:t08609:project:hrc-runtime:task:live-b'
const DEAD = 'agent:t08609:project:hrc-runtime:task:dead'
const LEDGER_LOCAL = 'agent:t08609:project:hrc-runtime:task:ledger-local'
const LEDGER_FOREIGN = 'agent:t08609:project:hrc-runtime:task:ledger-foreign'
const LEDGER_RETIRED = 'agent:t08609:project:hrc-runtime:task:ledger-retired'
const NO_ROW = 'agent:t08609:project:hrc-runtime:task:no-row'
const FOREIGN_NODE = 'lab'

let fixture: HrcServerTestFixture
let server: HrcServer
let localNodeId: string

function consultStub(result: RegistryConsultResult): BindingRegistryClient {
  return {
    async consult(): Promise<RegistryConsultResult> {
      return result
    },
    async establish() {
      throw new Error('not used')
    },
    async deleteBinding() {
      throw new Error('not used')
    },
  }
}

function seedRuntime(runtimeId: string, scopeRef: string, status: string): void {
  fixture.seedSession(`${HOST}-${runtimeId}`, scopeRef)
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    db.runtimes.insert({
      runtimeId,
      hostSessionId: `${HOST}-${runtimeId}`,
      scopeRef,
      laneRef: 'default',
      generation: 1,
      transport: 'headless',
      harness: 'agent-sdk',
      provider: 'anthropic',
      status,
      supportsInflightInput: false,
      adopted: false,
      createdAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
}

function seedPlacement(): void {
  const db = openHrcDatabase(fixture.dbPath)
  const now = fixture.now()
  try {
    const ledger = createPlacementLedgerRepository(db.sqlite)
    ledger.installActive({ scopeRef: LEDGER_LOCAL, homeNodeId: localNodeId, updatedAt: now })
    ledger.installActive({ scopeRef: LEDGER_FOREIGN, homeNodeId: FOREIGN_NODE, updatedAt: now })
    ledger.installActive({ scopeRef: LEDGER_RETIRED, homeNodeId: localNodeId, updatedAt: now })
    ledger.retire({
      scopeRef: LEDGER_RETIRED,
      expectedHomeNodeId: localNodeId,
      reason: 't08609 test retirement',
      retiredAt: now,
    })
  } finally {
    db.close()
  }
}

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-t08609-')
  server = await createHrcServer(fixture.serverOpts())
  localNodeId = (server as any).federationNodeId as string
  ;(server as any).federationRegistryClient = consultStub({ outcome: 'unbound' })
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

describe('GET /v1/runtimes/live-refs', () => {
  it('returns one narrow row per live seat and nothing terminal', async () => {
    seedRuntime('rt-t08609-live-a', LIVE_A, 'ready')
    seedRuntime('rt-t08609-live-b', LIVE_B, 'busy')
    seedRuntime('rt-t08609-dead', DEAD, 'terminated')
    const res = await fixture.fetchSocket('/v1/runtimes/live-refs')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListLiveSeatRefsResponse
    expect(body.refs).toHaveLength(2)
    expect(body.refs[0]).toMatchObject({ scopeRef: LIVE_A, laneRef: 'default' })
    expect(body.refs[0]?.runtimeId).toBe('rt-t08609-live-a')
    expect(body.refs[0]?.hostSessionId).toBe(`${HOST}-rt-t08609-live-a`)
    for (const ref of body.refs) {
      expect(Object.keys(ref).sort()).toEqual(['hostSessionId', 'laneRef', 'runtimeId', 'scopeRef'])
    }
    // Same membership as the ledger-avoiding repo read this route fronts.
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const expected = new Set(db.runtimes.listLiveSessionRefs())
      expect(new Set(body.refs.map((ref) => `${ref.scopeRef}/lane:${ref.laneRef}`))).toEqual(
        expected
      )
    } finally {
      db.close()
    }
  })
})

describe('GET /v1/placement/bindings', () => {
  it('returns only locally homed active rows, never the skew-audit shape', async () => {
    seedPlacement()
    const res = await fixture.fetchSocket('/v1/placement/bindings?home=self&state=active')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListPlacementBindingsResponse
    expect(body.localNodeId).toBe(localNodeId)
    expect(body.bindings).toHaveLength(1)
    expect(body.bindings[0]).toMatchObject({
      scopeRef: LEDGER_LOCAL,
      homeNodeId: localNodeId,
      state: 'active',
    })
    expect(Object.keys(body.bindings[0] ?? {}).sort()).toEqual(['homeNodeId', 'scopeRef', 'state'])
  })

  it('400s anything but home=self&state=active', async () => {
    for (const query of ['', '?home=self', '?state=active', '?home=lab&state=active']) {
      const res = await fixture.fetchSocket(`/v1/placement/bindings${query}`)
      expect(res.status).toBe(400)
    }
  })
})

describe('GET /v1/federation/designations', () => {
  it('passes unborn designations through and maps to the node id', async () => {
    ;(server as any).federationRegistryClient = {
      ...consultStub({ outcome: 'unbound' }),
      async listUnbornDesignations(homeNodeId: string) {
        expect(homeNodeId).toBe(localNodeId)
        return [
          {
            scopeRef: 'agent:t08609:project:hrc-runtime:task:unborn-a',
            homeNodeId,
            provenance: 'test',
            birthEnvelopeId: 'en-1',
            senderScopeRef: 'agent:t08609:project:hrc-runtime:task:sender',
            designationEpoch: 1,
            designatedAt: fixture.now(),
            state: 'live',
          },
        ]
      },
    }
    const res = await fixture.fetchSocket('/v1/federation/designations?unborn=true')
    expect(res.status).toBe(200)
    const body = (await res.json()) as ListUnbornDesignationsResponse
    expect(body.localNodeId).toBe(localNodeId)
    expect(body.designations).toHaveLength(1)
    expect(body.designations[0]).toMatchObject({
      scopeRef: 'agent:t08609:project:hrc-runtime:task:unborn-a',
    })
  })

  it('returns empty with no registry and 400s without unborn=true', async () => {
    ;(server as any).federationRegistryClient = undefined
    const empty = await fixture.fetchSocket('/v1/federation/designations?unborn=true')
    expect(empty.status).toBe(200)
    expect(((await empty.json()) as ListUnbornDesignationsResponse).designations).toEqual([])
    const bad = await fixture.fetchSocket('/v1/federation/designations')
    expect(bad.status).toBe(400)
  })
})

describe('V2: locate conformance for the kicker cases', () => {
  async function locate(scopeRef: string): Promise<ScopeLocation> {
    const res = await fixture.fetchSocket(
      `/v1/federation/locate?scopeRef=${encodeURIComponent(scopeRef)}`
    )
    expect(res.status).toBe(200)
    return (await res.json()) as ScopeLocation
  }

  it('active local ledger: locate says bound-ledger-local, foreign home is undefined', async () => {
    seedPlacement()
    const location = await locate(LEDGER_LOCAL)
    expect(location.authority).toMatchObject({
      state: 'bound',
      source: 'ledger',
      record: { homeNodeId: localNodeId },
    })
    expect(location.ledger).toMatchObject({ state: 'active', record: { homeNodeId: localNodeId } })
    const foreign = await resolveForeignHome(homeAuthorityDeps(server as never), LEDGER_LOCAL)
    expect(foreign).toBeUndefined()
  })

  it('active foreign ledger: locate and resolveForeignHome name the same home', async () => {
    seedPlacement()
    const location = await locate(LEDGER_FOREIGN)
    expect(location.authority).toMatchObject({
      state: 'bound',
      source: 'ledger',
      record: { homeNodeId: FOREIGN_NODE },
    })
    const foreign = await resolveForeignHome(homeAuthorityDeps(server as never), LEDGER_FOREIGN)
    expect(foreign).toEqual({ homeNodeId: FOREIGN_NODE, source: 'placement-ledger' })
  })

  it('no ledger row: both report unbound/undefined', async () => {
    const location = await locate(NO_ROW)
    expect(location.authority).toMatchObject({ state: 'unbound' })
    const foreign = await resolveForeignHome(homeAuthorityDeps(server as never), NO_ROW)
    expect(foreign).toBeUndefined()
  })

  it('consult-bound foreign with no local row: locate and consult agree', async () => {
    const binding = {
      scopeRef: NO_ROW,
      homeNodeId: FOREIGN_NODE,
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    }
    const registry = consultStub({ outcome: 'bound', binding })
    const ledgerStub = { get: () => undefined, activeAuthority: () => undefined }
    const location = await locateScope({
      scopeRef: NO_ROW,
      deps: {
        localNodeId,
        federationConfigured: true,
        gateMode: 'advisory',
        ledger: ledgerStub,
        registry,
        policyFor: async () => ({ outcome: 'unreadable', detail: 't08609' }),
        observedFor: () => [],
      },
    })
    expect(location.authority).toMatchObject({
      state: 'bound',
      source: 'registry',
      record: { homeNodeId: FOREIGN_NODE },
      isLocal: false,
    })
    const foreign = await resolveForeignHome(
      { localNodeId, registry, ledger: ledgerStub, memo: new Map() },
      NO_ROW
    )
    expect(foreign).toEqual({ homeNodeId: FOREIGN_NODE, source: 'registry' })
  })

  it('consult-bound local with no local row: neither reports a foreign home', async () => {
    const binding = {
      scopeRef: NO_ROW,
      homeNodeId: localNodeId,
      createdAt: fixture.now(),
      updatedAt: fixture.now(),
    }
    const registry = consultStub({ outcome: 'bound', binding })
    const ledgerStub = { get: () => undefined, activeAuthority: () => undefined }
    const location = await locateScope({
      scopeRef: NO_ROW,
      deps: {
        localNodeId,
        federationConfigured: true,
        gateMode: 'advisory',
        ledger: ledgerStub,
        registry,
        policyFor: async () => ({ outcome: 'unreadable', detail: 't08609' }),
        observedFor: () => [],
      },
    })
    expect(location.authority).toMatchObject({
      state: 'bound',
      source: 'registry',
      isLocal: true,
    })
    const foreign = await resolveForeignHome(
      { localNodeId, registry, ledger: ledgerStub, memo: new Map() },
      NO_ROW
    )
    expect(foreign).toBeUndefined()
  })
})
