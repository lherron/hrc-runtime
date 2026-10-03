/**
 * T-09762 — a scope this node has RETIRED must never be driven or seated here.
 *
 * Live incident: svc's placement ledger retired `clod@hrc-runtime:primary`
 * (home max3) on 2026-07-23 but kept its sessions active. The out-of-process
 * mail kicker asked `locateScope`, which read the retired row as `unbound`
 * without consulting the registry, so svc treated the scope as its own. It
 * cold-birthed a `:primary` seat for every piece of mail and the shadow
 * teardown killed each one within a minute: 28 runtimes, 17 envelopes sent
 * from svc as `:primary`. The teardown asked `resolveForeignHome`, a second
 * resolver that DID consult the registry, so the two mechanisms disagreed.
 *
 * Failure modes, written before the fix:
 * A1. A retired local row plus a registry home elsewhere reads as unbound/local
 *     to `locateScope` while `resolveForeignHome` names the foreign home.
 * A2. The two call sites diverge on ANY ledger state because they are two
 *     functions: they must be one resolution, pinned by comparing both call
 *     sites against the same row for every state.
 * A3. An ACTIVE ledger row naming another node reports `isLocal: true` from
 *     locate, which the kicker reads as "drive it here".
 * A4. A retired row whose registry still names THIS node (stale discovery) is
 *     reported local: the fence must win and it must read as unbound.
 * A5. An unreachable registry is collapsed into unbound instead of unknown.
 * B1. `POST /v1/targets/ensure` returns an existing active session of a
 *     retired scope without any gate.
 * B2. All four submission doors (invoke, enqueue, steer, preempt) accept a
 *     turn for a retired scope's existing session.
 * B3. Stale-generation auto-rotation mints a successor generation for a
 *     retired scope.
 * B5. An operator `hrc session rotate` (POST /v1/clear-context and its
 *     /v1/sessions/clear-context alias) calls rotateSessionContext directly and
 *     mints generation+1 of a retired scope, bypassing the auto-rotate fence.
 * B4. The refusal is untyped or swallowed: it must be the gate's typed
 *     `stale_context` conflict with `reason: scope-retired`, returned to the
 *     caller, and nothing (no session, no runtime) may be minted.
 */

import { writeFile } from 'node:fs/promises'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import type { LocateAuthority } from 'hrc-core'
import { createPlacementLedgerRepository, openHrcDatabase } from 'hrc-store-sqlite'
import type { PlacementLedgerRecord } from 'hrc-store-sqlite'

import { FEDERATION_CONFIG_BASENAME } from '../federation/federation-config.js'
import type { FederationConfig } from '../federation/federation-config.js'
import {
  type ForeignHome,
  type HomeAuthorityDeps,
  homeAuthorityDeps,
  resolveForeignHome,
  resolveHomeAuthority,
} from '../federation/home-authority.js'
import { locateScopeOnServer } from '../federation/locate-server.js'
import { type LocateDeps, locateScope } from '../federation/locate.js'
import {
  type BindingRegistryClient,
  type RegistryConsultResult,
  RegistryUnreachableError,
} from '../federation/registry-client.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const LOCAL = 'svc'
const HOME = 'max3'
const SCOPE = 'agent:clod:project:hrc-runtime:task:primary'
const T0 = '2026-07-20T00:00:00.000Z'
const RETIRED_AT = '2026-07-23T16:19:15.047Z'

function registry(consult: () => Promise<RegistryConsultResult>): BindingRegistryClient {
  return {
    consult: async () => await consult(),
    async establish() {
      throw new Error('not used')
    },
    async deleteBinding() {
      throw new Error('not used')
    },
  }
}

const boundTo = (homeNodeId: string) => async (): Promise<RegistryConsultResult> => ({
  outcome: 'bound',
  binding: { scopeRef: SCOPE, homeNodeId, createdAt: T0, updatedAt: T0 },
})

