import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createPlacementLedgerRepository, openBindingRegistry } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { FederationConfig, PeerEntry } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { PeerToken } from '../federation/peer-token.js'
import { resolveBindingRegistryPath } from '../federation/registry-endpoint.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { timestamp } from '../server-util.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  captureServerLog,
  installDeterministicStart,
  installMailKickerAgentHome,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07650 — the kicker stops claiming drives for scopes another node homes.
 *
 * The observed shape, from lab and max3: after authority was retired on one
 * node and freshly established on another, the old node retained a live
 * runtime row for the scope AND every attempt it claimed for it. An attempt
 * that dies at the summon gate is only annotated, never finished. Both of the
 * sweep's candidate sources therefore kept naming the scope forever, and every
 * tick re-drove it into the same `bound-elsewhere` refusal — 14 typed
 * `wrkq.kicker.drive_failed` per tick on max3, 170 in one afternoon on lab,
 * plus one more permanently stuck attempt row each time.
 */

const TARGET = 'agent:kicker-proof:project:hrc-runtime:task:T-07650/lane:main'
const SCOPE = 'agent:kicker-proof:project:hrc-runtime:task:T-07650'
const SENDER = 'mable@hrc-runtime:T-07650'
const LOCAL_NODE = 'lab'
const HOME_NODE = 'max3'
const NOW = '2026-08-28T01:05:00.000Z'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-kicker-foreign-home-')
  ledger = new FakeWrkqLedger()
  restoreAgentHome = (await installMailKickerAgentHome(fixture.tmpDir, 'kicker-proof')).restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return ledger.say({ toScopeRef: SCOPE, fromScopeRef: SENDER, roomKey: 'T-07650', ...overrides })
}

/** A free loopback port, released immediately and handed to the daemon. */
function reserveLoopbackBind(): string {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
  const port = probe.port
  probe.stop(true)
  return `http://127.0.0.1:${port}`
}

/**
 * This node serves its own binding registry, so the consult the filter makes is
 * a real one against a real registry rather than a stub that agrees by
 * construction.
 */
function federationConfig(peered = true): FederationConfig {
  // A real peer entry, because the shadow teardown arms on the PEER SET rather
  // than on the registry client — a single-node daemon resolves one of those
  // too, an always-throwing stub, and arming on it would put a consult failure
  // in the log of every unfederated install.
  const peers = new Map<string, PeerEntry>()
  if (peered) {
    const peer = parseNodeId(HOME_NODE, 'test peer')
    peers.set(peer, {
      nodeId: peer,
      endpoint: 'http://max3.example.ts.net:18490/',
      token: new PeerToken('t07650-test-token'),
    })
  }
  return {
    nodeId: parseNodeId(LOCAL_NODE, 'test node'),
    nodeIdProvenance: 'declared',
    sourcePath: `${fixture.stateRoot}/federation.json`,
    sourceExists: true,
    peers,
    registry: { bind: reserveLoopbackBind() },
    gate: { mode: 'enforce', registryHost: parseNodeId(LOCAL_NODE, 'test registry host') },
    warnings: [],
  } as FederationConfig
}

/** Bind the scope in the collective registry, before the daemon opens it. */
function registerScopeHomedOn(homeNodeId: string): void {
  const registry = openBindingRegistry(resolveBindingRegistryPath(fixture.stateRoot))
  try {
    registry.establish({
      scopeRef: SCOPE,
      homeNodeId,
      now: NOW,
    })
  } finally {
    registry.close()
  }
}

/**
 * The stale seat a rebind leaves behind: a runtime this node is still seating.
 *
 * Seeded AFTER start on purpose. Startup reconciliation marks any headless
 * runtime with no live process `stale`, so a row written before the daemon
 * boots is not the shape this bug is made of — on max3 and lab the seats were
 * genuinely live when their authority moved out from under them.
 */
function seedSession(hostSessionId: string, generation = 1): void {
  serverDb().sessions.insert({
    hostSessionId,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
}

function seedRuntime(
  runtimeId: string,
  patch: { hostSessionId?: string; generation?: number; status?: string; createdAt?: string } = {}
): void {
  serverDb().runtimes.insert({
    runtimeId,
    runtimeKind: 'harness',
    hostSessionId: patch.hostSessionId ?? 'hs-t07650-stale',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: patch.generation ?? 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: patch.status ?? 'ready',
    statusChangedAt: NOW,
    supportsInflightInput: false,
    adopted: false,
    createdAt: patch.createdAt ?? NOW,
    updatedAt: patch.createdAt ?? NOW,
  })
}

function seedLiveRuntime(): void {
  seedSession('hs-t07650-stale')
  seedRuntime('rt-t07650-stale')
}

async function startServer(options: Record<string, unknown> = {}): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      // Only an explicit call drives anything: the proof is about the sweep,
      // not about whichever timer happened to fire.
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
      federationConfig: federationConfig(),
      ...options,
    })
  )
  return server
}

