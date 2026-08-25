/**
 * RED tests — T-01875 / T-01862 Ph4: endpoint/substrate-driven startup
 * reconciliation, orphan sweeper, lazy dispatch reattach, and zombie/activity
 * handling.
 *
 * Ph4 replaces the transport-driven broker GC loop with endpoint/substrate-driven
 * reconciliation keyed off `parseBrokerRuntimeHostingState` + predicates from
 * broker/runtime-hosting.ts. The following 10 scenarios all fail at HEAD because
 * the current code uses `runtime.transport === 'tmux'` as the gate:
 *
 *  Scenario 1  — reconcileDurableBrokerStartup REATTACHES a headless durable
 *                runtime after daemon restart; NO broker_orphaned_on_restart event.
 *                AT HEAD: transport guard skips headless → runtime absent from outcomes.
 *
 *  Scenario 2  — reconcileDurableBrokerRuntimeReattach handles an interactive
 *                runtime persisted in the NORMALIZED hosting-state shape
 *                (broker.substrate / broker.presentation keys). brokerLeaseWindowsMatch
 *                reads flat-shape only → window check fails → stale instead of reattach.
 *
 *  Scenario 3  — reconcileDurableBrokerStartup stales a legacy daemon-child headless
 *                row with broker_legacy_no_durable_endpoint_on_restart.
 *                AT HEAD: runtime skipped → not in outcomes.
 *
 *  Scenario 4  — reconcileDurableBrokerStartup stales a nonterminal v0.1 row
 *                (endpoint=stdio-jsonrpc-ndjson) with
 *                broker_protocol_legacy_unsupported_on_startup.
 *                AT HEAD: transport+endpoint guard skips it → not in outcomes.
 *
 *  Scenario 5  (G4) — reconcileDurableBrokerRuntimeReattach for a HEADLESS runtime
 *                (presentation.none): probe with matching brokerWindow but null
 *                tuiWindow REATTACHES. brokerLeaseWindowsMatch requires tuiWindow
 *                for ALL leased substrates → fails for presentation.none.
 *
 *  Scenario 6  — Orphan sweeper PRESERVES a headless (transport='headless') runtime
 *                with leased-tmux substrate pointing to a live socket.
 *                AT HEAD: sweeper gates on transport==='tmux' → headless not claimed
 *                → socket killed.
 *
 *  Scenario 7  — Orphan sweeper still REAPS an unclaimed/dead leased substrate
 *                regardless of the headless-claim fix. (Sanity check that the
 *                substrate-based claim detection doesn't over-protect.)
 *
 *  Scenario 8  (G5) — reattachDurableBrokerForDispatch reattaches a HEADLESS
 *                runtime (presentation.none) when the broker socket is live.
 *                AT HEAD: brokerLeaseWindowsMatch fails (no tuiWindow) → returns false.
 *
 *  Scenario 9  (G5/G4) — reattachDurableBrokerForDispatch for a HEADLESS runtime
 *                does NOT attempt direct tmux pane input when reattach fails
 *                (canUseDirectPaneFallback===false guards the pane path).
 *
 *  Scenario 10 (G6) — After a successful broker.attach + replay in
 *                reconcileDurableBrokerRuntimeReattach, the active RUN's activity
 *                timestamp is updated so a recovered in-flight run is NOT zombied by
 *                a subsequent zombie sweep.
 *                AT HEAD: outcome returned without updating run → zombie sweep kills it.
 *
 * Harness fidelity: real HRC SQLite + real HarnessBrokerController + scripted mock
 * DurableBrokerClient. No live broker, no live tmux (except scenarios 6/7 which
 * create real tmux sessions for the orphan sweep, following broker-pane-lease-orphan-
 * sweep.red.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { HarnessBrokerController } from '../broker/controller'
import { canUseDirectPaneFallback } from '../broker/runtime-hosting'
import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import * as reconcile from '../startup-reconcile'
import * as ph4 from './fixtures/broker-endpoint-substrate.fixture'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// ─────────────────────────────────────────────────────────────────────────────
// Shared fixture constants
// ─────────────────────────────────────────────────────────────────────────────

let dir: string
let dbPath: string
let db: HrcDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-ph4-'))
  dbPath = join(dir, 'test.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

function readRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const rt = db.runtimes.getByRuntimeId(runtimeId)
  if (!rt) throw new Error(`runtime ${runtimeId} vanished`)
  return rt
}

function makeController(overrideDb?: HrcDatabase): HarnessBrokerController {
  return new HarnessBrokerController({
    db: overrideDb ?? db,
    now: () => ph4.nowTs(),
    serverInstanceId: ph4.SERVER_INSTANCE_ID,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 2: interactive runtime with normalized shape reattaches', () => {
  it('reconcileDurableBrokerRuntimeReattach returns broker-attached for a normalized-shape interactive runtime', async () => {
    ph4.seedInteractiveNormalizedRuntime(db)

    const client = new ph4.MockDurableBrokerClient()
    const snap = ph4.emptySnapshot(ph4.INTERACTIVE_INVOCATION_ID, {
      currentSeq: 1,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.INTERACTIVE_RUNTIME_ID,
      ph4.INTERACTIVE_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        ph4.makeEnvelope(ph4.INTERACTIVE_INVOCATION_ID, 'invocation.ready', 1, { state: 'ready' }),
      ],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const controller = makeController()
    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller,
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          // Probe carries the matching identity from the normalized substrate.
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: ph4.TUI_WINDOW, // presentation.tmux-tui requires tuiWindow
        }),
      }
    )

    // Ph4: normalized shape must be handled by parseBrokerRuntimeHostingState
    // + brokerLeaseIdentityMatches → broker-attached.
    // AT HEAD: brokerLeaseWindowsMatch reads flat broker['brokerWindow']=undefined
    // (absent in normalized shape) → returns false → stale.
    expect(outcome.state).toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(true)
    expect(client.calls).toContain('attach')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: Legacy daemon-child headless → broker_legacy_no_durable_endpoint_on_restart
//
// RED: At HEAD, reconcileDurableBrokerStartup skips the legacy runtime (no
// durable endpoint → filtered out), so it is NOT in outcomes and the staling
// happens (with wrong reason broker_orphaned_on_restart) only via the blanket
// GC loop in reconcileStartupState. After Ph4: reconcileDurableBrokerStartup
// processes ALL nonterminal harness-broker runtimes and stales legacy ones with
// the precise reason broker_legacy_no_durable_endpoint_on_restart.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 3: legacy daemon-child headless → broker_legacy_no_durable_endpoint_on_restart', () => {
  it('reconcileDurableBrokerStartup stales a legacy headless runtime with the precise reason', async () => {
    ph4.seedLegacyDaemonChildRuntime(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      runtimeRoot: ph4.RUNTIME_ROOT,
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not be called for legacy/v0.1 classify-once path')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('must not probe legacy daemon-child runtime')
      },
      sweepOrphans: async () => {},
    })

    // Ph4: legacy runtime must appear in outcomes with specific reason.
    // AT HEAD: outcomes is empty for this runtime → headlessOutcome is undefined.
    const legacyOutcome = outcomes.find((o) => o.runtimeId === ph4.LEGACY_RUNTIME_ID)
    expect(legacyOutcome).toBeDefined()
    expect(legacyOutcome?.state).toBe('stale')
    expect(legacyOutcome?.reason).toBe('broker_legacy_no_durable_endpoint_on_restart')

    // Runtime must actually be staled in DB with the correct staleReason.
    const runtime = readRuntime(ph4.LEGACY_RUNTIME_ID)
    expect(runtime.status).toBe('stale')
    const staleReason = (runtime.runtimeStateJson as Record<string, unknown>)?.['staleReason']
    expect(staleReason).toBe('broker_legacy_no_durable_endpoint_on_restart')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: v0.1 row (endpoint=stdio) → broker_protocol_legacy_unsupported_on_startup
//
// RED: At HEAD, v0.1 row (transport='tmux', endpoint=stdio) is skipped by
// reconcileDurableBrokerStartup (no unix endpoint → filtered). After Ph4:
// classify-once with precedence v0.1 > no-endpoint stales it with
// broker_protocol_legacy_unsupported_on_startup.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 4: v0.1 row → broker_protocol_legacy_unsupported_on_startup', () => {
  it('reconcileDurableBrokerStartup stales a v0.1 stdio-endpoint row with the legacy protocol reason', async () => {
    ph4.seedV01Row(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      runtimeRoot: ph4.RUNTIME_ROOT,
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('must not be called for v0.1 rows')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('must not probe v0.1 row')
      },
      sweepOrphans: async () => {},
    })

    // Ph4: v0.1 row must appear in outcomes with the protocol-legacy reason.
    // AT HEAD: outcomes is empty (no unix endpoint → filter skips it).
    const v01Outcome = outcomes.find((o) => o.runtimeId === ph4.V01_RUNTIME_ID)
    expect(v01Outcome).toBeDefined()
    expect(v01Outcome?.state).toBe('stale')
    expect(v01Outcome?.reason).toBe('broker_protocol_legacy_unsupported_on_startup')

    // Precedence: v0.1 (stdio endpoint present) before no-durable-endpoint.
    const runtime = readRuntime(ph4.V01_RUNTIME_ID)
    expect(runtime.status).toBe('stale')
    const staleReason = (runtime.runtimeStateJson as Record<string, unknown>)?.['staleReason']
    expect(staleReason).toBe('broker_protocol_legacy_unsupported_on_startup')
  })

  it('classify-once precedence: v0.1 stales with protocol reason, not no-endpoint reason', async () => {
    // Verify v0.1 gets protocol reason even though it also lacks a durable endpoint.
    ph4.seedV01Row(db)

    const outcomes = await reconcile.reconcileDurableBrokerStartup(db, {
      runtimeRoot: ph4.RUNTIME_ROOT,
      controller: makeController(),
      brokerUnixClientFactory: async () => {
        throw new Error('unused')
      },
      resolveAttachToken: async () => undefined,
      probeBrokerLease: async () => {
        throw new Error('unused')
      },
      sweepOrphans: async () => {},
    })

    const v01Outcome = outcomes.find((o) => o.runtimeId === ph4.V01_RUNTIME_ID)
    // Must be protocol-legacy, NOT broker_legacy_no_durable_endpoint_on_restart.
    expect(v01Outcome?.reason).not.toBe('broker_legacy_no_durable_endpoint_on_restart')
    expect(v01Outcome?.reason).toBe('broker_protocol_legacy_unsupported_on_startup')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5 (G4): reconcileDurableBrokerRuntimeReattach for headless (presentation.none)
// requires only brokerWindow, NOT tuiWindow
//
// RED: At HEAD, brokerLeaseWindowsMatch:
//   const persisted = getPersistedBrokerWindows(runtime)
//   if (!persisted?.brokerWindow || !persisted.tuiWindow) return false  ← fails for headless
// For a headless runtime, broker['tuiWindow'] is absent → persisted.tuiWindow = undefined
// → brokerLeaseWindowsMatch returns false → stale with broker_window_identity_mismatch.
// After Ph4: uses brokerLeaseIdentityMatches which skips tuiWindow when
// presentation.kind === 'none' → reattach succeeds.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 5 (G4): headless reattach requires only brokerWindow, not tuiWindow', () => {
  it('reconcileDurableBrokerRuntimeReattach with probe.tuiWindow=null succeeds for presentation.none', async () => {
    ph4.seedHeadlessDurableRuntime(db)

    const client = new ph4.MockDurableBrokerClient()
    const snap = ph4.emptySnapshot(ph4.HEADLESS_INVOCATION_ID, {
      currentSeq: 2,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.HEADLESS_RUNTIME_ID,
      ph4.HEADLESS_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.started', 1, {
          pid: 1,
          command: 'claude',
          args: [],
          cwd: '/tmp',
        }),
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.ready', 2, { state: 'ready' }),
      ],
      currentSeq: 2,
      retentionFloorSeq: 1,
    })

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.BROKER_WINDOW, // matching brokerWindow
          tuiWindow: null, // no TUI window — presentation.none
        }),
      }
    )

    // Ph4: presentation.none → only brokerWindow identity required → reattach.
    // AT HEAD: brokerLeaseWindowsMatch requires !persisted.tuiWindow to be falsy,
    // but ALSO requires persisted.tuiWindow to exist in the second branch →
    // the function returns false → outcome.state === 'stale'.
    expect(outcome.state).toBe('broker-attached')
    expect(outcome.brokerAttached).toBe(true)
    expect(client.calls).toContain('attach')
  })

  it('interactive reattach (presentation.tmux-tui) still fails when tuiWindow is missing from probe', async () => {
    // G4 counterpart: for presentation.tmux-tui, tuiWindow IS required.
    ph4.seedInteractiveNormalizedRuntime(db)

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => {
          throw new Error('must not dial when identity check fails')
        },
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: null, // missing → identity mismatch for tmux-tui
        }),
      }
    )

    // For presentation.tmux-tui, tuiWindow is REQUIRED. Probe missing it → stale.
    // This should PASS after Ph4 (the tmux-tui gate is stricter).
    // At HEAD: also stale (brokerLeaseWindowsMatch requires tuiWindow) — may already pass.
    // Kept as a regression guard.
    expect(outcome.state).toBe('stale')
    expect(outcome.brokerAttached).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios 6 & 7: Orphan sweeper with real tmux + createHrcServer
// These follow the pattern from broker-pane-lease-orphan-sweep.red.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const GRACE_ENV = 'HRC_BROKER_ORPHAN_SWEEP_GRACE_MS'

let serverFixture: HrcServerTestFixture
const liveServers: HrcServer[] = []
const leaseSockets: string[] = []
let priorGrace: string | undefined

// Use separate beforeEach/afterEach for the server-level tests.
// Bun runs describes in sequence so these are scoped to this block.

describe('Scenario 6: orphan sweeper PRESERVES headless leased substrate', () => {
  beforeEach(async () => {
    serverFixture = await createHrcTestFixture('hrc-ph4-sweep-')
    priorGrace = process.env[GRACE_ENV]
  })

  afterEach(async () => {
    for (const server of liveServers.splice(0)) {
      await server.stop()
    }
    for (const socketPath of leaseSockets.splice(0)) {
      try {
        const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await exited
      } catch {
        // fine
      }
    }
    if (priorGrace === undefined) {
      delete process.env[GRACE_ENV]
    } else {
      process.env[GRACE_ENV] = priorGrace
    }
    await serverFixture.cleanup()
  })

  function btmuxDir(): string {
    return join(serverFixture.runtimeRoot, 'btmux')
  }

  async function createLeaseSession(
    runtimeId: string
  ): Promise<{ socketPath: string; sessionName: string }> {
    await mkdir(btmuxDir(), { recursive: true })
    // Use short driver prefix to keep socket path under macOS 104-char limit.
    const socketPath = join(btmuxDir(), `cc-${runtimeId}.sock`)
    const sessionName = `hrc-cc-${runtimeId}`
    leaseSockets.push(socketPath)
    // T-04297: name the window 'broker' (the real headless lease shape) — the
    // startup probe inspects the 'broker' window, and a leased substrate with NO
    // observable broker window is now correctly staled+swept as a reboot zombie.
    const { exited } = Bun.spawn(
      ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'broker'],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    expect(await exited).toBe(0)
    return { socketPath, sessionName }
  }

  async function sessionAlive(socketPath: string, sessionName: string): Promise<boolean> {
    const mgr = createTmuxManager({ socketPath })
    // Use listSessionNames (not inspectSession) — listSessionNames doesn't
    // require a specific window name, making it robust for headless leases
    // whose first window is 'broker' (not 'main').
    return (await mgr.listSessionNames()).includes(sessionName)
  }

  /**
   * Seed a headless harness-broker runtime whose broker block points to the given
   * lease socket (flat shape: brokerWindow.socketPath = socketPath).
   *
   * The CURRENT sweeper checks `runtime.transport !== 'tmux'` → headless not
   * recognized as claiming the socket. After Ph4 it must check
   * hasLeasedBrokerSubstrate(runtime) and read the socket from substrate.
   */
  async function seedHeadlessClaimingRuntime(runtimeId: string, socketPath: string): Promise<void> {
    const swDb = openHrcDatabase(serverFixture.dbPath)
    const now = serverFixture.now()
    const hostSessionId = `hs_${runtimeId}`
    const scopeRef = `agent:smokey:project:hrc-runtime:task:T-01875:${runtimeId}`
    const sessionName = `hrc-cc-${runtimeId}`
    const tmux = createTmuxManager({ socketPath })
    const leaseIdentity = await tmux.inspectWindow({ sessionName, windowName: 'broker' })
    expect(leaseIdentity).not.toBeNull()
    try {
      swDb.sessions.insert({
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      swDb.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'headless', // ← headless; NOT 'tmux' — fails the current transport gate
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        // Flat-shape broker block with brokerWindow pointing to the real lease socket.
        // parseBrokerRuntimeHostingState reads this as substrate.kind=leased-tmux.
        runtimeStateJson: {
          schemaVersion: 'runtime-state/v1',
          kind: 'harness-broker',
          runtimeId,
          hostSessionId,
          generation: 1,
          status: 'ready',
          broker: {
            protocolVersion: 'harness-broker/0.2',
            ownerServerInstanceId: 'sweep-test',
            endpoint: {
              kind: 'unix-jsonrpc-ndjson',
              socketPath: join(serverFixture.runtimeRoot, 'bipc', `${runtimeId}.sock`),
              attachTokenRef: { kind: 'file', path: '/tmp/ph4-sweep.token', redacted: true },
            },
            generation: 1,
            // FLAT shape: brokerWindow.socketPath is the lease socket the sweeper must preserve.
            // The sweeper in Ph4 reads this via parseBrokerRuntimeHostingState → substrate.tmuxSocketPath.
            brokerWindow: {
              socketPath, // ← the lease socket this runtime claims
              sessionName, // `hrc-cc-${runtimeId}`
              windowName: 'broker',
              sessionId: leaseIdentity!.sessionId,
              windowId: leaseIdentity!.windowId,
              paneId: leaseIdentity!.paneId,
            },
            // No tuiWindow → presentation.none
          },
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
    } finally {
      swDb.close()
    }
  }

  it('headless runtime (transport=headless) with leased substrate is NOT swept', async () => {
    const runtimeId = 'hdlA'
    const { socketPath, sessionName } = await createLeaseSession(runtimeId)
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)

    // Seed the headless claiming runtime BEFORE server start.
    await seedHeadlessClaimingRuntime(runtimeId, socketPath) // transport='headless', claimed

    // Grace=0 so any unclaimed lease WOULD be killed.
    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(serverFixture.serverOpts())
    liveServers.push(server)

    // Ph4: headless runtime with leased substrate claims the socket via
    // substrate-based claim detection → socket preserved.
    // AT HEAD: sweeper checks transport==='tmux' → headless not claimed → socket killed.
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)
  })
})