function row(state: 'active' | 'retired', homeNodeId: string): PlacementLedgerRecord {
  return {
    scopeRef: SCOPE,
    homeNodeId,
    state,
    createdAt: T0,
    updatedAt: state === 'retired' ? RETIRED_AT : T0,
    ...(state === 'retired'
      ? { retiredAt: RETIRED_AT, retirementReason: 'migrated-v1.2-local-fence' }
      : {}),
  }
}

type Case = {
  label: string
  local: PlacementLedgerRecord | undefined
  consult: () => Promise<RegistryConsultResult>
  authority: LocateAuthority
  foreign: ForeignHome | undefined
}

const CASES: Case[] = [
  {
    label: 'A1 retired locally, registry home elsewhere → foreign',
    local: row('retired', LOCAL),
    consult: boundTo(HOME),
    authority: {
      state: 'bound',
      source: 'registry',
      record: { homeNodeId: HOME, createdAt: T0, updatedAt: T0 },
      isLocal: false,
    },
    foreign: { homeNodeId: HOME, source: 'registry' },
  },
  {
    label: 'A4 retired locally, registry still names this node → unbound (fence wins)',
    local: row('retired', LOCAL),
    consult: boundTo(LOCAL),
    authority: { state: 'unbound' },
    foreign: undefined,
  },
  {
    label: 'retired locally, registry unbound → unbound',
    local: row('retired', LOCAL),
    consult: async () => ({ outcome: 'unbound' }),
    authority: { state: 'unbound' },
    foreign: undefined,
  },
  {
    label: 'A5 retired locally, registry unreachable → unknown, never a foreign guess',
    local: row('retired', LOCAL),
    consult: async () => {
      throw new RegistryUnreachableError('registry down')
    },
    authority: { state: 'unknown', detail: 'registry down', retryable: true },
    foreign: undefined,
  },
  {
    label: 'A3 active ledger row naming another node → foreign, not local',
    local: row('active', HOME),
    consult: boundTo(LOCAL),
    authority: {
      state: 'bound',
      source: 'ledger',
      record: { homeNodeId: HOME, createdAt: T0, updatedAt: T0 },
      isLocal: false,
    },
    foreign: { homeNodeId: HOME, source: 'placement-ledger' },
  },
  {
    label: 'active ledger row naming this node → local',
    local: row('active', LOCAL),
    consult: boundTo(HOME),
    authority: {
      state: 'bound',
      source: 'ledger',
      record: { homeNodeId: LOCAL, createdAt: T0, updatedAt: T0 },
      isLocal: true,
    },
    foreign: undefined,
  },
  {
    label: 'no local row, registry home elsewhere → foreign',
    local: undefined,
    consult: boundTo(HOME),
    authority: {
      state: 'bound',
      source: 'registry',
      record: { homeNodeId: HOME, createdAt: T0, updatedAt: T0 },
      isLocal: false,
    },
    foreign: { homeNodeId: HOME, source: 'registry' },
  },
]

