/**
 * RED → GREEN regression (T-01801): `reconcileTmuxRuntimeLiveness` must NOT tear
 * down a LIVE durable broker lease.
 *
 * A durable broker lease (T-01812) hosts TWO named windows under one tmux
 * session — 'broker' (the harness-broker IPC server) and 'tui' (the harness the
 * operator attaches to) — and has NO 'main' window. `reconcileTmuxRuntimeLiveness`
 * probed `<session>:main` via `inspectSession`, which returns null for that
 * topology, so a routine `hrc runtime list` declared the LIVE session "missing"
 * and `killServer`'d the lease socket out from under the running broker (SIGHUP) —
 * killing every durable interactive session within ~1-4s of start.
 *
 * This test seeds a live durable two-window lease whose 'tui' pane is alive (a
 * non-shell foreground) and runs the REAL `reconcileTmuxRuntimeLiveness`. It must
 * keep the runtime `ready`, leave the lease server alive, and NOT record a
 * `broker_tmux_session_missing` / `broker_tmux_harness_not_live` classification.
 *
 * RED at the pre-fix HEAD: inspectSession(`:main`) → null → markRuntimeStale
 * (`broker_tmux_session_missing`) + killServer. Run with TMPDIR=/tmp.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join } from 'node:path'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer, createTmuxManager } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

/** A server instance still carries the private reconcile method at runtime. */
type Reconcilable = HrcServer & {
  reconcileTmuxRuntimeLiveness(runtime: HrcRuntimeSnapshot): Promise<HrcRuntimeSnapshot>
}

let fixture: HrcServerTestFixture
const servers: HrcServer[] = []
const leaseSockets: string[] = []

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-durable-liveness-')
})

afterEach(async () => {
  for (const server of servers.splice(0)) {
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
      // fine when no server exists
    }
  }
  await fixture.cleanup()
})

async function spawnTmux(args: string[]): Promise<number> {
  const { exited } = Bun.spawn(['tmux', ...args], { stdout: 'ignore', stderr: 'ignore' })
  return exited
}

async function sessionExists(socketPath: string, sessionName: string): Promise<boolean> {
  const { exited } = Bun.spawn(['tmux', '-S', socketPath, 'has-session', '-t', `=${sessionName}`], {
    stdout: 'ignore',
    stderr: 'ignore',
  })
  return (await exited) === 0
}

function readStaleReasons(runtimeId: string): Array<string | undefined> {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listByKind('runtime.stale', { runtimeId })
      .map((event) => (event.payload as Record<string, unknown> | undefined)?.['reason'])
      .map((reason) => (typeof reason === 'string' ? reason : undefined))
  } finally {
    db.close()
  }
}

function readRuntime(runtimeId: string): HrcRuntimeSnapshot {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const runtime = db.runtimes.getByRuntimeId(runtimeId)
    if (!runtime) throw new Error(`runtime ${runtimeId} not found`)
    return runtime
  } finally {
    db.close()
  }
}

describe('RED (T-01801): reconcileTmuxRuntimeLiveness preserves a live durable broker+tui lease', () => {
  it('keeps a live durable broker+tui lease ready and does NOT kill it', async () => {
    const driver = 'claude-code-tmux'
    const tag = 'durable_live'
    const runtimeId = `runtime_${tag}`
    const hostSessionId = `hsid_${tag}`
    const operationId = `op_${tag}`
    const invocationId = `invocation_${tag}`
    const scopeRef = `agent:clod:project:hrc-runtime:task:${tag}`
    const sessionName = `hrc-${driver}-${runtimeId}`
    const leaseSocket = join(fixture.runtimeRoot, `lease-${tag}.sock`)
    leaseSockets.push(leaseSocket)

    // Durable topology: 'broker' + 'tui' windows, NO 'main'. Each pane runs a
    // non-shell foreground (`sleep`) so the 'tui' pane reads as a live harness.
    expect(
      await spawnTmux([
        '-S',
        leaseSocket,
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-n',
        'broker',
        'sleep 600',
      ])
    ).toBe(0)
    expect(
      await spawnTmux([
        '-S',
        leaseSocket,
        'new-window',
        '-d',
        '-t',
        `=${sessionName}:`,
        '-n',
        'tui',
        'sleep 600',
      ])
    ).toBe(0)

    const leaseMgr = createTmuxManager({ socketPath: leaseSocket })
    const tuiPane = await leaseMgr.inspectWindow({ sessionName, windowName: 'tui' })
    if (!tuiPane) throw new Error('failed to allocate durable tui pane fixture')

    // Boot the daemon FIRST (startup reconcile runs on empty state), then seed the
    // durable runtime pointing at the live 'tui' pane so this test isolates the
    // per-list `reconcileTmuxRuntimeLiveness` behavior.
    const server = (await createHrcServer(fixture.serverOpts())) as Reconcilable
    servers.push(server)

    const db = openHrcDatabase(fixture.dbPath)
    const now = fixture.now()
    try {
      db.sessions.insert({
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        ancestorScopeRefs: [],
      })
      db.runtimes.insert({
        runtimeId,
        hostSessionId,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        transport: 'tmux',
        harness: 'claude-code',
        provider: 'anthropic',
        status: 'ready',
        supportsInflightInput: true,
        adopted: false,
        controllerKind: 'harness-broker',
        activeOperationId: operationId,
        activeInvocationId: invocationId,
        tmuxJson: {
          socketPath: leaseSocket,
          sessionName,
          // The lease hands the operator the 'tui' window; the runtime records
          // that pane (NOT a 'main' window, which durable sessions do not have).
          windowName: 'tui',
          sessionId: tuiPane.sessionId,
          windowId: tuiPane.windowId,
          paneId: tuiPane.paneId,
          brokerDriver: driver,
        },
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      })
      db.brokerInvocations.insert({
        invocationId,
        operationId,
        runtimeId,
        brokerProtocol: 'harness-broker/0.2',
        brokerDriver: driver,
        invocationState: 'ready',
        capabilitiesJson: JSON.stringify({}),
        specHash: `sha256:spec-${tag}`,
        startRequestHash: `sha256:req-${tag}`,
        selectedProfileHash: `sha256:prof-${tag}`,
        createdAt: now,
        updatedAt: now,
      })
    } finally {
      db.close()
    }

    const result = await server.reconcileTmuxRuntimeLiveness(readRuntime(runtimeId))

    // (1) The live durable runtime stays usable — reconcile returns it unchanged.
    expect(result.status).toBe('ready')
    expect(readRuntime(runtimeId).status).toBe('ready')

    // (2) The lease tmux server was NOT torn down out from under the broker.
    expect(await sessionExists(leaseSocket, sessionName)).toBe(true)

    // (3) Reconciliation did NOT misclassify the live session as missing/dead.
    const staleReasons = readStaleReasons(runtimeId)
    expect(staleReasons).not.toContain('broker_tmux_session_missing')
    expect(staleReasons).not.toContain('broker_tmux_harness_not_live')
  })
})