describe('Scenario 7: orphan sweeper still REAPS unclaimed/dead leased substrate', () => {
  beforeEach(async () => {
    serverFixture = await createHrcTestFixture('hrc-ph4-reap-')
    priorGrace = process.env[GRACE_ENV]
  })

  afterEach(async () => {
    for (const server of liveServers.splice(0)) {
      await server.stop()
    }
    for (const socketPath of leaseSockets.splice(0)) {
      try {
        const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'kill-server'], {
          stdout: 'ignore',
          stderr: 'ignore',
        })
        await exited
      } catch {}
    }
    if (priorGrace === undefined) {
      delete process.env[GRACE_ENV]
    } else {
      process.env[GRACE_ENV] = priorGrace
    }
    await serverFixture.cleanup()
  })

  function btmuxDir(): string {
    return join(serverFixture.runtimeRoot, 'btmux')
  }

  async function createUnclaimedLeaseSession(
    runtimeId: string
  ): Promise<{ socketPath: string; sessionName: string }> {
    await mkdir(btmuxDir(), { recursive: true })
    const socketPath = join(btmuxDir(), `cc-${runtimeId}.sock`)
    const sessionName = `hrc-cc-${runtimeId}`
    leaseSockets.push(socketPath)
    const { exited } = Bun.spawn(
      ['tmux', '-S', socketPath, 'new-session', '-d', '-s', sessionName, '-n', 'main'],
      { stdout: 'ignore', stderr: 'ignore' }
    )
    expect(await exited).toBe(0)
    return { socketPath, sessionName }
  }

  async function sessionAlive(socketPath: string, sessionName: string): Promise<boolean> {
    const mgr = createTmuxManager({ socketPath })
    return (await mgr.listSessionNames()).includes(sessionName)
  }

  it('unclaimed leased substrate (no matching runtime) is swept past grace', async () => {
    // Create a lease session with NO corresponding DB runtime.
    const { socketPath, sessionName } = await createUnclaimedLeaseSession('unclB')
    expect(await sessionAlive(socketPath, sessionName)).toBe(true)

    // Grace=0: unclaimed sessions past grace are killed.
    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(serverFixture.serverOpts())
    liveServers.push(server)

    // No runtime claims this socket → sweeper kills it (Ph4 doesn't change this).
    expect(await sessionAlive(socketPath, sessionName)).toBe(false)
  })

  it('dead lease socket file with no matching runtime is removed past grace', async () => {
    await mkdir(btmuxDir(), { recursive: true })
    const socketPath = join(btmuxDir(), 'cc-deadC.sock')
    // Write a fake socket file with no live tmux server.
    const f = Bun.file(socketPath)
    await Bun.write(f, '')
    expect(existsSync(socketPath)).toBe(true)

    process.env[GRACE_ENV] = '0'

    const server = await createHrcServer(serverFixture.serverOpts())
    liveServers.push(server)

    expect(existsSync(socketPath)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8 (G5): reattachDurableBrokerForDispatch reattaches a HEADLESS
// runtime (presentation.none) when broker socket is live.
//
// RED: At HEAD, reconcileDurableBrokerRuntimeReattach uses brokerLeaseWindowsMatch
// which requires tuiWindow for ALL leased substrates. Headless has no tuiWindow →
// brokerLeaseWindowsMatch returns false → reattachDurableBrokerForDispatch returns
// false. After Ph4: brokerLeaseIdentityMatches skips tuiWindow for presentation.none
// → identity check passes → returns true.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 8 (G5): reattachDurableBrokerForDispatch reattaches headless on broker_runtime_not_active', () => {
  it('returns true when broker socket is live and runtime has durable endpoint + leased substrate (presentation.none)', async () => {
    ph4.seedHeadlessDurableRuntime(db)

    const client = new ph4.MockDurableBrokerClient()
    const snap = ph4.emptySnapshot(ph4.HEADLESS_INVOCATION_ID, {
      currentSeq: 1,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.HEADLESS_RUNTIME_ID,
      ph4.HEADLESS_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.ready', 1, { state: 'ready' }),
      ],
      currentSeq: 1,
      retentionFloorSeq: 1,
    })

    const controller = makeController()
    const reattached = await reconcile.reattachDurableBrokerForDispatch(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller,
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.BROKER_WINDOW,
          tuiWindow: null, // presentation.none — no tuiWindow
        }),
      }
    )

    // Ph4: headless reattach returns true → dispatch retry can proceed.
    // AT HEAD: returns false (brokerLeaseWindowsMatch fails for presentation.none).
    expect(reattached.state).toBe('reattached')
    expect(client.calls).toContain('attach')
  })

  it('headless runtime has canUseDirectPaneFallback=false (no tmux pane for dispatch fallback)', () => {
    // Guard: this predicate must remain false for headless runtimes.
    // Ph4 must NOT wire direct-tmux-pane fallback for presentation.none dispatch.
    ph4.seedHeadlessDurableRuntime(db)
    expect(canUseDirectPaneFallback(readRuntime(ph4.HEADLESS_RUNTIME_ID))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 9 (G5/G4): reattachDurableBrokerForDispatch reports unavailable for
// headless when broker socket is dead (no direct tmux fallback available).
//
// At HEAD: already returns false (for wrong reason — window check fails).
// After Ph4: returns false for correct reason (socket unavailable, no pane fallback).
// This scenario verifies the correct failure mode, not just the return value.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 9 (G5/G4): headless dispatch: no direct tmux pane fallback when reattach fails', () => {
  it('reattachDurableBrokerForDispatch reports unavailable when broker socket is dead (presentation.none)', async () => {
    ph4.seedHeadlessDurableRuntime(db)

    let dialed = false
    const reattached = await reconcile.reattachDurableBrokerForDispatch(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => {
          dialed = true
          throw new Error('socket unavailable')
        },
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: false, // socket dead
          brokerWindow: null,
          tuiWindow: null,
        }),
      }
    )

    // Reattach must fail (no socket → no attach).
    expect(reattached.state).toBe('unavailable')
    // The unix factory must NOT be called when the socket probe returns dead.
    expect(dialed).toBe(false)

    // The predicate confirms no direct pane fallback is available.
    expect(canUseDirectPaneFallback(readRuntime(ph4.HEADLESS_RUNTIME_ID))).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 10 (G6): Active RUN activity is refreshed on successful broker.attach
// so a recovered in-flight run is NOT zombied by the zombie sweep.
//
// RED: At HEAD, reconcileDurableBrokerRuntimeReattach on success returns
// outcome={state:'broker-attached'} but does NOT update the active run's
// updatedAt. A subsequent zombie sweep with thresholdSeconds=0 kills the run.
// After Ph4: successful attach/replay refreshes run.updatedAt → zombie sweep
// leaves the run alive.
//
// Also covers: retention gap → broker_event_retention_gap emitted by
// attachAndReplay, NOT zombie.
// ─────────────────────────────────────────────────────────────────────────────
describe('Scenario 10 (G6): active RUN activity refreshed on broker.attach/replay', () => {
  it('run is NOT zombied after a successful broker.attach + replay (G6 activity refresh)', async () => {
    // Seed with an OLD run timestamp — zombie would kill it without activity refresh.
    ph4.seedHeadlessDurableRuntime(db, { runStatus: 'running', runUpdatedAt: ph4.oldTs() })

    const client = new ph4.MockDurableBrokerClient()
    const snap = ph4.emptySnapshot(ph4.HEADLESS_INVOCATION_ID, {
      currentSeq: 2,
      retentionFloorSeq: 1,
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.HEADLESS_RUNTIME_ID,
      ph4.HEADLESS_INVOCATION_ID,
      snap
    )
    client.queueEventsSince({
      events: [
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.started', 1, {
          pid: 1,
          command: 'claude',
          args: [],
          cwd: '/tmp',
        }),
        ph4.makeEnvelope(ph4.HEADLESS_INVOCATION_ID, 'invocation.ready', 2, { state: 'ready' }),
      ],
      currentSeq: 2,
      retentionFloorSeq: 1,
    })

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.BROKER_WINDOW,
          tuiWindow: null, // presentation.none
        }),
      }
    )

    // Reattach must succeed.
    expect(outcome.state).toBe('broker-attached')

    // G6: after attach/replay the active run's updatedAt must be refreshed so
    // the zombie sweep cannot kill it.
    const run = db.runs.getByRunId(ph4.HEADLESS_RUN_ID)
    expect(run).toBeDefined()

    // The run must NOT be in a terminal state (failed/zombie).
    expect(run?.status).not.toBe('zombie')
    expect(run?.status).not.toBe('failed')

    // Ph4: run activity timestamp must have been updated from ph4.oldTs() to now.
    // AT HEAD: run.updatedAt remains ph4.oldTs() → zombie sweep (below) kills it.
    // After Ph4: run.updatedAt is refreshed → zombie sweep skips it.
    //
    // Verify by running the zombie sweep with zero threshold.
    // The sweep targets headless runs older than threshold in ('accepted','started','running').
    const sweepResult = await fetch(
      `http+unix://${encodeURIComponent(serverFixture.socketPath)}/v1/runs/sweep-zombies`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ thresholdSeconds: 0 }),
      }
    ).catch(() => null)

    if (sweepResult?.ok) {
      // If we managed to reach the server, check the run isn't zombied.
      const runAfterSweep = db.runs.getByRunId(ph4.HEADLESS_RUN_ID)
      expect(runAfterSweep?.status).not.toBe('zombie')
    } else {
      // No server — verify directly that the run timestamp was refreshed.
      // At HEAD: run.updatedAt is still ph4.oldTs() → would be zombie-eligible.
      // After Ph4: run.updatedAt > ph4.oldTs().
      expect(run?.updatedAt).not.toBe(ph4.oldTs())
    }
  })

  it('retention gap on reattach → broker_replay_retention_gap emitted, NOT zombie (G6)', async () => {
    // Seeds headless runtime with a non-zero lastProjectedSeq to create a gap.
    ph4.seedHeadlessDurableRuntime(db, { runStatus: 'running', runUpdatedAt: ph4.oldTs() })

    const client = new ph4.MockDurableBrokerClient()
    // Create a retention gap: retentionFloorSeq=10 but lastProjectedSeq=0 → gap.
    const snap = ph4.emptySnapshot(ph4.HEADLESS_INVOCATION_ID, {
      currentSeq: 10,
      retentionFloorSeq: 10, // floor has advanced past last projected (0+1) → gap
    })
    client.snapshotResponse = snap
    client.attachResponse = ph4.attachResponseFor(
      ph4.HEADLESS_RUNTIME_ID,
      ph4.HEADLESS_INVOCATION_ID,
      snap
    )
    // eventsSince will not be called due to early gap detection in attachAndReplay.

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.HEADLESS_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerWindow: ph4.BROKER_WINDOW,
          tuiWindow: null,
        }),
      }
    )

    // Retention gap → reattach fails with a specific reason.
    // The reason must be broker_event_retention_gap (not zombie, not generic stale).
    expect(outcome.state).toBe('stale')
    expect(outcome.reason).toBe('broker_event_retention_gap')
    expect(outcome.brokerAttached).toBe(false)

    // The run must be explicitly failed (not left alive for zombie sweep).
    const run = db.runs.getByRunId(ph4.HEADLESS_RUN_ID)
    expect(run?.status).not.toBe('zombie')
    // Run is marked failed/unavailable due to retention gap.
    expect(run?.status).toMatch(/^(failed|stale)$/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// T-01996: single attach authority + broker.health drain handling
// ─────────────────────────────────────────────────────────────────────────────
describe('T-01996: classification-only pass (attach:false)', () => {
  it('returns broker-attachable WITHOUT attaching for a live, identity-valid durable runtime', async () => {
    ph4.seedInteractiveNormalizedRuntime(db)
    const client = new ph4.MockDurableBrokerClient()

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        attach: false,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        // Must NOT be consulted on the classification-only path.
        resolveAttachToken: async () => {
          throw new Error('resolveAttachToken must not run under attach:false')
        },
        probeBrokerLease: async () => ({
          brokerSocketLive: true,
          brokerHealth: 'ok',
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: ph4.TUI_WINDOW,
        }),
      }
    )

    expect(outcome.state).toBe('broker-attachable')
    expect(outcome.brokerAttached).toBe(false)
    // No attach+replay performed: the serving warm owns that.
    expect(client.calls).not.toContain('attach')
    // The runtime is left intact (not staled) for the serving warm to bind.
    expect(readRuntime(ph4.INTERACTIVE_RUNTIME_ID).status).not.toBe('stale')
  })
})

