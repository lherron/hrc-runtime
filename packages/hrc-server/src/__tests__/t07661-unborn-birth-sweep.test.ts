import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { HrcConflictError, HrcErrorCode } from 'hrc-core'
import { openBindingRegistry } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import type { FederationConfig, PeerEntry } from '../federation/federation-config.js'
import { parseNodeId } from '../federation/node-id.js'
import { PeerToken } from '../federation/peer-token.js'
import { resolveBindingRegistryPath } from '../federation/registry-endpoint.js'
import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'
import {
  captureServerLog,
  installDeterministicStart,
  installMailKickerAgentHome,
  waitUntil,
} from './fixtures/mail-kicker-harness.js'

/**
 * T-07661 — a virgin scope whose birth was refused has a wake source.
 *
 * THE LIVE SHAPE (T-07658, found on T-07655 acceptance 3). A virgin scope was
 * designated to max3; max3's establish was refused by a transient cause; the
 * `reply_required` envelope then sat `pending` with `presentedTo: []` for 21
 * minutes across a daemon restart, and was born only when an UNRELATED later
 * insert to the same scope re-woke the kicker.
 *
 * WHY NOTHING CAUGHT IT. The kicker has two wake sources and a virgin scope has
 * neither for a second time. The ledger TAIL is consumed once — the cursor is
 * already past the insert that was refused — and the periodic SWEEP's candidate
 * set is the scopes this node SEATS plus its in-flight attempts, so a scope
 * nobody has ever seated is invisible to it. Nothing was lost, but delivery
 * depended on luck.
 *
 * The proof is therefore always the same: ONE insert, a refusal, and then the
 * sweep alone — with `ledger.events.length` asserted unchanged, because "an
 * unrelated insert rescued it" is exactly the false green this closes.
 */

const AGENT = 'kicker-unborn'
const SCOPE = `agent:${AGENT}:project:hrc-runtime:task:T-07661`
const TARGET = `${SCOPE}/lane:main`
const SENDER_SCOPE = 'agent:mable:project:wrkq:task:primary'
const LOCAL_NODE = 'max3'
const PEER_NODE = 'lab'
const NOW = '2026-08-28T07:00:00.000Z'

let fixture: HrcServerTestFixture
let server: HrcServer | undefined
let ledger: FakeWrkqLedger
let restoreAgentHome: () => void

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-kicker-unborn-birth-')
  ledger = new FakeWrkqLedger()
  const home = await installMailKickerAgentHome(fixture.tmpDir, AGENT)
  // The summon gate runs in `enforce` mode here, because this node is federated
  // and hosts the registry. Capability is checked BEFORE a birth, and an agent
  // home with no SOUL.md cannot compose — so without this the sweep would be
  // proved to reach a refusal rather than a birth.
  await writeFile(join(home.agentsRoot, AGENT, 'SOUL.md'), `# ${AGENT}\n`)
  restoreAgentHome = home.restore
})

afterEach(async () => {
  if (server !== undefined) {
    await server.stop()
    server = undefined
  }
  restoreAgentHome()
  await fixture.cleanup()
})

/** A free loopback port, released immediately and handed to the daemon. */
function reserveLoopbackBind(): string {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('probe') })
  const port = probe.port
  probe.stop(true)
  return `http://127.0.0.1:${port}`
}

