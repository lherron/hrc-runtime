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
import { createHrcServer, createTmuxManager } from '../index'
import * as ph4 from './fixtures/broker-endpoint-substrate.fixture'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'

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
// Scenarios 6 & 7: Orphan sweeper with real tmux + createHrcServer
// ─────────────────────────────────────────────────────────────────────────────

const GRACE_ENV = 'HRC_BROKER_ORPHAN_SWEEP_GRACE_MS'

let serverFixture: HrcServerTestFixture
const liveServers: HrcServer[] = []
const leaseSockets: string[] = []
let priorGrace: string | undefined

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

void readRuntime
void makeController
