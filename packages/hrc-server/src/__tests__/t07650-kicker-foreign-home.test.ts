import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { createPlacementLedgerRepository, openBindingRegistry } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { FederationConfig } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
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
 * The live shape, from lab and max3: a rebind moves a scope's authority away,
 * but the losing node keeps a live runtime row for it AND every attempt it
 * claimed for it, because an attempt that dies at the summon gate is only
 * annotated, never finished. Both of the sweep's candidate sources therefore
 * keep naming the scope forever, and every tick re-drove it into the same
 * `bound-elsewhere` refusal — 14 typed `wrkq.kicker.drive_failed` per tick on
 * max3, 170 in one afternoon on lab, plus one more permanently stuck attempt
 * row each time.
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
function federationConfig(): FederationConfig {
  return {
    nodeId: parseNodeId(LOCAL_NODE, 'test node'),
    nodeIdProvenance: 'declared',
    sourcePath: `${fixture.stateRoot}/federation.json`,
    sourceExists: true,
    peers: new Map(),
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
      placementEpoch: 1,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'pin',
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
function seedLiveRuntime(): void {
  const db = serverDb()
  db.sessions.insert({
    hostSessionId: 'hs-t07650-stale',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  db.runtimes.insert({
    runtimeId: 'rt-t07650-stale',
    runtimeKind: 'harness',
    hostSessionId: 'hs-t07650-stale',
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    harness: 'codex-cli',
    provider: 'openai',
    status: 'ready',
    statusChangedAt: NOW,
    supportsInflightInput: false,
    adopted: false,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      // Only an explicit call drives anything: the proof is about the sweep,
      // not about whichever timer happened to fire.
      hrcMailKickerSweepIntervalMs: 60_000,
      otelListenerEnabled: false,
      wrkqLedger: ledger,
      federationConfig: federationConfig(),
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
    expect(skipped[0]).toContain('"placementEpoch":1')
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
    expect(attempts[0]?.state).toBe('failed')
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
      placementEpoch: 2,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'rebind',
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
    expect(skipped[0]).toContain('"placementEpoch":2')
  })

  it('still drives a scope this node homes, and stops skipping one rebound back', async () => {
    registerScopeHomedOn(HOME_NODE)
    say({ body: 'delivered once authority returns' })
    await startServer()
    seedLiveRuntime()
    const deterministic = installDeterministicStart(server as HrcServer)

    await sweep()
    expect(deterministic.calls()).toBe(0)

    // What an activated rebind installs. The local ledger is read ahead of the
    // remembered registry answer, so the scope resumes on the very next tick
    // rather than waiting for a restart to forget.
    createPlacementLedgerRepository(serverDb().sqlite).installActive({
      scopeRef: SCOPE,
      homeNodeId: LOCAL_NODE,
      placementEpoch: 2,
      birthClass: 'policy-born',
      authorityProvenance: { kind: 'policy', source: 'pin' },
      establishmentProvenance: 'rebind',
      updatedAt: timestamp(),
    })

    await sweep()
    await waitUntil(() => deterministic.calls() === 1, 'the returned scope was driven')
    expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(1)
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