function serverDb(): HrcDatabase {
  return (server as unknown as { db: HrcDatabase }).db
}

async function sweep(): Promise<void> {
  await (server as unknown as { runMailKickerSweep: () => Promise<void> }).runMailKickerSweep()
}

/** Count the registry consults the daemon actually makes. */
function countConsults(): () => number {
  const client = (server as unknown as { federationRegistryClient: { consult: unknown } })
    .federationRegistryClient
  const real = client.consult as (scopeRef: string) => Promise<unknown>
  let calls = 0
  client.consult = async (scopeRef: string) => {
    calls += 1
    return real.call(client, scopeRef)
  }
  return () => calls
}

function skipLines(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes('wrkq.kicker.foreign_home_skipped'))
}

describe('T-07650 — the sweep does not drive scopes another node homes', () => {
  it('skips a stale local seat whose registry authority lives elsewhere', async () => {
    registerScopeHomedOn(HOME_NODE)
    say({ body: 'addressed to a scope this node no longer homes' })
    await startServer()
    seedLiveRuntime()
    const deterministic = installDeterministicStart(server as HrcServer)

    const { lines } = await captureServerLog(async () => {
      await sweep()
    })

    // Nothing claimed, nothing dispatched, nothing failed typed.
    expect(deterministic.calls()).toBe(0)
    expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(0)
    expect(lines.filter((line) => line.includes('wrkq.kicker.drive_failed'))).toHaveLength(0)

    const skipped = skipLines(lines)
    expect(skipped).toHaveLength(1)
    // Unredacted, and it names the node that CAN drive it: a skip nobody can
    // read is the same silence this replaced.
    expect(skipped[0]).toContain(TARGET)
    expect(skipped[0]).toContain(`"homeNodeId":"${HOME_NODE}"`)
    expect(skipped[0]).not.toContain('placementEpoch')
    expect(skipped[0]).toContain('"source":"registry"')
    expect(skipped[0]).not.toContain('[REDACTED]')
  })

  it('says it once and consults once, however many ticks the sweep runs', async () => {
    registerScopeHomedOn(HOME_NODE)
    say()
    await startServer()
    seedLiveRuntime()
    installDeterministicStart(server as HrcServer)
    const consults = countConsults()

    const { lines } = await captureServerLog(async () => {
      await sweep()
      await sweep()
      await sweep()
    })

    expect(skipLines(lines)).toHaveLength(1)
    expect(consults()).toBe(1)
    expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(0)
  })

  it('finishes the claimed attempt a foreign-homed scope left holding the drive slot', async () => {
    registerScopeHomedOn(HOME_NODE)
    say()
    await startServer()
    seedLiveRuntime()
    installDeterministicStart(server as HrcServer)

    // Exactly the rows found live: claimed, never started, holding the slot and
    // re-entering listInFlightTargets() on every tick for hours.
    const claim = serverDb().mailDrives.claim(TARGET, 'periodic', { envelopeIds: ['EN-00001'] })
    expect(claim.outcome).toBe('acquired')
    expect(serverDb().mailDrives.listInFlightTargets()).toContain(TARGET)

    await sweep()

    const attempts = serverDb().mailDrives.listAttempts(TARGET)
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.state).toBe('withdrawn')
    expect(attempts[0]?.lastError).toContain(HOME_NODE)
    expect(serverDb().mailDrives.listInFlightTargets()).not.toContain(TARGET)
  })

  it('answers from the local placement ledger without touching the registry', async () => {
    registerScopeHomedOn(HOME_NODE)
    say()
    await startServer()
    seedLiveRuntime()
    installDeterministicStart(server as HrcServer)
    createPlacementLedgerRepository(serverDb().sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId: HOME_NODE,
      updatedAt: NOW,
    })
    const consults = countConsults()

    const { lines } = await captureServerLog(async () => {
      await sweep()
    })

    expect(consults()).toBe(0)
    const skipped = skipLines(lines)
    expect(skipped).toHaveLength(1)
    expect(skipped[0]).toContain('"source":"placement-ledger"')
    expect(skipped[0]).not.toContain('placementEpoch')
  })

  it('does not turn an unreachable registry into a skip', async () => {
    registerScopeHomedOn(HOME_NODE)
    say()
    await startServer()
    seedLiveRuntime()
    installDeterministicStart(server as HrcServer)
    const client = (server as unknown as { federationRegistryClient: { consult: unknown } })
      .federationRegistryClient
    client.consult = async () => {
      throw new Error('registry unreachable')
    }

    const { lines } = await captureServerLog(async () => {
      await sweep()
    })

    // No evidence of a foreign home is not evidence of one. The wake proceeds
    // and the gate classifies the failure exactly as it did before.
    expect(skipLines(lines)).toHaveLength(0)
    expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(1)
  })
})