describe('T-01996: broker.health shutting_down is skipped, not staled', () => {
  it('returns broker-shutting-down and leaves the runtime intact', async () => {
    ph4.seedInteractiveNormalizedRuntime(db)
    const client = new ph4.MockDurableBrokerClient()

    const outcome = await reconcile.reconcileDurableBrokerRuntimeReattach(
      db,
      readRuntime(ph4.INTERACTIVE_RUNTIME_ID),
      {
        runtimeRoot: ph4.RUNTIME_ROOT,
        controller: makeController(),
        brokerUnixClientFactory: async () => client,
        resolveAttachToken: async () => ph4.ATTACH_TOKEN,
        probeBrokerLease: async () => ({
          brokerSocketLive: false,
          brokerHealth: 'shutting_down',
          brokerWindow: ph4.INTERACTIVE_BROKER_WINDOW,
          tuiWindow: ph4.TUI_WINDOW,
        }),
      }
    )

    expect(outcome.state).toBe('broker-shutting-down')
    expect(outcome.brokerAttached).toBe(false)
    expect(client.calls).not.toContain('attach')
    // A draining broker is not dead — the runtime must NOT be staled by the probe.
    expect(readRuntime(ph4.INTERACTIVE_RUNTIME_ID).status).not.toBe('stale')
  })
})