/** This node hosts the collective registry, so every designation read is real. */
function federationConfig(): FederationConfig {
  const peers = new Map<string, PeerEntry>()
  const peer = parseNodeId(PEER_NODE, 'test peer')
  peers.set(peer, {
    nodeId: peer,
    endpoint: 'http://lab.example.ts.net:18490/',
    token: new PeerToken('t07661-test-token'),
  })
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

/**
 * The designation the collective had ALREADY recorded when the birth was
 * refused, written before the daemon opens the registry.
 *
 * This is the live shape and not a convenience: on T-07658 the gate ran, the
 * designation was derived and recorded, and only the establish that followed it
 * failed. A test that seeded no designation would be proving a different bug.
 */
function designateBirthOn(homeNodeId: string): void {
  const registry = openBindingRegistry(resolveBindingRegistryPath(fixture.stateRoot))
  try {
    registry.recordDesignation({
      scopeRef: SCOPE,
      homeNodeId,
      provenance: 'default_home_node(sender)',
      birthEnvelopeId: 'EN-00745',
      senderScopeRef: SENDER_SCOPE,
      now: NOW,
    })
  } finally {
    registry.close()
  }
}

function say(overrides: Partial<Parameters<FakeWrkqLedger['say']>[0]> = {}) {
  return ledger.say({
    toScopeRef: SCOPE,
    fromScopeRef: SENDER_SCOPE,
    roomKey: 'T-07661',
    ...overrides,
  })
}

async function startServer(): Promise<HrcServer> {
  server = await createHrcServer(
    fixture.serverOpts({
      hrcMailKickerEnabled: true,
      // Only an explicit call drives anything: the proof is about the SWEEP,
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

async function tail(): Promise<void> {
  await (server as unknown as { runWrkqLedgerTail: () => Promise<void> }).runWrkqLedgerTail()
}

/**
 * Mint the tail cursor BEFORE the envelope is written, so the say that follows
 * is a live INSERT WAKE rather than a cold-start backlog.
 *
 * The distinction is the whole bug: T-07643 already closed the backlog case for
 * scopes this node homes, and a virgin scope is precisely one it does not.
 */
async function armTail(): Promise<void> {
  await tail()
}

/**
 * Refuse the first N establishes with a RETRYABLE gate refusal, then let the
 * real one run.
 *
 * `registry-refused` is the actual T-07658 cause: the wire whitelist did not
 * spell the two designated provenances, so the designated node's own establish
 * came back 400. Nothing about the scope, the mail, or the designation was
 * wrong — which is exactly why a second chance is owed.
 */
function refuseEstablishes(serverInstance: HrcServer, times: number): { calls: () => number } {
  const real = (
    serverInstance as unknown as { ensureTargetSession: (...args: unknown[]) => unknown }
  ).ensureTargetSession.bind(serverInstance)
  let calls = 0
  ;(serverInstance as unknown as { ensureTargetSession: unknown }).ensureTargetSession = async (
    ...args: unknown[]
  ) => {
    calls += 1
    if (calls <= times) {
      throw new HrcConflictError(
        HrcErrorCode.STALE_CONTEXT,
        `${SCOPE} could not be established: the registry refused the designated provenance`,
        { scopeRef: SCOPE, path: 'ensure-target', reason: 'registry-refused', retryable: true }
      )
    }
    return real(...args)
  }
  return { calls: () => calls }
}

function sessionCount(): number {
  return serverDb().sessions.listByScopeRef(SCOPE, 'main').length
}

describe('T-07661 — the sweep is a second chance for a refused virgin birth', () => {
  it('births a designated virgin scope on the next sweep, with no new insert', async () => {
    designateBirthOn(LOCAL_NODE)
    await startServer()
    const live = server as HrcServer
    installDeterministicStart(live)
    const establish = refuseEstablishes(live, 1)
    await armTail()

    // 1. The insert wake — the scope's ONE wake source today — is refused.
    const envelope = say({ body: 'the one and only insert' })
    await tail()
    await waitUntil(() => establish.calls() === 1, 'the insert wake attempted a birth')
    expect(sessionCount()).toBe(0)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(0)

    // 2. Nothing else arrives. The sweep is the only thing that happens next.
    const insertsBefore = ledger.events.length
    await sweep()
    await waitUntil(() => sessionCount() === 1, 'the sweep birthed the refused virgin scope')

    // The whole point: no unrelated traffic rescued it.
    expect(ledger.events.length).toBe(insertsBefore)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
    expect(serverDb().mailDrives.listAttempts(TARGET).at(-1)?.wakeReason).toBe('periodic')
  })

  it('births a `none`-class virgin scope this node is the default home for', async () => {
    // A human sender names no scope, so the registry designates NOTHING and
    // tier 5 stays local. There is no designation row to enumerate, so the
    // candidate has to come from this node's own record of the refused drive.
    await startServer()
    const live = server as HrcServer
    installDeterministicStart(live)
    const establish = refuseEstablishes(live, 1)
    await armTail()

    const envelope = ledger.say({
      toScopeRef: SCOPE,
      fromPrincipalRef: 'agent:lance',
      roomKey: 'T-07661',
      body: 'from a human, so nothing is designated',
    })
    await tail()
    await waitUntil(() => establish.calls() === 1, 'the insert wake attempted a birth')
    expect(sessionCount()).toBe(0)

    const insertsBefore = ledger.events.length
    await sweep()
    await waitUntil(() => sessionCount() === 1, 'the sweep birthed the `none`-class virgin scope')
    expect(ledger.events.length).toBe(insertsBefore)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
  })

  it('does not spin: a permanently refusing scope is retried at most once per floor', async () => {
    designateBirthOn(LOCAL_NODE)
    await startServer()
    const live = server as HrcServer
    installDeterministicStart(live)
    // Never succeeds. Without a bound this is a birth attempt every 30 seconds
    // for as long as the envelope stays undisposed, which is forever.
    refuseEstablishes(live, Number.MAX_SAFE_INTEGER)
    await armTail()

    say()
    await tail()
    await waitUntil(
      () => serverDb().mailDrives.listAttempts(TARGET).length === 1,
      'the insert wake attempted a birth'
    )

    await sweep()
    await waitUntil(
      () => serverDb().mailDrives.listAttempts(TARGET).length === 2,
      'the first sweep took its one retry'
    )

    // Five more sweeps inside the first floor. The floor is wall-clock, so none
    // of them may attempt anything.
    for (let index = 0; index < 5; index += 1) await sweep()
    expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(2)
    expect(sessionCount()).toBe(0)
  })

  it('births a designated scope this node never even attempted', async () => {
    // The designated node was DOWN when the insert wake fired, so it holds no
    // drive attempt to remember the scope by. Only the collective's own record
    // — the live designation naming it — can reach this one, which is why the
    // registry read is not redundant with the local half.
    designateBirthOn(LOCAL_NODE)
    const envelope = say({ body: 'fired while the designated node was down' })
    await startServer()
    const live = server as HrcServer
    installDeterministicStart(live)
    await armTail()
    expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(0)

    const insertsBefore = ledger.events.length
    await sweep()
    await waitUntil(() => sessionCount() === 1, 'the sweep birthed a scope it had never attempted')
    expect(ledger.events.length).toBe(insertsBefore)
    expect(ledger.envelopes.get(envelope.id)?.presentedTo).toHaveLength(1)
  })

  it('never claims a virgin scope designated to another node (T-07650 intact)', async () => {
    designateBirthOn(PEER_NODE)
    await startServer()
    const live = server as HrcServer
    installDeterministicStart(live)
    await armTail()
    say()

    // The insert wake reaches the gate and is correctly deferred, which leaves
    // exactly the local record the `none`-class candidate source reads. That
    // record must NOT become a reason to re-drive a birth the collective placed
    // somewhere else: the designated node births it from the same insert, and a
    // second claimant here is the multi-node race T-07655 removed.
    const { lines } = await captureServerLog(async (captured) => {
      await tail()
      await waitUntil(
        () => captured.some((line) => line.includes('wrkq.kicker.birth_deferred')),
        'the insert wake deferred the birth'
      )
      const deferred = serverDb().mailDrives.listAttempts(TARGET).length
      await sweep()
      await sweep()
      expect(serverDb().mailDrives.listAttempts(TARGET)).toHaveLength(deferred)
    })

    expect(sessionCount()).toBe(0)
    expect(lines.filter((line) => line.includes('wrkq.kicker.drive_failed'))).toHaveLength(0)
    expect(lines.filter((line) => line.includes('wrkq.kicker.unborn_birth_retry'))).toHaveLength(0)
  })
})