describe('T-07650 — the receipt names the current seat, not the oldest row', () => {
  /**
   * The stamp used to be `listByHostSessionId(...).find(r => r.status !==
   * 'exited')`. That query is `ORDER BY created_at ASC`, and `'exited'` is a
   * broker invocation state that no runtime row has ever held — so it excluded
   * nothing and always returned the FIRST runtime the host session ever had.
   * The fleet audits found it everywhere with zero corpses behind it.
   */
  function homeScopeHere(): void {
    createPlacementLedgerRepository(serverDb().sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId: LOCAL_NODE,
      updatedAt: timestamp(),
    })
  }

  async function receiptFor(envelopeId: string): Promise<{ runtimeId?: string }> {
    await waitUntil(
      () => (ledger.envelopes.get(envelopeId)?.presentedTo.length ?? 0) > 0,
      'envelope presented'
    )
    return ledger.envelopes.get(envelopeId)?.presentedTo[0] as { runtimeId?: string }
  }

  it('names the newest live runtime of the host session, not its first', async () => {
    registerScopeHomedOn(LOCAL_NODE)
    const envelope = say({ body: 'stamped against the seat that is actually there' })
    await startServer()
    homeScopeHere()
    seedSession('hs-t07650-stamp')
    // The exact live shape: one host session, several runtime ids over its
    // life, the oldest long dead and the newest serving.
    seedRuntime('rt-oldest', {
      hostSessionId: 'hs-t07650-stamp',
      status: 'terminated',
      createdAt: '2026-07-20T13:02:14.000Z',
    })
    seedRuntime('rt-current', {
      hostSessionId: 'hs-t07650-stamp',
      status: 'ready',
      createdAt: '2026-08-28T00:56:41.000Z',
    })
    installDeterministicStart(server as HrcServer)

    await sweep()
    expect((await receiptFor(envelope.id)).runtimeId).toBe('rt-current')
  })

  it('never names a prior-generation runtime left ready by a rotation', async () => {
    registerScopeHomedOn(LOCAL_NODE)
    const envelope = say({ body: 'gen 27 must not answer for gen 50' })
    await startServer()
    homeScopeHere()
    // The max3 specimen: rt-73097d08 gen 27, `ready` since 17:00Z, beside the
    // authoritative gen-50 seat. Newest-by-creation alone would pick it.
    seedSession('hs-t07650-rotated', 2)
    seedRuntime('rt-current-gen', {
      hostSessionId: 'hs-t07650-rotated',
      generation: 2,
      status: 'ready',
      createdAt: '2026-08-28T00:10:00.000Z',
    })
    seedRuntime('rt-prior-gen', {
      hostSessionId: 'hs-t07650-rotated',
      generation: 1,
      status: 'ready',
      createdAt: '2026-08-28T01:00:00.000Z',
    })
    installDeterministicStart(server as HrcServer)

    await sweep()
    expect((await receiptFor(envelope.id)).runtimeId).toBe('rt-current-gen')
  })

  it('stamps the fresh delivery runtime rather than the wrong prior-generation one', async () => {
    registerScopeHomedOn(LOCAL_NODE)
    const envelope = say({ body: 'no current-generation seat exists' })
    await startServer()
    homeScopeHere()
    // The seat is live — so the sweep still finds the scope — but it belongs to
    // an older generation than the session's. That is the gen-27 specimen with
    // its gen-50 sibling missing, and it is the case where the old expression
    // had nothing right to return and returned the prior generation anyway.
    seedSession('hs-t07650-rotated-away', 4)
    seedRuntime('rt-prior-gen-only', {
      hostSessionId: 'hs-t07650-rotated-away',
      generation: 1,
      status: 'ready',
      createdAt: '2026-08-28T00:10:00.000Z',
    })
    installDeterministicStart(server as HrcServer)

    await sweep()
    // Two-phase presentation commits after dispatch, so the receipt now knows
    // the fresh runtime that accepted the prompt. It must never fall back to
    // the unrelated prior-generation row that happened to keep `ready`.
    const receipt = await receiptFor(envelope.id)
    expect(receipt.runtimeId).toBe('rt-hs-t07650-rotated-away-0')
    expect(receipt.runtimeId).not.toBe('rt-prior-gen-only')
  })
})