describe('T-09762 A: locate and the foreign-home check are ONE resolution', () => {
  test.each(CASES)('$label', async (scenario) => {
    const client = registry(scenario.consult)
    const ledger = { get: () => scenario.local, activeAuthority: () => undefined }
    const shared: HomeAuthorityDeps = {
      localNodeId: LOCAL,
      registry: client,
      ledger,
      memo: new Map(),
    }
    const locateDeps: LocateDeps = {
      localNodeId: LOCAL,
      federationConfigured: true,
      gateMode: 'enforce',
      ledger,
      registry: client,
      policyFor: async () => ({ outcome: 'no-profile', detail: 't09762' }),
      observedFor: () => [],
    }

    const resolution = await resolveHomeAuthority(shared, SCOPE)
    const located = await locateScope({ scopeRef: SCOPE, deps: locateDeps })
    const foreign = await resolveForeignHome(shared, SCOPE)

    expect(resolution.authority).toEqual(scenario.authority)
    // Both call sites answer from the one resolution, field for field.
    expect(located.authority).toEqual(resolution.authority)
    expect(foreign).toEqual(scenario.foreign)
  })

  test('both server call sites read the same REAL retired ledger row and agree', async () => {
    const db = openHrcDatabase(':memory:')
    try {
      const ledger = createPlacementLedgerRepository(db.sqlite)
      ledger.installActive({ scopeRef: SCOPE, homeNodeId: LOCAL, updatedAt: T0 })
      ledger.retire({
        scopeRef: SCOPE,
        expectedHomeNodeId: LOCAL,
        reason: 'migrated-v1.2-local-fence',
        retiredAt: RETIRED_AT,
      })
      const client = registry(boundTo(HOME))

      // The kicker's call site: GET /v1/federation/locate → locateScopeOnServer.
      const located = await locateScopeOnServer(
        {
          db,
          federationConfig: {
            sourceExists: true,
            nodeId: LOCAL,
            gate: { mode: 'enforce' },
          } as unknown as FederationConfig,
          registryClient: client,
          policyFor: async () => ({ outcome: 'no-profile', detail: 't09762' }),
          observedFor: () => [],
        },
        SCOPE
      )
      // The teardown's call site.
      const foreign = await resolveForeignHome(
        homeAuthorityDeps({
          db,
          federationNodeId: LOCAL,
          federationRegistryClient: client,
          foreignHomeMemo: new Map(),
        }),
        SCOPE
      )

      expect(located.ledger.state).toBe('retired')
      expect(located.authority).toMatchObject({
        state: 'bound',
        record: { homeNodeId: HOME },
        isLocal: false,
      })
      expect(foreign).toEqual({ homeNodeId: HOME, source: 'registry' })
      // Retirement is still reported: the fence is not forgotten, only no
      // longer mistaken for "this node homes it".
      expect(located.notes).toContainEqual(expect.objectContaining({ code: 'scope-retired' }))
    } finally {
      db.close()
    }
  })
})

describe('T-09762 B: every door refuses a retired scope with a typed conflict', () => {
  const SESSION_REF = `${SCOPE}/lane:main`
  const HOST_SESSION_ID = 'hsid-t09762-retired-primary'
  const runtimeIntent = {
    placement: {
      agentRoot: '/tmp/agent',
      projectRoot: '/tmp/project',
      cwd: '/tmp/project',
      runMode: 'task',
      bundle: { kind: 'compose', compose: [] },
      dryRun: true,
    },
    harness: { provider: 'openai', id: 'codex', interactive: false },
    execution: { preferredMode: 'headless', allowInteractiveSurfaceReuse: false },
  }

  let fixture: HrcServerTestFixture
  let server: HrcServer
  let dispatched: number

  function seedRetiredScopeWithActiveSession(createdAt: string): void {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.sessions.insert({
        hostSessionId: HOST_SESSION_ID,
        scopeRef: SCOPE,
        laneRef: 'main',
        generation: 5,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
      })
      db.continuities.upsert({
        scopeRef: SCOPE,
        laneRef: 'main',
        activeHostSessionId: HOST_SESSION_ID,
        updatedAt: createdAt,
      })
      const ledger = createPlacementLedgerRepository(db.sqlite)
      ledger.installActive({ scopeRef: SCOPE, homeNodeId: LOCAL, updatedAt: T0 })
      ledger.retire({
        scopeRef: SCOPE,
        expectedHomeNodeId: LOCAL,
        reason: 'migrated-v1.2-local-fence',
        retiredAt: RETIRED_AT,
      })
    } finally {
      db.close()
    }
  }

  function mintedNothing(): void {
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const sessions = db.sqlite
        .query<{ n: number }, [string]>('SELECT count(*) AS n FROM sessions WHERE scope_ref = ?')
        .get(SCOPE)
      const runtimes = db.sqlite
        .query<{ n: number }, [string]>('SELECT count(*) AS n FROM runtimes WHERE scope_ref = ?')
        .get(SCOPE)
      expect(sessions?.n).toBe(1)
      expect(runtimes?.n).toBe(0)
      expect(db.sessions.getByHostSessionId(HOST_SESSION_ID)?.status).toBe('active')
    } finally {
      db.close()
    }
    expect(dispatched).toBe(0)
  }

  async function expectScopeRetiredRefusal(response: Response): Promise<void> {
    expect(response.status).toBe(409)
    const body = (await response.json()) as {
      error?: { code?: string; detail?: Record<string, unknown> }
    }
    expect(body.error?.code).toBe('stale_context')
    expect(body.error?.detail).toMatchObject({ scopeRef: SCOPE, reason: 'scope-retired' })
  }

  async function start(createdAt: string): Promise<void> {
    await writeFile(
      `${fixture.stateRoot}/${FEDERATION_CONFIG_BASENAME}`,
      JSON.stringify({ nodeId: LOCAL, gate: { mode: 'enforce' } }),
      { mode: 0o600 }
    )
    seedRetiredScopeWithActiveSession(createdAt)
    server = await createHrcServer(fixture.serverOpts())
    const internal = server as unknown as HrcServerInstanceForHandlers
    dispatched = 0
    internal.dispatchTurnForSession = (async () => {
      dispatched += 1
      throw new Error('a retired scope must never reach dispatch')
    }) as typeof internal.dispatchTurnForSession
  }

  beforeEach(async () => {
    fixture = await createHrcTestFixture('hrc-t09762-')
  })

  afterEach(async () => {
    if (server) await server.stop()
    await fixture.cleanup()
  })

  test('B1 POST /v1/targets/ensure refuses the existing active session', async () => {
    await start(new Date().toISOString())
    await expectScopeRetiredRefusal(
      await fixture.postJson('/v1/targets/ensure', { sessionRef: SESSION_REF, runtimeIntent })
    )
    mintedNothing()
  })

  test.each(['invoke', 'enqueue', 'steer', 'preempt'] as const)(
    'B2 POST /v1/submissions/%s refuses the retired scope',
    async (door) => {
      await start(new Date().toISOString())
      await expectScopeRetiredRefusal(
        await fixture.postJson(`/v1/submissions/${door}`, {
          target: SESSION_REF,
          body: 'mail for a retired scope',
          origin: { principalRef: 'agent:lance', envelopeId: 'EN-t09762' },
          ...(door === 'steer' ? {} : { runtimeIntent }),
          wait: false,
        })
      )
      mintedNothing()
    }
  )

  test('B3 a stale generation is refused, never auto-rotated to a successor', async () => {
    // Three days old: past the 24h stale-generation threshold, as mini's gen 4
    // was when submission-invoke rotated it to gen 5.
    await start(new Date(Date.now() - 3 * 86_400_000).toISOString())
    const internal = server as unknown as HrcServerInstanceForHandlers
    const db = openHrcDatabase(fixture.dbPath)
    try {
      const session = db.sessions.getByHostSessionId(HOST_SESSION_ID)
      expect(session).not.toBeNull()
      await expect(
        internal.maybeAutoRotateStaleSession(session!, { trigger: 'submission-invoke' })
      ).rejects.toMatchObject({ code: 'stale_context', detail: { reason: 'scope-retired' } })
    } finally {
      db.close()
    }
    mintedNothing()
  })

  test.each(['/v1/clear-context', '/v1/sessions/clear-context'])(
    'B5 an operator rotate via %s is refused, never minting generation+1',
    async (route) => {
      await start(new Date().toISOString())
      await expectScopeRetiredRefusal(
        await fixture.postJson(route, { hostSessionId: HOST_SESSION_ID, relaunch: false })
      )
      mintedNothing()
    }
  )
})