describe('T-07650 — shadow teardown retires seats this node has no authority for', () => {
  async function teardown(): Promise<void> {
    await (
      server as unknown as { runForeignHomeShadowTeardown: () => Promise<void> }
    ).runForeignHomeShadowTeardown()
  }

  function statusOf(runtimeId: string): string | undefined {
    return serverDb().runtimes.getByRuntimeId(runtimeId)?.status
  }

  it('retires every live runtime of a host session whose scope is homed elsewhere', async () => {
    registerScopeHomedOn(HOME_NODE)
    await startServer()
    seedSession('hs-t07650-shadow')
    // A runtime id churns mid-session — one svc shadow cycled five in five
    // weeks — so the unit is the host session, not the id.
    seedRuntime('rt-shadow-a', { hostSessionId: 'hs-t07650-shadow', status: 'ready' })
    seedRuntime('rt-shadow-b', { hostSessionId: 'hs-t07650-shadow', status: 'busy' })

    const { lines } = await captureServerLog(async () => {
      await teardown()
    })

    expect(statusOf('rt-shadow-a')).not.toBe('ready')
    expect(statusOf('rt-shadow-b')).not.toBe('busy')
    const retired = lines.filter((line) => line.includes('federation.shadow_teardown.retired'))
    expect(retired).toHaveLength(1)
    expect(retired[0]).toContain('hs-t07650-shadow')
    expect(retired[0]).toContain(`"homeNodeId":"${HOME_NODE}"`)
    expect(retired[0]).toContain('rt-shadow-a')
    expect(retired[0]).toContain('rt-shadow-b')
    expect(retired[0]).not.toContain('[REDACTED]')
  })

  it('leaves a seat this node homes alone, and says so every tick', async () => {
    registerScopeHomedOn(LOCAL_NODE)
    await startServer()
    createPlacementLedgerRepository(serverDb().sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId: LOCAL_NODE,
      updatedAt: timestamp(),
    })
    seedSession('hs-t07650-mine')
    seedRuntime('rt-mine', { hostSessionId: 'hs-t07650-mine', status: 'ready' })

    const { lines } = await captureServerLog(async () => {
      await teardown()
    })

    expect(statusOf('rt-mine')).toBe('ready')
    expect(lines.filter((line) => line.includes('shadow_teardown.retired'))).toHaveLength(0)
    // A healthy timer and a dead timer must not look identical from the log.
    const complete = lines.filter((line) => line.includes('shadow_teardown.complete'))
    expect(complete).toHaveLength(1)
    expect(complete[0]).toContain('"shadowSessions":0')
  })

  it('arms on a federated node and stays dark on a single-node one', async () => {
    registerScopeHomedOn(HOME_NODE)
    await startServer()
    const armed = server as unknown as { shadowTeardownTimer: unknown }
    // A sweep that never fires and a sweep that finds nothing look identical
    // from the outside, which is the failure mode this whole task is about.
    expect(armed.shadowTeardownTimer).toBeDefined()

    await (server as HrcServer).stop()
    server = undefined
    await startServer({ federationConfig: federationConfig(false) })
    expect(
      (server as unknown as { shadowTeardownTimer: unknown }).shadowTeardownTimer
    ).toBeUndefined()
  })

  it('never acts on an unreachable registry', async () => {
    registerScopeHomedOn(HOME_NODE)
    await startServer()
    seedSession('hs-t07650-unknown')
    seedRuntime('rt-unknown', { hostSessionId: 'hs-t07650-unknown', status: 'ready' })
    const client = (server as unknown as { federationRegistryClient: { consult: unknown } })
      .federationRegistryClient
    client.consult = async () => {
      throw new Error('registry unreachable')
    }

    const { lines } = await captureServerLog(async () => {
      await teardown()
    })

    // The cost of a false positive here is killing a seat that was doing its
    // job, so no evidence means no action.
    expect(statusOf('rt-unknown')).toBe('ready')
    expect(lines.filter((line) => line.includes('shadow_teardown.retired'))).toHaveLength(0)
  })
})
